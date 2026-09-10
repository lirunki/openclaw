import { ok } from "@openclaw/normalization-core/result";
import { afterEach, describe, expect, it, vi } from "vitest";

const backend = vi.hoisted(() => {
  const values = new Map<string, string>();
  return {
    values,
    store: {
      async register(_scope: unknown, input: { key: string; valueJson: string }) {
        values.set(input.key, input.valueJson);
      },
      async registerIfAbsent(_scope: unknown, input: { key: string; valueJson: string }) {
        if (values.has(input.key)) {
          return false;
        }
        values.set(input.key, input.valueJson);
        return true;
      },
      async update(
        _scope: unknown,
        key: string,
        update: (value: unknown) => { valueJson: string } | undefined,
      ) {
        const raw = values.get(key);
        const current = raw === undefined ? undefined : JSON.parse(raw);
        const next = update(current);
        if (!next) {
          return false;
        }
        values.set(key, next.valueJson);
        return true;
      },
      async deleteIf(_scope: unknown, key: string, predicate: (value: unknown) => boolean) {
        const raw = values.get(key);
        if (raw === undefined || !predicate(JSON.parse(raw))) {
          return false;
        }
        return values.delete(key);
      },
      async lookup(_scope: unknown, key: string) {
        const raw = values.get(key);
        return raw === undefined ? undefined : JSON.parse(raw);
      },
      async lookupMany(_scope: unknown, keys: readonly string[]) {
        return keys.map((key) => {
          const raw = values.get(key);
          return ok(raw === undefined ? undefined : JSON.parse(raw));
        });
      },
      async consume(_scope: unknown, key: string) {
        const raw = values.get(key);
        const value = raw === undefined ? undefined : JSON.parse(raw);
        values.delete(key);
        return value;
      },
      async delete(_scope: unknown, key: string) {
        return values.delete(key);
      },
      async entries() {
        return [...values].map(([key, valueJson], createdAt) => ({
          key,
          value: JSON.parse(valueJson),
          createdAt,
        }));
      },
      async clear() {
        values.clear();
      },
      async deleteEntriesIfUnchanged(
        _scope: unknown,
        entries: ReadonlyArray<{ key: string; valueJson: string }>,
        assertCurrent: () => void,
      ) {
        assertCurrent();
        let deleted = 0;
        for (const entry of entries) {
          assertCurrent();
          if (values.get(entry.key) === entry.valueJson) {
            values.delete(entry.key);
            deleted += 1;
          }
        }
        return { deleted, changed: entries.length - deleted };
      },
    },
  };
});

vi.mock("../storage/plugin-state-store-factory.js", () => ({
  createAzureSqlPluginStateStore: () => backend.store,
}));
vi.mock("../storage/plugin-state-runtime-options.js", () => ({
  resolvePluginStateRuntimeOptions: async (config: { storage: unknown }) => ({
    storage: config.storage,
  }),
}));

import {
  createPluginStateKeyedStoreForRuntime,
  pluginStateDeleteEntriesIfUnchangedAsync,
  resetPluginStateStoreForTests,
} from "./plugin-state-store.js";

const runtimeContext = {
  config: {
    storage: {
      backend: "azuresql" as const,
      azureSql: { server: "sql.example.invalid", database: "openclaw" },
    },
  },
};

afterEach(() => {
  backend.values.clear();
  resetPluginStateStoreForTests({ closeDatabase: false });
});

describe("Azure SQL plugin-state routing", () => {
  it("routes Doctor conditional deletion through the Azure adapter", async () => {
    backend.values.set("unchanged", '{"generation":1}');
    backend.values.set("changed", '{"generation":2}');
    let authorityChecks = 0;

    await expect(
      pluginStateDeleteEntriesIfUnchangedAsync(
        {
          pluginId: "discord",
          namespace: "bindings",
          entries: [
            {
              key: "unchanged",
              valueJson: '{"generation":1}',
              value: { generation: 1 },
              createdAt: 1,
              expiresAt: null,
            },
            {
              key: "changed",
              valueJson: '{"generation":1}',
              value: { generation: 1 },
              createdAt: 1,
              expiresAt: null,
            },
          ],
          assertCurrent: () => {
            authorityChecks += 1;
          },
          assertOwnedInTransaction: () => {
            throw new Error("Azure repair must not use a SQLite transaction assertion");
          },
        },
        runtimeContext.config,
      ),
    ).resolves.toEqual({ deleted: 1, changed: 1 });

    expect(authorityChecks).toBe(3);
    expect(backend.values.has("unchanged")).toBe(false);
    expect(backend.values.has("changed")).toBe(true);
  });

  it("routes the async keyed-store contract through the Azure adapter", async () => {
    const store = createPluginStateKeyedStoreForRuntime<{ count: number }>(
      "discord",
      { namespace: "bindings", maxEntries: 10, overflowPolicy: "reject-new" },
      runtimeContext.config,
    );

    await expect(store.registerIfAbsent("thread", { count: 1 })).resolves.toBe(true);
    await expect(store.registerIfAbsent("thread", { count: 2 })).resolves.toBe(false);
    await expect(
      store.update("thread", (current) => ({ count: (current?.count ?? 0) + 1 })),
    ).resolves.toBe(true);
    await expect(store.lookup("thread")).resolves.toEqual({ count: 2 });
    await expect(store.lookupMany(["thread", "missing"])).resolves.toEqual([
      ok({ count: 2 }),
      ok(undefined),
    ]);
    await expect(store.deleteIf("thread", (current) => current.count === 2)).resolves.toBe(true);
  });
});
