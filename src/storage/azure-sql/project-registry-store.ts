import { createHash, randomUUID } from "node:crypto";
import mssql from "mssql";
import { slugifyWorktreeTitle } from "../../agents/worktrees/name.js";
import type {
  ProjectCheckoutReferenceRemoval,
  ProjectRegistryInsert,
  ProjectRegistryLease,
  ProjectRegistryStore,
  StoredProjectRegistryRecord,
} from "../project-registry-store.js";
import { runAzureSqlMigrations } from "./migrations.js";
import { AzureSqlDatabase, type AzureSqlRequest, type AzureSqlTransaction } from "./runtime.js";

const PROJECTS_SCHEMA = "openclaw_global";
const PROJECTS_TABLE = `[${PROJECTS_SCHEMA}].[projects]`;
const PROJECT_LEASES_TABLE = `[${PROJECTS_SCHEMA}].[project_checkout_leases]`;
const PROJECT_CHECKOUT_LEASE_MS = 30_000;
const PROJECT_CHECKOUT_WAIT_MS = 30_000;
const PROJECT_CHECKOUT_RENEW_MS = 10_000;
const AZURE_SQL_NOW_MS =
  "DATEDIFF_BIG(MILLISECOND, CONVERT(datetime2, '1970-01-01'), SYSUTCDATETIME())";
const IDENTITY_COLLATION = "Latin1_General_100_BIN2";

// Immutable first migration retained so databases created by earlier builds can upgrade.
const PROJECTS_SCHEMA_V1_SQL = `
IF SCHEMA_ID(N'${PROJECTS_SCHEMA}') IS NULL
BEGIN
  EXEC(N'CREATE SCHEMA [${PROJECTS_SCHEMA}]');
END;
IF OBJECT_ID(N'${PROJECTS_TABLE}', N'U') IS NULL
BEGIN
  CREATE TABLE ${PROJECTS_TABLE} (
    id nvarchar(64) NOT NULL PRIMARY KEY,
    display_name nvarchar(512) NOT NULL,
    repo_root nvarchar(2048) NOT NULL,
    origin_url nvarchar(2048) NULL,
    source nvarchar(16) NOT NULL,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    CONSTRAINT CK_openclaw_projects_source CHECK (source IN (N'registered', N'cloned'))
  );
  CREATE INDEX IX_openclaw_projects_repo_root ON ${PROJECTS_TABLE}(repo_root);
  CREATE INDEX IX_openclaw_projects_origin_url ON ${PROJECTS_TABLE}(origin_url);
END;
IF OBJECT_ID(N'${PROJECT_LEASES_TABLE}', N'U') IS NULL
BEGIN
  CREATE TABLE ${PROJECT_LEASES_TABLE} (
    scope nvarchar(64) NOT NULL,
    lease_key nvarchar(2048) NOT NULL,
    owner_id nvarchar(64) NOT NULL,
    expires_at_ms bigint NOT NULL,
    PRIMARY KEY (scope, lease_key)
  );
END;
`;

