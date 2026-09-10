import { describe, expect, it } from "vitest";
import { AzureSqlPluginStateStore, type AzureSqlPluginStateScope } from "./plugin-state-store.js";
import type {
  AzureSqlDatabase,
  AzureSqlRequest,
  AzureSqlResult,
  AzureSqlTransaction,
} from "./runtime.js";

function result<Row>(rows: readonly Row[] = [], rowsAffected: readonly number[] = []) {
  return { rows: [...rows], rowsAffected } satisfies AzureSqlResult<Row>;
}

class FakeRequest implements AzureSqlRequest {
  readonly values = new Map<string, unknown>();

  input(name: string, valueOrType: unknown, value?: unknown): AzureSqlRequest {
    this.values.set(name, value === undefined ? valueOrType : value);
    return this;
  }

  async query<Row>(): Promise<AzureSqlResult<Row>> {
    throw new Error("FakeRequest.query is not used");
  }

  cancel(): void {}
}

class FakePluginStateDatabase {
  readonly sql: string[] = [];
  handler: (text: string, values: ReadonlyMap<string, unknown>) => AzureSqlResult<unknown> = () =>
    result();

  async query<Row>(
    text: string,
    bind?: (request: AzureSqlRequest) => void,
  ): Promise<AzureSqlResult<Row>> {
    return this.execute(text, bind) as AzureSqlResult<Row>;
  }

  async transaction<T>(operation: (transaction: AzureSqlTransaction) => Promise<T>): Promise<T> {
    return await operation({
      query: async <Row>(text: string, bind?: (request: AzureSqlRequest) => void) =>
        this.execute(text, bind) as AzureSqlResult<Row>,
    });
  }

  private execute(text: string, bind?: (request: AzureSqlRequest) => void) {
    const request = new FakeRequest();
    bind?.(request);
    this.sql.push(text);
    if (text.includes("SELECT migration_id")) {
      return result();
    }
    return this.handler(text, request.values);
  }
}

const scope: AzureSqlPluginStateScope = {
  pluginId: "discord",
  namespace: "bindings",
  maxEntries: 100,
  overflowPolicy: "reject-new",
};

function createStore(database: FakePluginStateDatabase) {
  return new AzureSqlPluginStateStore(database as unknown as AzureSqlDatabase);
}

