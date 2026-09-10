import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AzureSqlPluginStateRawEntry } from "../storage/azure-sql/plugin-state-store.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";

const azure = vi.hoisted(() => {
  const entries = new Map<string, AzureSqlPluginStateRawEntry>();
  const inputs: Array<{ key: string; createdAtMs?: number; expiresAtMs?: number | null }> = [];
  return {
    entries,
    inputs,
    store: {
      async importIfAbsent(
        scope: { pluginId: string; namespace: string },
        input: {
          key: string;
          valueJson: string;
          createdAtMs?: number;
          expiresAtMs?: number | null;
        },
      ) {
        inputs.push(input);
        const identity = `${scope.pluginId}/${scope.namespace}/${input.key}`;
        const existing = entries.get(identity);
        if (existing) {
          return { status: "existing" as const, entry: existing };
        }
        entries.set(identity, {
          key: input.key,
          valueJson: input.valueJson,
          createdAt: input.createdAtMs ?? 0,
          expiresAt: input.expiresAtMs ?? null,
        });
        return { status: "inserted" as const };
      },
    },
  };
});

vi.mock("../storage/plugin-state-runtime-options.js", () => ({
  resolvePluginStateRuntimeOptions: async (config: { storage: unknown }) => ({
    storage: config.storage,
  }),
}));
vi.mock("../storage/plugin-state-store-factory.js", () => ({
  createAzureSqlPluginStateStore: () => azure.store,
}));

import { migrateLegacyPluginStateSidecar } from "./state-migrations.plugin-state.js";
import { resolveLegacyPluginStateSidecarPath } from "./state-migrations.storage.js";

function writeLegacySidecar(
  sourcePath: string,
  rows: ReadonlyArray<{
    pluginId: string;
    namespace: string;
    key: string;
    valueJson: string;
    createdAt: number;
    expiresAt: number | null;
  }>,
): void {
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  const database = new DatabaseSync(sourcePath);
  try {
    database.exec(`
      CREATE TABLE plugin_state_entries (
        plugin_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        entry_key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER
      )
    `);
    const insert = database.prepare("INSERT INTO plugin_state_entries VALUES (?, ?, ?, ?, ?, ?)");
    for (const row of rows) {
      insert.run(row.pluginId, row.namespace, row.key, row.valueJson, row.createdAt, row.expiresAt);
    }
  } finally {
    database.close();
  }
}

const azureConfig = {
  storage: {
    backend: "azuresql" as const,
    azureSql: { server: "sql.example.invalid", database: "openclaw" },
  },
};

describe("legacy plugin-state sidecar migration to Azure SQL", () => {
  beforeEach(() => {
    azure.entries.clear();
    azure.inputs.length = 0;
  });

  it("preserves exact timestamps, retains conflicts, and archives after a safe retry", async () => {
    await withOpenClawTestState(
      { label: "plugin-state-sidecar-azure", applyEnv: false },
      async ({ stateDir, env }) => {
        const sourcePath = resolveLegacyPluginStateSidecarPath(stateDir);
        const futureExpiry = Date.now() + 60_000;
        writeLegacySidecar(sourcePath, [
          {
            pluginId: "fixture",
            namespace: "cache",
            key: "inserted",
            valueJson: '{"source":true}',
            createdAt: 10,
            expiresAt: futureExpiry,
          },
          {
            pluginId: "fixture",
            namespace: "cache",
            key: "conflict",
            valueJson: '{"source":true}',
            createdAt: 20,
            expiresAt: null,
          },
          {
            pluginId: "fixture",
            namespace: "cache",
            key: "expired",
            valueJson: "true",
            createdAt: 1,
            expiresAt: 2,
          },
        ]);
        azure.entries.set("fixture/cache/conflict", {
          key: "conflict",
          valueJson: '{"canonical":true}',
          createdAt: 20,
          expiresAt: null,
        });

        const first = await migrateLegacyPluginStateSidecar({
          stateDir,
          config: azureConfig,
          env,
        });

        expect(first.changes).toContainEqual(
          expect.stringContaining("1 plugin-state sidecar entry"),
        );
        expect(first.warnings).toContainEqual(
          expect.stringContaining("row differs from Azure SQL"),
        );
        expect(fs.existsSync(sourcePath)).toBe(true);
        expect(azure.inputs.find((entry) => entry.key === "inserted")).toMatchObject({
          createdAtMs: 10,
          expiresAtMs: futureExpiry,
        });
        expect(azure.inputs.some((entry) => entry.key === "expired")).toBe(false);

        azure.entries.set("fixture/cache/conflict", {
          key: "conflict",
          valueJson: '{"canonical":"newer"}',
          createdAt: 21,
          expiresAt: null,
        });
        const retried = await migrateLegacyPluginStateSidecar({
          stateDir,
          config: azureConfig,
          env,
        });

        expect(retried.warnings).toEqual([]);
        expect(retried.changes).toContainEqual(expect.stringContaining("1 expired"));
        expect(retried.changes).toContainEqual(expect.stringContaining("Archived plugin-state"));
        expect(fs.existsSync(sourcePath)).toBe(false);
        expect(fs.existsSync(`${sourcePath}.migrated`)).toBe(true);
      },
    );
  });
});
