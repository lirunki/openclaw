import type { DatabaseSync } from "node:sqlite";
import type { Kysely, Selectable } from "kysely";
import { slugifyWorktreeTitle } from "../../agents/worktrees/name.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import { withOpenClawStateLease } from "../../state/openclaw-state-lease.js";
import type {
  ProjectCheckoutReferenceRemoval,
  ProjectRegistryInsert,
  ProjectRegistryLease,
  ProjectRegistryStore,
  StoredProjectRegistryRecord,
} from "../project-registry-store.js";

const PROJECT_ID_MAX_LENGTH = 64;
const PROJECTS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT NOT NULL PRIMARY KEY,
  display_name TEXT NOT NULL,
  repo_root TEXT NOT NULL,
  origin_url TEXT,
  source TEXT NOT NULL CHECK (source IN ('registered', 'cloned')),
  created_at_ms INT NOT NULL,
  updated_at_ms INT NOT NULL
) STRICT;
`;

type ProjectsDatabase = Pick<OpenClawStateKyselyDatabase, "projects">;
type ProjectRow = Selectable<OpenClawStateKyselyDatabase["projects"]>;

const ensuredDatabases = new WeakSet<DatabaseSync>();
const PROJECT_CHECKOUT_LEASE_MS = 30_000;
const PROJECT_CHECKOUT_WAIT_MS = 30_000;

function storedProjectSource(value: string): StoredProjectRegistryRecord["source"] {
  if (value !== "registered" && value !== "cloned") {
    throw new Error(`project registry row has invalid source: ${value}`);
  }
  return value;
}

function rowToProject(row: ProjectRow): StoredProjectRegistryRecord {
  return {
    id: row.id,
    displayName: row.display_name,
    repoRoot: row.repo_root,
    ...(row.origin_url ? { originUrl: row.origin_url } : {}),
    source: storedProjectSource(row.source),
  };
}

function allocateProjectId(base: string, existing: ReadonlySet<string>): string {
  if (!existing.has(base)) {
    return base;
  }
  for (let suffixNumber = 2; ; suffixNumber += 1) {
    const suffix = `-${suffixNumber}`;
    const candidate = `${base.slice(0, PROJECT_ID_MAX_LENGTH - suffix.length).replace(/-+$/u, "")}${suffix}`;
    if (!existing.has(candidate)) {
      return candidate;
    }
  }
}

function ensureProjectRegistrySchema(options: OpenClawStateDatabaseOptions): void {
  const database = openOpenClawStateDatabase(options);
  if (ensuredDatabases.has(database.db)) {
    return;
  }
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      // sqlite-allow-raw -- backend-local additive schema DDL; project rows use Kysely below.
      db.exec(PROJECTS_SCHEMA_SQL);
    },
    options,
    { operationLabel: "projects.registry.schema.ensure" },
  );
  ensuredDatabases.add(database.db);
}

function openProjectDatabase(options: OpenClawStateDatabaseOptions): {
  sqlite: DatabaseSync;
  kysely: Kysely<ProjectsDatabase>;
} {
  ensureProjectRegistrySchema(options);
  const state = openOpenClawStateDatabase(options);
  return { sqlite: state.db, kysely: getNodeSqliteKysely<ProjectsDatabase>(state.db) };
}

// The SQLite backend runs project lease assertions inside synchronous write
// transactions. The shared ProjectRegistryLease contract permits async
// assertions for the Azure SQL backend, so reject any floating Promise here
// rather than letting an async assertion escape the transaction unawaited.
function assertProjectLeaseOwnedInTransaction(
  lease: ProjectRegistryLease,
  database: DatabaseSync,
): void {
  const assertion = lease.assertOwnedInTransaction(database);
  if (assertion instanceof Promise) {
    throw new Error("SQLite project checkout lease assertion must be synchronous");
  }
}

export function createSqliteProjectRegistryStore(
  options: OpenClawStateDatabaseOptions = {},
): ProjectRegistryStore {
  return {
    async withCheckoutLease(repoRoot, run) {
      return await withOpenClawStateLease(
        {
          scope: "projects.checkout",
          key: repoRoot,
          database: { scope: "shared", options },
          leaseMs: PROJECT_CHECKOUT_LEASE_MS,
          waitMs: PROJECT_CHECKOUT_WAIT_MS,
          leaseLabel: "project checkout lease",
          operationLabel: "projects.checkout.lease",
        },
        async (lease) => {
          const projectLease: ProjectRegistryLease<DatabaseSync> = {
            assertOwned: () => lease.assertOwned(),
            assertOwnedInTransaction: (transaction) => lease.assertOwnedInTransaction(transaction),
          };
          return await run(projectLease);
        },
      );
    },

    async list() {
      const { sqlite, kysely } = openProjectDatabase(options);
      return executeSqliteQuerySync(sqlite, kysely.selectFrom("projects").selectAll()).rows.map(
        rowToProject,
      );
    },

    async findById(id) {
      const { sqlite, kysely } = openProjectDatabase(options);
      const row = executeSqliteQueryTakeFirstSync(
        sqlite,
        kysely.selectFrom("projects").selectAll().where("id", "=", id),
      );
      return row ? rowToProject(row) : undefined;
    },

    async findByRepoRoot(repoRoot) {
      const { sqlite, kysely } = openProjectDatabase(options);
      const row = executeSqliteQueryTakeFirstSync(
        sqlite,
        kysely.selectFrom("projects").selectAll().where("repo_root", "=", repoRoot),
      );
      return row ? rowToProject(row) : undefined;
    },

    async findByOriginUrl(originUrl) {
      const { sqlite, kysely } = openProjectDatabase(options);
      const row = executeSqliteQueryTakeFirstSync(
        sqlite,
        kysely.selectFrom("projects").selectAll().where("origin_url", "=", originUrl),
      );
      return row ? rowToProject(row) : undefined;
    },

    async insertOrGet(input: ProjectRegistryInsert, lease: ProjectRegistryLease) {
      return runOpenClawStateWriteTransaction(
        ({ db: sqlite }) => {
          assertProjectLeaseOwnedInTransaction(lease, sqlite);
          const db = getNodeSqliteKysely<ProjectsDatabase>(sqlite);
          const sameRoot = executeSqliteQueryTakeFirstSync(
            sqlite,
            db.selectFrom("projects").selectAll().where("repo_root", "=", input.repoRoot),
          );
          if (sameRoot) {
            return rowToProject(sameRoot);
          }
          if (input.source === "cloned" && input.originUrl) {
            const duplicate = executeSqliteQueryTakeFirstSync(
              sqlite,
              db.selectFrom("projects").selectAll().where("origin_url", "=", input.originUrl),
            );
            if (duplicate) {
              return rowToProject(duplicate);
            }
          }
          const existing = new Set(
            executeSqliteQuerySync(sqlite, db.selectFrom("projects").select("id")).rows.map(
              (row) => row.id,
            ),
          );
          const baseId = slugifyWorktreeTitle(input.displayName) ?? "project";
          const id = input.id ?? allocateProjectId(baseId, existing);
          if (!id || id.length > PROJECT_ID_MAX_LENGTH) {
            throw new Error("project registry id is invalid");
          }
          const now = Date.now();
          const row = {
            id,
            display_name: input.displayName,
            repo_root: input.repoRoot,
            origin_url: input.originUrl ?? null,
            source: input.source,
            created_at_ms: now,
            updated_at_ms: now,
          };
          executeSqliteQuerySync(sqlite, db.insertInto("projects").values(row));
          return rowToProject(row);
        },
        options,
        { operationLabel: "projects.registry.insert" },
      );
    },

    async removeCheckoutReference(project, lease): Promise<ProjectCheckoutReferenceRemoval> {
      return runOpenClawStateWriteTransaction(
        ({ db: sqlite }) => {
          assertProjectLeaseOwnedInTransaction(lease, sqlite);
          const kysely = getNodeSqliteKysely<ProjectsDatabase>(sqlite);
          const current = executeSqliteQueryTakeFirstSync(
            sqlite,
            kysely.selectFrom("projects").selectAll().where("id", "=", project.id),
          );
          if (!current) {
            return "missing";
          }
          if (current.source !== "cloned" || current.repo_root !== project.repoRoot) {
            return "changed";
          }
          executeSqliteQuerySync(
            sqlite,
            kysely.deleteFrom("projects").where("id", "=", project.id),
          );
          const sibling = executeSqliteQueryTakeFirstSync(
            sqlite,
            kysely
              .selectFrom("projects")
              .selectAll()
              .where("repo_root", "=", project.repoRoot)
              .orderBy("id", "asc"),
          );
          if (!sibling) {
            return "final";
          }
          if (sibling.source === "registered") {
            executeSqliteQuerySync(
              sqlite,
              kysely
                .updateTable("projects")
                .set({
                  source: "cloned",
                  origin_url: sibling.origin_url ?? current.origin_url,
                  updated_at_ms: Date.now(),
                })
                .where("id", "=", sibling.id),
            );
          }
          return "remaining";
        },
        options,
        { operationLabel: "projects.registry.checkout-reference.remove" },
      );
    },

    async remove(id) {
      openProjectDatabase(options);
      return runOpenClawStateWriteTransaction(
        ({ db }) => {
          const kysely = getNodeSqliteKysely<ProjectsDatabase>(db);
          return (
            executeSqliteQuerySync(db, kysely.deleteFrom("projects").where("id", "=", id))
              .numAffectedRows === 1n
          );
        },
        options,
        { operationLabel: "projects.registry.remove" },
      );
    },
  };
}
