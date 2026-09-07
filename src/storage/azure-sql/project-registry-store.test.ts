import { describe, expect, it } from "vitest";
import { AzureSqlProjectRegistryStore } from "./project-registry-store.js";
import type { AzureSqlRequest, AzureSqlResult, AzureSqlTransaction } from "./runtime.js";

function fakeResult<Row>(
  rows: readonly unknown[] = [],
  rowsAffected: readonly number[] = [],
): AzureSqlResult<Row> {
  // SAFETY: each fake SQL branch supplies the row shape requested by its generic query.
  return { rows: rows as Row[], rowsAffected };
}

type FakeProjectRow = {
  id: string;
  display_name: string;
  repo_root: string;
  origin_url: string | null;
  source: "registered" | "cloned";
};

class FakeRequest implements AzureSqlRequest {
  readonly values = new Map<string, unknown>();

  input(name: string, valueOrType: unknown, value?: unknown): AzureSqlRequest {
    this.values.set(name, value === undefined ? valueOrType : value);
    return this;
  }

  async query<Row>(): Promise<AzureSqlResult<Row>> {
    throw new Error("FakeRequest.query must be replaced by FakeProjectDatabase");
  }

  cancel(): void {}
}

class FakeProjectDatabase {
  readonly rows: FakeProjectRow[] = [];
  leaseOwner: string | undefined;
  leaseExpiresAtMs = 0;
  schemaEnsures = 0;
  commits = 0;
  rollbacks = 0;

  async query<Row>(
    text: string,
    bind?: (request: AzureSqlRequest) => void,
  ): Promise<AzureSqlResult<Row>> {
    return await this.execute<Row>(text, bind);
  }

  async transaction<T>(operation: (transaction: AzureSqlTransaction) => Promise<T>): Promise<T> {
    const transaction: AzureSqlTransaction = {
      query: async <Row>(text: string, bind?: (request: AzureSqlRequest) => void) =>
        await this.execute<Row>(text, bind),
    };
    try {
      const result = await operation(transaction);
      this.commits += 1;
      return result;
    } catch (error) {
      this.rollbacks += 1;
      throw error;
    }
  }

  private async execute<Row>(
    text: string,
    bind?: (request: AzureSqlRequest) => void,
  ): Promise<AzureSqlResult<Row>> {
    const request = new FakeRequest();
    bind?.(request);
    if (text.includes("project_checkout_leases") && !text.includes("CREATE TABLE")) {
      if (text.includes("SELECT owner_id")) {
        const ownerId = String(request.values.get("ownerId"));
        const valid = this.leaseOwner === ownerId && this.leaseExpiresAtMs > Date.now();
        return fakeResult<Row>(
          valid ? [{ owner_id: ownerId, expires_at_ms: this.leaseExpiresAtMs }] : [],
        );
      }
      if (text.includes("SELECT owner_id, expires_at_ms")) {
        return fakeResult<Row>(
          this.leaseOwner
            ? [{ owner_id: this.leaseOwner, expires_at_ms: this.leaseExpiresAtMs }]
            : [],
        );
      }
      if (text.includes("INSERT INTO")) {
        this.leaseOwner = String(request.values.get("ownerId"));
        this.leaseExpiresAtMs = Number(request.values.get("expiresAtMs"));
        return fakeResult<Row>([], [1]);
      }
      if (text.includes("UPDATE")) {
        this.leaseOwner = String(request.values.get("ownerId"));
        this.leaseExpiresAtMs = Number(request.values.get("expiresAtMs"));
        return fakeResult<Row>([], [1]);
      }
      if (text.includes("DELETE FROM")) {
        this.leaseOwner = undefined;
        this.leaseExpiresAtMs = 0;
        return fakeResult<Row>([], [1]);
      }
      return fakeResult<Row>();
    }
    if (text.includes("storage_migrations") && text.includes("CREATE TABLE")) {
      return fakeResult<Row>();
    }
    if (text.includes("CREATE TABLE") && text.includes("projects")) {
      this.schemaEnsures += 1;
      return fakeResult<Row>();
    }
    if (text.includes("sp_getapplock")) {
      return fakeResult<Row>();
    }
    if (text.includes("SELECT migration_id")) {
      return fakeResult<Row>();
    }
    if (text.includes("INSERT INTO") && text.includes("storage_migrations")) {
      return fakeResult<Row>([], [1]);
    }
    if (text.includes("SELECT id FROM")) {
      return fakeResult<Row>(this.rows.map(({ id }) => ({ id })));
    }
    if (text.includes("INSERT INTO")) {
      const row: FakeProjectRow = {
        id: String(request.values.get("id")),
        display_name: String(request.values.get("displayName")),
        repo_root: String(request.values.get("repoRoot")),
        origin_url: (request.values.get("originUrl") as string | null) ?? null,
        source: request.values.get("source") as FakeProjectRow["source"],
      };
      this.rows.push(row);
      return fakeResult<Row>([row], [1]);
    }
    if (text.includes("DELETE FROM")) {
      const id = String(request.values.get("id"));
      const before = this.rows.length;
      this.rows.splice(0, this.rows.length, ...this.rows.filter((row) => row.id !== id));
      return fakeResult<Row>([], [before === this.rows.length ? 0 : 1]);
    }
    if (text.includes("UPDATE") && text.includes("source =")) {
      const id = String(request.values.get("id"));
      const row = this.rows.find((candidate) => candidate.id === id);
      if (row) {
        row.source = "cloned";
        row.origin_url = (request.values.get("originUrl") as string | null) ?? row.origin_url;
      }
      return fakeResult<Row>([], [row ? 1 : 0]);
    }
    if (text.includes("WHERE id = @id")) {
      const id = String(request.values.get("id"));
      return fakeResult<Row>(this.rows.filter((row) => row.id === id));
    }
    if (text.includes("WHERE repo_root = @repoRoot")) {
      const repoRoot = String(request.values.get("repoRoot"));
      return fakeResult<Row>(this.rows.filter((row) => row.repo_root === repoRoot));
    }
    if (text.includes("WHERE origin_url = @originUrl")) {
      const originUrl = String(request.values.get("originUrl"));
      return fakeResult<Row>(this.rows.filter((row) => row.origin_url === originUrl));
    }
    if (text.includes("ORDER BY id ASC")) {
      return fakeResult<Row>(this.rows.toSorted((a, b) => a.id.localeCompare(b.id)));
    }
    throw new Error(`unexpected fake Azure SQL query: ${text}`);
  }
}

