import { afterEach, describe, expect, it } from "vitest";
import { AzureSqlProjectRegistryStore } from "./azure-sql/project-registry-store.js";
import {
  createProjectRegistryStore,
  closeProjectRegistryAzureSqlDatabases,
} from "./project-registry-store-factory.js";

afterEach(async () => {
  await closeProjectRegistryAzureSqlDatabases();
});

describe("createProjectRegistryStore", () => {
  it("keeps SQLite as the default backend", () => {
    const store = createProjectRegistryStore();
    expect(store).not.toBeInstanceOf(AzureSqlProjectRegistryStore);
  });

  it("selects and reuses Azure SQL only for explicit complete configuration", () => {
    const options = {
      storage: {
        backend: "azuresql" as const,
        azureSql: {
          server: "sql.example.invalid",
          database: "openclaw",
        },
      },
    };
    const store = createProjectRegistryStore(options);
    expect(store).toBeInstanceOf(AzureSqlProjectRegistryStore);
    expect(createProjectRegistryStore(options)).toBe(store);
  });

  it("replaces the cached SQL-password store when the resolved password rotates", () => {
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
    const first = createProjectRegistryStore({
      storage,
      azureSqlPassword: { username: "openclaw", password: "first-password" },
    });
    const rotated = createProjectRegistryStore({
      storage,
      azureSqlPassword: { username: "openclaw", password: "rotated-password" },
    });

    expect(rotated).not.toBe(first);
  });

  it("rejects unresolved configured credentials before opening a pool", () => {
    expect(() =>
      createProjectRegistryStore({
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