describe("AzureSqlPluginStateStore", () => {
  it("reads live JSON state with stable metadata", async () => {
    const database = new FakePluginStateDatabase();
    database.handler = (sql) =>
      sql.includes("FROM [openclaw_global].[plugin_state_entries]") &&
      sql.includes("entry_key = @entryKey")
        ? result([
            {
              entry_key: "thread:1",
              value_json: '{"session":"main"}',
              created_at_ms: "42",
              expires_at_ms: null,
            },
          ])
        : result();

    await expect(createStore(database).lookup(scope, "thread:1")).resolves.toEqual({
      session: "main",
    });
    expect(database.sql.some((sql) => sql.includes("expires_at_ms >"))).toBe(true);
  });

  it("keeps lookupMany corruption isolated to the affected key", async () => {
    const database = new FakePluginStateDatabase();
    database.handler = (sql) =>
      sql.includes("OPENJSON(@keys)")
        ? result([
            {
              entry_key: "good",
              value_json: '{"ok":true}',
              created_at_ms: 1,
              expires_at_ms: null,
            },
            {
              entry_key: "bad",
              value_json: "{",
              created_at_ms: 2,
              expires_at_ms: null,
            },
          ])
        : result();

    const values = await createStore(database).lookupMany(scope, ["missing", "bad", "good"]);

    expect(values[0]).toEqual({ ok: true, value: undefined });
    expect(values[1]?.ok).toBe(false);
    expect(values[1]?.ok === false ? values[1].error.code : undefined).toBe("PLUGIN_STATE_CORRUPT");
    expect(values[2]).toEqual({ ok: true, value: { ok: true } });
    expect(database.sql.find((sql) => sql.includes("OPENJSON(@keys)"))).toContain(
      "COLLATE Latin1_General_100_BIN2",
    );
  });

  it("deletes only unchanged Doctor rows after revalidating repair authority", async () => {
    const database = new FakePluginStateDatabase();
    database.handler = (sql, values) => {
      if (sql.includes("SELECT entry_key") && sql.includes("UPDLOCK")) {
        const key = values.get("entryKey");
        return result([
          {
            entry_key: key,
            value_json: key === "changed" ? '{"generation":2}' : '{"generation":1}',
            created_at_ms: key === "changed" ? 20 : 10,
            expires_at_ms: null,
          },
        ]);
      }
      if (sql.includes("DELETE FROM [openclaw_global].[plugin_state_entries]")) {
        return result([], [1]);
      }
      return result();
    };
    const assertions: string[] = [];
    const expected = (key: string) => ({
      key,
      valueJson: '{"generation":1}',
      createdAt: 10,
      expiresAt: null,
    });

    await expect(
      createStore(database).deleteEntriesIfUnchanged(
        scope,
        [expected("unchanged"), expected("changed")],
        () => assertions.push(database.sql.at(-1) ?? ""),
      ),
    ).resolves.toEqual({ deleted: 1, changed: 1 });

    expect(assertions).toHaveLength(5);
    expect(assertions[0]).toContain("sp_getapplock");
    expect(
      database.sql.filter((sql) => sql.includes("DELETE FROM") && sql.includes("entry_key_hash =")),
    ).toHaveLength(1);
  });

  it("does not delete after Doctor repair authority expires during comparison", async () => {
    const database = new FakePluginStateDatabase();
    database.handler = (sql) =>
      sql.includes("SELECT entry_key") && sql.includes("UPDLOCK")
        ? result([
            {
              entry_key: "binding",
              value_json: '{"generation":1}',
              created_at_ms: 10,
              expires_at_ms: null,
            },
          ])
        : result();
    let assertions = 0;

    await expect(
      createStore(database).deleteEntriesIfUnchanged(
        scope,
        [
          {
            key: "binding",
            valueJson: '{"generation":1}',
            createdAt: 10,
            expiresAt: null,
          },
        ],
        () => {
          assertions += 1;
          if (assertions === 2) {
            throw new Error("repair authority expired");
          }
        },
      ),
    ).rejects.toThrow("Failed to delete plugin state entries during Doctor repair");

    expect(
      database.sql.some((sql) => sql.includes("DELETE FROM") && sql.includes("entry_key_hash =")),
    ).toBe(false);
  });

  it("revalidates Doctor repair authority after an awaited delete", async () => {
    const database = new FakePluginStateDatabase();
    database.handler = (sql) =>
      sql.includes("SELECT entry_key") && sql.includes("UPDLOCK")
        ? result([
            {
              entry_key: "binding",
              value_json: '{"generation":1}',
              created_at_ms: 10,
              expires_at_ms: null,
            },
          ])
        : result([], [1]);
    let assertions = 0;

    await expect(
      createStore(database).deleteEntriesIfUnchanged(
        scope,
        [
          {
            key: "binding",
            valueJson: '{"generation":1}',
            createdAt: 10,
            expiresAt: null,
          },
        ],
        () => {
          assertions += 1;
          if (assertions === 3) {
            throw new Error("repair authority expired after delete");
          }
        },
      ),
    ).rejects.toThrow("Failed to delete plugin state entries during Doctor repair");

    expect(
      database.sql.some((sql) => sql.includes("DELETE FROM") && sql.includes("entry_key_hash =")),
    ).toBe(true);
  });

  it("preserves an absolute expiry when importing a missing legacy row", async () => {
    const database = new FakePluginStateDatabase();
    let insertedValues: ReadonlyMap<string, unknown> | undefined;
    database.handler = (sql, values) => {
      if (sql.includes("SELECT entry_key") && sql.includes("UPDLOCK")) {
        return result();
      }
      if (sql.includes("INSERT INTO [openclaw_global].[plugin_state_entries]")) {
        insertedValues = values;
      }
      if (sql.includes("COUNT_BIG")) {
        return result([{ entry_count: 0 }]);
      }
      return result([], [1]);
    };

    await expect(
      createStore(database).importIfAbsent(scope, {
        key: "legacy",
        valueJson: '{"source":true}',
        createdAtMs: 42,
        expiresAtMs: 123_456,
      }),
    ).resolves.toEqual({ status: "inserted" });

    expect(insertedValues?.get("createdAtMs")).toBe(42);
    expect(insertedValues?.get("expiresAtMs")).toBe(123_456);
    expect(insertedValues?.get("hasAbsoluteExpiry")).toBe(true);
  });

  it("updates under one locked transaction and preserves the namespace policy", async () => {
    const database = new FakePluginStateDatabase();
    const counts = [1, 1];
    database.handler = (sql) => {
      if (sql.includes("SELECT entry_key") && sql.includes("UPDLOCK")) {
        return result([
          {
            entry_key: "cursor",
            value_json: '{"value":1}',
            created_at_ms: 10,
            expires_at_ms: null,
          },
        ]);
      }
      if (sql.includes("COUNT_BIG")) {
        return result([{ entry_count: counts.shift() ?? 1 }]);
      }
      return result([], [1]);
    };

    await expect(
      createStore(database).update(scope, "cursor", (current) => ({
        valueJson: JSON.stringify({ value: (current as { value: number }).value + 1 }),
      })),
    ).resolves.toBe(true);

    expect(database.sql.some((sql) => sql.includes("WITH (UPDLOCK, HOLDLOCK)"))).toBe(true);
    expect(database.sql.some((sql) => sql.includes("SET value_json = @valueJson"))).toBe(true);
  });
});