const PROJECTS_SCHEMA_V2_SQL = `
CREATE TABLE [${PROJECTS_SCHEMA}].[projects_v2] (
  id nvarchar(64) COLLATE ${IDENTITY_COLLATION} NOT NULL PRIMARY KEY,
  display_name nvarchar(512) NOT NULL,
  repo_root nvarchar(2048) COLLATE ${IDENTITY_COLLATION} NOT NULL,
  repo_root_hash binary(32) NOT NULL,
  origin_url nvarchar(2048) COLLATE ${IDENTITY_COLLATION} NULL,
  origin_url_hash binary(32) NULL,
  source nvarchar(16) NOT NULL,
  created_at_ms bigint NOT NULL,
  updated_at_ms bigint NOT NULL,
  CONSTRAINT CK_openclaw_projects_source_v2 CHECK (source IN (N'registered', N'cloned'))
);
INSERT INTO [${PROJECTS_SCHEMA}].[projects_v2]
  (id, display_name, repo_root, repo_root_hash, origin_url, origin_url_hash,
   source, created_at_ms, updated_at_ms)
SELECT id, display_name, repo_root,
       HASHBYTES('SHA2_256', CONVERT(varbinary(max), repo_root)),
       origin_url,
       CASE WHEN origin_url IS NULL THEN NULL
            ELSE HASHBYTES('SHA2_256', CONVERT(varbinary(max), origin_url)) END,
       source, created_at_ms, updated_at_ms
FROM ${PROJECTS_TABLE};
DROP TABLE ${PROJECTS_TABLE};
EXEC sp_rename N'[${PROJECTS_SCHEMA}].[projects_v2]', N'projects', N'OBJECT';
CREATE INDEX IX_openclaw_projects_repo_root_hash ON ${PROJECTS_TABLE}(repo_root_hash);
CREATE INDEX IX_openclaw_projects_origin_url_hash ON ${PROJECTS_TABLE}(origin_url_hash);

CREATE TABLE [${PROJECTS_SCHEMA}].[project_checkout_leases_v2] (
  scope nvarchar(64) COLLATE ${IDENTITY_COLLATION} NOT NULL,
  lease_key nvarchar(2048) COLLATE ${IDENTITY_COLLATION} NOT NULL,
  lease_key_hash binary(32) NOT NULL,
  owner_id nvarchar(64) COLLATE ${IDENTITY_COLLATION} NOT NULL,
  expires_at_ms bigint NOT NULL,
  PRIMARY KEY (scope, lease_key_hash)
);
INSERT INTO [${PROJECTS_SCHEMA}].[project_checkout_leases_v2]
  (scope, lease_key, lease_key_hash, owner_id, expires_at_ms)
SELECT scope, lease_key, HASHBYTES('SHA2_256', CONVERT(varbinary(max), lease_key)),
       owner_id, expires_at_ms
FROM ${PROJECT_LEASES_TABLE};
DROP TABLE ${PROJECT_LEASES_TABLE};
EXEC sp_rename N'[${PROJECTS_SCHEMA}].[project_checkout_leases_v2]',
               N'project_checkout_leases', N'OBJECT';
`;

type AzureSqlProjectRow = {
  id: string;
  display_name: string;
  repo_root: string;
  origin_url: string | null;
  source: string;
};

function bindText(request: AzureSqlRequest, name: string, value: string, length: number): void {
  request.input(name, mssql.NVarChar(length), value);
}

function bindProjectKey(request: AzureSqlRequest, name: string, value: string): void {
  bindText(request, name, value, 2048);
}

function identityHash(value: string): Buffer {
  // SQL Server hashes nvarchar values as UTF-16LE bytes during the v2 backfill.
  return createHash("sha256").update(value, "utf16le").digest();
}

function bindIdentityHash(request: AzureSqlRequest, name: string, value: string): void {
  request.input(name, mssql.VarBinary(32), identityHash(value));
}

function rowToProject(row: AzureSqlProjectRow): StoredProjectRegistryRecord {
  if (row.source !== "registered" && row.source !== "cloned") {
    throw new Error(`Azure SQL project row has invalid source: ${row.source}`);
  }
  return {
    id: row.id,
    displayName: row.display_name,
    repoRoot: row.repo_root,
    ...(row.origin_url ? { originUrl: row.origin_url } : {}),
    source: row.source,
  };
}

function projectRow(result: {
  rows: AzureSqlProjectRow[];
}): StoredProjectRegistryRecord | undefined {
  const row = result.rows[0];
  return row ? rowToProject(row) : undefined;
}

function requireProjectRow(row: AzureSqlProjectRow | undefined): AzureSqlProjectRow {
  if (!row) {
    throw new Error("Azure SQL project row was unexpectedly missing");
  }
  return row;
}

function projectSelect(where: string): string {
  return `SELECT id, display_name, repo_root, origin_url, source FROM ${PROJECTS_TABLE} ${where}`;
}