const lease = {
  assertOwned: () => {},
  assertOwnedInTransaction: (transaction: unknown) => {
    expect(transaction).toBeDefined();
  },
};

describe("AzureSqlProjectRegistryStore", () => {
  it("preserves project rows through the backend contract", async () => {
    const database = new FakeProjectDatabase();
    const store = new AzureSqlProjectRegistryStore(database);

    const first = await store.insertOrGet(
      {
        displayName: "OpenClaw",
        repoRoot: "/workspace/openclaw",
        source: "registered",
      },
      lease,
    );
    const duplicate = await store.insertOrGet(
      {
        displayName: "Different name",
        repoRoot: "/workspace/openclaw",
        source: "registered",
      },
      lease,
    );

    expect(first).toEqual(duplicate);
    expect(await store.findById(first.id)).toEqual(first);
    expect(await store.list()).toEqual([first]);
    expect(database.commits).toBe(3);
    expect(database.schemaEnsures).toBe(1);
  });

  it("runs the Azure checkout lease lifecycle on the same backend", async () => {
    const database = new FakeProjectDatabase();
    const store = new AzureSqlProjectRegistryStore(database);

    await expect(
      store.withCheckoutLease("/workspace/openclaw", async (checkoutLease) => {
        checkoutLease.assertOwned();
        return "leased";
      }),
    ).resolves.toBe("leased");
    expect(database.leaseOwner).toBeUndefined();
    expect(database.rollbacks).toBe(0);
  });

  it("removes the final checkout reference transactionally", async () => {
    const database = new FakeProjectDatabase();
    const store = new AzureSqlProjectRegistryStore(database);
    const project = await store.insertOrGet(
      {
        displayName: "OpenClaw",
        repoRoot: "/workspace/openclaw",
        source: "cloned",
      },
      lease,
    );

    expect(project).toMatchObject({ repoRoot: "/workspace/openclaw", source: "cloned" });
    expect(database.rows).toEqual([
      {
        id: project.id,
        display_name: "OpenClaw",
        repo_root: "/workspace/openclaw",
        origin_url: null,
        source: "cloned",
      },
    ]);
    await expect(store.findById(project.id)).resolves.toEqual(project);
    await expect(store.removeCheckoutReference(project, lease)).resolves.toBe("final");
    await expect(store.findById(project.id)).resolves.toBeUndefined();
    expect(database.rollbacks).toBe(0);
  });
});
