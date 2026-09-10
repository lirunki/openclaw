import { afterEach, describe, expect, it } from "vitest";
import { AzureSqlPluginStateStore } from "./azure-sql/plugin-state-store.js";
import {
  closePluginStateAzureSqlDatabases,
  createAzureSqlPluginStateStore,
} from "./plugin-state-store-factory.js";

afterEach(async () => {
  await closePluginStateAzureSqlDatabases();
});

describe("createAzureSqlPluginStateStore", () => {
  it("reuses one store for the same resolved connection identity", () => {
    const options = {
      storage: {
        backend: "azuresql" as const,
        azureSql: { server: "sql.example.invalid", database: "openclaw" },
      },
    };

    const first = createAzureSqlPluginStateStore(options);
    expect(first).toBeInstanceOf(AzureSqlPluginStateStore);
    expect(createAzureSqlPluginStateStore(options)).toBe(first);
  });

  it("changes stores when a resolved SQL password rotates", () => {
    const storage = {
      backend: "azuresql" as const,
      azureSql: {
        server: "sql.example.invalid",
        database: "openclaw",
        authentication: {
          mode: "sql-password" as const,
          username: "openclaw",
          password: { source: "env" as const, provider: "default", id: "AZURE_SQL_PASSWORD" },
        },
      },
    };

    const first = createAzureSqlPluginStateStore({
      storage,
      azureSqlPassword: { username: "openclaw", password: "first-password" },
    });
    const rotated = createAzureSqlPluginStateStore({
      storage,
      azureSqlPassword: { username: "openclaw", password: "rotated-password" },
    });

    expect(rotated).not.toBe(first);
  });

  it("rejects unresolved configured credentials", () => {
    expect(() =>
      createAzureSqlPluginStateStore({
        storage: {
          backend: "azuresql",
          azureSql: {
            server: "sql.example.invalid",
            database: "openclaw",
            credential: { source: "env", provider: "default", id: "AZURE_SQL_TOKEN" },
          },
        },
      }),
    ).toThrow("has not been resolved");
  });
});