function waitForProjectLease(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export type AzureSqlProjectDatabase = Pick<AzureSqlDatabase, "query" | "transaction">;

export class AzureSqlProjectRegistryStore implements ProjectRegistryStore {
  private schemaReady = false;

  constructor(private readonly database: AzureSqlProjectDatabase) {}

  async withCheckoutLease<T>(
    repoRoot: string,
    run: (lease: ProjectRegistryLease) => Promise<T>,
  ): Promise<T> {
    await this.ensureSchema();
    const ownerId = randomUUID();
    const deadline = performance.now() + PROJECT_CHECKOUT_WAIT_MS;
    let localMonotonicExpiry = 0;
    let localWallExpiry = 0;
    while (localMonotonicExpiry === 0) {
      const attemptStartedAt = performance.now();
      const attemptStartedWallAt = Date.now();
      const acquired = await this.tryAcquireCheckoutLease(repoRoot, ownerId);
      if (acquired) {
        // Both deadlines begin before the database computes its expiry. The wall deadline detects
        // process/VM suspension; the monotonic deadline remains safe across wall-clock correction.
        localMonotonicExpiry = attemptStartedAt + PROJECT_CHECKOUT_LEASE_MS;
        localWallExpiry = attemptStartedWallAt + PROJECT_CHECKOUT_LEASE_MS;
        break;
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        throw new Error(`project checkout lease timed out for ${repoRoot}`);
      }
      await waitForProjectLease(Math.min(100, remaining));
    }

    let lost: Error | undefined;
    let closed = false;
    let renewing = false;
    const markLost = (error: unknown) => {
      if (!lost) {
        lost = error instanceof Error ? error : new Error(String(error));
      }
    };
    const renew = async () => {
      if (closed || lost || renewing) {
        return;
      }
      renewing = true;
      const attemptStartedAt = performance.now();
      const attemptStartedWallAt = Date.now();
      try {
        const result = await this.database.transaction(
          async (transaction) =>
            await transaction.query(
              `
            UPDATE ${PROJECT_LEASES_TABLE}
            SET expires_at_ms = ${AZURE_SQL_NOW_MS} + ${PROJECT_CHECKOUT_LEASE_MS}
            WHERE scope = @scope AND lease_key_hash = @leaseKeyHash
              AND lease_key = @leaseKey AND owner_id = @ownerId
              AND expires_at_ms > ${AZURE_SQL_NOW_MS}
            `,
              (request) => {
                request.input("scope", mssql.NVarChar(64), "projects.checkout");
                bindIdentityHash(request, "leaseKeyHash", repoRoot);
                bindProjectKey(request, "leaseKey", repoRoot);
                bindText(request, "ownerId", ownerId, 64);
              },
            ),
        );
        if (result.rowsAffected[0] !== 1) {
          throw new Error(`project checkout lease was lost for ${repoRoot}`);
        }
        localMonotonicExpiry = attemptStartedAt + PROJECT_CHECKOUT_LEASE_MS;
        localWallExpiry = attemptStartedWallAt + PROJECT_CHECKOUT_LEASE_MS;
      } catch (error) {
        markLost(error);
      } finally {
        renewing = false;
      }
    };
    const timer = setInterval(() => void renew(), PROJECT_CHECKOUT_RENEW_MS);
    timer.unref?.();
    const lease: ProjectRegistryLease<AzureSqlTransaction> = {
      assertOwned: () => {
        if (lost || performance.now() >= localMonotonicExpiry || Date.now() >= localWallExpiry) {
          throw lost ?? new Error(`project checkout lease expired for ${repoRoot}`);
        }
      },
      assertOwnedInTransaction: async (transaction) => {
        lease.assertOwned();
        const result = await transaction.query<{ owner_id: string }>(
          `
          SELECT owner_id
          FROM ${PROJECT_LEASES_TABLE} WITH (UPDLOCK, HOLDLOCK)
          WHERE scope = @scope AND lease_key_hash = @leaseKeyHash
            AND lease_key = @leaseKey AND owner_id = @ownerId
            AND expires_at_ms > ${AZURE_SQL_NOW_MS}
          `,
          (request) => {
            request.input("scope", mssql.NVarChar(64), "projects.checkout");
            bindIdentityHash(request, "leaseKeyHash", repoRoot);
            bindProjectKey(request, "leaseKey", repoRoot);
            bindText(request, "ownerId", ownerId, 64);
          },
        );
        if (result.rows.length !== 1) {
          throw new Error(`project checkout lease was lost for ${repoRoot}`);
        }
      },
    };

    try {
      const result = await run(lease);
      lease.assertOwned();
      return result;
    } finally {
      closed = true;
      clearInterval(timer);
      await this.releaseCheckoutLease(repoRoot, ownerId);
    }
  }

  private async tryAcquireCheckoutLease(repoRoot: string, ownerId: string): Promise<boolean> {
    return await this.database.transaction(async (transaction) => {
      const current = await transaction.query<{ is_active: boolean }>(
        `
        SELECT CAST(CASE WHEN expires_at_ms > ${AZURE_SQL_NOW_MS} THEN 1 ELSE 0 END AS bit) AS is_active
        FROM ${PROJECT_LEASES_TABLE} WITH (UPDLOCK, HOLDLOCK)
        WHERE scope = @scope AND lease_key_hash = @leaseKeyHash AND lease_key = @leaseKey
        `,
        (request) => {
          request.input("scope", mssql.NVarChar(64), "projects.checkout");
          bindIdentityHash(request, "leaseKeyHash", repoRoot);
          bindProjectKey(request, "leaseKey", repoRoot);
        },
      );
      const existing = current.rows[0];
      if (existing?.is_active) {
        return false;
      }
      if (existing) {
        await transaction.query(
          `
          UPDATE ${PROJECT_LEASES_TABLE}
          SET owner_id = @ownerId,
              expires_at_ms = ${AZURE_SQL_NOW_MS} + ${PROJECT_CHECKOUT_LEASE_MS}
          WHERE scope = @scope AND lease_key_hash = @leaseKeyHash AND lease_key = @leaseKey
          `,
          (request) => {
            request.input("scope", mssql.NVarChar(64), "projects.checkout");
            bindIdentityHash(request, "leaseKeyHash", repoRoot);
            bindProjectKey(request, "leaseKey", repoRoot);
            bindText(request, "ownerId", ownerId, 64);
          },
        );
      } else {
        await transaction.query(
          `
          INSERT INTO ${PROJECT_LEASES_TABLE}
            (scope, lease_key, lease_key_hash, owner_id, expires_at_ms)
          VALUES
            (@scope, @leaseKey, @leaseKeyHash, @ownerId,
             ${AZURE_SQL_NOW_MS} + ${PROJECT_CHECKOUT_LEASE_MS})
          `,
          (request) => {
            request.input("scope", mssql.NVarChar(64), "projects.checkout");
            bindIdentityHash(request, "leaseKeyHash", repoRoot);
            bindProjectKey(request, "leaseKey", repoRoot);
            bindText(request, "ownerId", ownerId, 64);
          },
        );
      }
      return true;
    });
  }

  private async releaseCheckoutLease(repoRoot: string, ownerId: string): Promise<void> {
    try {
      await this.database.query(
        `DELETE FROM ${PROJECT_LEASES_TABLE}
         WHERE scope = @scope AND lease_key_hash = @leaseKeyHash
           AND lease_key = @leaseKey AND owner_id = @ownerId`,
        (request) => {
          request.input("scope", mssql.NVarChar(64), "projects.checkout");
          bindIdentityHash(request, "leaseKeyHash", repoRoot);
          bindProjectKey(request, "leaseKey", repoRoot);
          bindText(request, "ownerId", ownerId, 64);
        },
      );
    } catch {
      // Lease cleanup is best effort after the owner is closed; expiry remains the recovery path.
    }
  }

  private async ensureSchema(): Promise<void> {
    if (this.schemaReady) {
      return;
    }
    await runAzureSqlMigrations(this.database, [
      { id: "global.projects.v1", version: 1, sql: PROJECTS_SCHEMA_V1_SQL },
      { id: "global.projects.v2", version: 2, sql: PROJECTS_SCHEMA_V2_SQL },
    ]);
    this.schemaReady = true;
  }

  async list(): Promise<StoredProjectRegistryRecord[]> {
    await this.ensureSchema();
    const result = await this.database.query<AzureSqlProjectRow>(projectSelect("ORDER BY id ASC"));
    return result.rows.map(rowToProject);
  }

  async findById(id: string): Promise<StoredProjectRegistryRecord | undefined> {
    await this.ensureSchema();
    const result = await this.database.query<AzureSqlProjectRow>(
      projectSelect("WHERE id = @id"),
      (request) => bindText(request, "id", id, 64),
    );
    return projectRow(result);
  }

  async findByRepoRoot(repoRoot: string): Promise<StoredProjectRegistryRecord | undefined> {
    await this.ensureSchema();
    const result = await this.database.query<AzureSqlProjectRow>(
      projectSelect("WHERE repo_root_hash = @repoRootHash AND repo_root = @repoRoot"),
      (request) => {
        bindIdentityHash(request, "repoRootHash", repoRoot);
        bindProjectKey(request, "repoRoot", repoRoot);
      },
    );
    return projectRow(result);
  }

  async findByOriginUrl(originUrl: string): Promise<StoredProjectRegistryRecord | undefined> {
    await this.ensureSchema();
    const result = await this.database.query<AzureSqlProjectRow>(
      projectSelect("WHERE origin_url_hash = @originUrlHash AND origin_url = @originUrl"),
      (request) => {
        bindIdentityHash(request, "originUrlHash", originUrl);
        bindProjectKey(request, "originUrl", originUrl);
      },
    );
    return projectRow(result);
  }

  async insertOrGet(
    input: ProjectRegistryInsert,
    lease: ProjectRegistryLease,
  ): Promise<StoredProjectRegistryRecord> {
    await this.ensureSchema();
    return await this.database.transaction(async (transaction) => {
      await lease.assertOwnedInTransaction(transaction);
      const sameRoot = await transaction.query<AzureSqlProjectRow>(
        projectSelect(
          "WITH (UPDLOCK, HOLDLOCK) WHERE repo_root_hash = @repoRootHash AND repo_root = @repoRoot",
        ),
        (request) => {
          bindIdentityHash(request, "repoRootHash", input.repoRoot);
          bindProjectKey(request, "repoRoot", input.repoRoot);
        },
      );
      const existingRoot = projectRow(sameRoot);
      if (existingRoot) {
        return existingRoot;
      }
      if (input.source === "cloned" && input.originUrl) {
        const originUrl = input.originUrl;
        const duplicate = await transaction.query<AzureSqlProjectRow>(
          projectSelect(
            "WITH (UPDLOCK, HOLDLOCK) WHERE origin_url_hash = @originUrlHash AND origin_url = @originUrl",
          ),
          (request) => {
            bindIdentityHash(request, "originUrlHash", originUrl);
            bindProjectKey(request, "originUrl", originUrl);
          },
        );
        const existingOrigin = projectRow(duplicate);
        if (existingOrigin) {
          return existingOrigin;
        }
      }
      const existingIds = await transaction.query<{ id: string }>(
        `SELECT id FROM ${PROJECTS_TABLE} WITH (UPDLOCK, HOLDLOCK)`,
      );
      const ids = new Set(existingIds.rows.map((row) => row.id));
      const id = input.id ?? allocateProjectId(input.displayName, ids);
      if (!id || id.length > 64) {
        throw new Error("project registry id is invalid");
      }
      const now = Date.now();
      const result = await transaction.query<AzureSqlProjectRow>(
        `
        INSERT INTO ${PROJECTS_TABLE}
          (id, display_name, repo_root, repo_root_hash, origin_url, origin_url_hash,
           source, created_at_ms, updated_at_ms)
        OUTPUT INSERTED.id, INSERTED.display_name, INSERTED.repo_root,
               INSERTED.origin_url, INSERTED.source
        VALUES (@id, @displayName, @repoRoot, @repoRootHash, @originUrl, @originUrlHash,
                @source, @createdAtMs, @updatedAtMs)
        `,
        (request) => {
          bindText(request, "id", id, 64);
          bindText(request, "displayName", input.displayName, 512);
          bindProjectKey(request, "repoRoot", input.repoRoot);
          bindIdentityHash(request, "repoRootHash", input.repoRoot);
          request.input("originUrl", mssql.NVarChar(2048), input.originUrl ?? null);
          request.input(
            "originUrlHash",
            mssql.VarBinary(32),
            input.originUrl ? identityHash(input.originUrl) : null,
          );
          bindText(request, "source", input.source, 16);
          request.input("createdAtMs", mssql.BigInt(), now);
          request.input("updatedAtMs", mssql.BigInt(), now);
        },
      );
      return rowToProject(requireProjectRow(result.rows[0]));
    });
  }

  async removeCheckoutReference(
    project: StoredProjectRegistryRecord,
    lease: ProjectRegistryLease,
  ): Promise<ProjectCheckoutReferenceRemoval> {
    await this.ensureSchema();
    return await this.database.transaction(async (transaction) => {
      await lease.assertOwnedInTransaction(transaction);
      const currentResult = await transaction.query<AzureSqlProjectRow>(
        projectSelect("WITH (UPDLOCK, HOLDLOCK) WHERE id = @id"),
        (request) => bindText(request, "id", project.id, 64),
      );
      const current = projectRow(currentResult);
      if (!current) {
        return "missing";
      }
      if (current.source !== "cloned" || current.repoRoot !== project.repoRoot) {
        return "changed";
      }
      await transaction.query(`DELETE FROM ${PROJECTS_TABLE} WHERE id = @id`, (request) =>
        bindText(request, "id", project.id, 64),
      );
      const siblingResult = await transaction.query<AzureSqlProjectRow>(
        projectSelect(
          "WITH (UPDLOCK, HOLDLOCK) WHERE repo_root_hash = @repoRootHash AND repo_root = @repoRoot ORDER BY id ASC",
        ),
        (request) => {
          bindIdentityHash(request, "repoRootHash", project.repoRoot);
          bindProjectKey(request, "repoRoot", project.repoRoot);
        },
      );
      const sibling = projectRow(siblingResult);
      if (!sibling) {
        return "final";
      }
      if (sibling.source === "registered") {
        await transaction.query(
          `
          UPDATE ${PROJECTS_TABLE}
          SET source = N'cloned', origin_url = COALESCE(origin_url, @originUrl), updated_at_ms = @updatedAtMs
          WHERE id = @id
          `,
          (request) => {
            bindText(request, "id", sibling.id, 64);
            request.input("originUrl", mssql.NVarChar(2048), current.originUrl ?? null);
            request.input("updatedAtMs", mssql.BigInt(), Date.now());
          },
        );
      }
      return "remaining";
    });
  }

  async remove(id: string): Promise<boolean> {
    await this.ensureSchema();
    const result = await this.database.query(
      `DELETE FROM ${PROJECTS_TABLE} WHERE id = @id`,
      (request) => bindText(request, "id", id, 64),
    );
    return result.rowsAffected[0] === 1;
  }
}

function allocateProjectId(displayName: string, existing: ReadonlySet<string>): string {
  const base = slugifyWorktreeTitle(displayName) ?? "project";
  if (!existing.has(base)) {
    return base;
  }
  for (let suffixNumber = 2; ; suffixNumber += 1) {
    const suffix = `-${suffixNumber}`;
    const candidate = `${base.slice(0, 64 - suffix.length).replace(/-+$/u, "")}${suffix}`;
    if (!existing.has(candidate)) {
      return candidate;
    }
  }
}
