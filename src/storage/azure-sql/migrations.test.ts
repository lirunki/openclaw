import { describe, expect, it } from "vitest";
import { runAzureSqlMigrations } from "./migrations.js";
import type {
  AzureSqlDatabase,
  AzureSqlRequest,
  AzureSqlResult,
  AzureSqlTransaction,
} from "./runtime.js";

function fakeResult<Row>(
  rows: readonly unknown[] = [],
  rowsAffected: readonly number[] = [],
): AzureSqlResult<Row> {
  // SAFETY: each fake SQL branch supplies the row shape requested by its generic query.
  return { rows: rows as Row[], rowsAffected };
}

class FakeMigrationDatabase {
  readonly applied = new Map<string, { version: number; checksum_sha256: string }>();
  readonly executedSql: string[] = [];
  commits = 0;
  rollbacks = 0;

  async transaction<T>(operation: (transaction: AzureSqlTransaction) => Promise<T>): Promise<T> {
    const transaction: AzureSqlTransaction = {
      query: async <Row>(text: string, bind?: (request: AzureSqlRequest) => void) => {
        const request = new FakeRequest();
        bind?.(request);
        this.executedSql.push(text);
        if (text.includes("SELECT migration_id")) {
          return fakeResult<Row>(
            [...this.applied].map(([migration_id, value]) =>
              Object.assign({ migration_id }, value),
            ),
          );
        }
        if (text.includes("INSERT INTO") && text.includes("storage_migrations")) {
          this.applied.set(String(request.values.get("migrationId")), {
            version: Number(request.values.get("version")),
            checksum_sha256: String(request.values.get("checksum")),
          });
        }
        return fakeResult<Row>();
      },
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
}

class FakeRequest implements AzureSqlRequest {
  readonly values = new Map<string, unknown>();

  input(name: string, _type: unknown, value?: unknown): AzureSqlRequest {
    this.values.set(name, value === undefined ? _type : value);
    return this;
  }

  async query<Row>(): Promise<AzureSqlResult<Row>> {
    throw new Error("FakeRequest.query is not used by migration tests");
  }

  cancel(): void {}
}

describe("runAzureSqlMigrations", () => {
  it("applies migrations once and recognizes the same checksums on retry", async () => {
    const database = new FakeMigrationDatabase();
    const migrations = [
      { id: "global.projects.v1", version: 1, sql: "CREATE TABLE projects_v1 (id int);" },
      {
        id: "global.projects.v2",
        version: 2,
        sql: "ALTER TABLE projects_v1 ADD name nvarchar(64);",
      },
    ];

    await expect(
      runAzureSqlMigrations(database as unknown as AzureSqlDatabase, migrations, () => 123),
    ).resolves.toEqual({
      applied: ["global.projects.v1", "global.projects.v2"],
      alreadyApplied: [],
    });
    await expect(
      runAzureSqlMigrations(database as unknown as AzureSqlDatabase, migrations, () => 456),
    ).resolves.toEqual({
      applied: [],
      alreadyApplied: ["global.projects.v1", "global.projects.v2"],
    });
    expect(database.commits).toBe(2);
    expect(database.rollbacks).toBe(0);
    expect(database.executedSql[0]).toContain("sp_getapplock");
    expect(database.executedSql[1]).toContain("CREATE SCHEMA");
  });

  it("rejects migrations recorded by a newer build", async () => {
    const database = new FakeMigrationDatabase();
    database.applied.set("global.projects.v2", {
      version: 2,
      checksum_sha256: "newer-checksum",
    });

    await expect(
      runAzureSqlMigrations(database as unknown as AzureSqlDatabase, [
        { id: "global.projects.v1", version: 1, sql: "CREATE TABLE projects_v1 (id int);" },
      ]),
    ).rejects.toThrow("newer than this build");
    expect(database.rollbacks).toBe(1);
  });

  it("rejects migration checksum drift", async () => {
    const database = new FakeMigrationDatabase();
    const first = {
      id: "global.projects.v1",
      version: 1,
      sql: "CREATE TABLE projects_v1 (id int);",
    };
    await runAzureSqlMigrations(database as unknown as AzureSqlDatabase, [first], () => 123);

    await expect(
      runAzureSqlMigrations(
        database as unknown as AzureSqlDatabase,
        [{ ...first, sql: "CREATE TABLE projects_v1 (id bigint);" }],
        () => 123,
      ),
    ).rejects.toThrow("migration drift");
    expect(database.rollbacks).toBe(1);
  });
});
