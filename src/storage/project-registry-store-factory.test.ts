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

  it("selects Azure SQL only for explicit complete configuration", () => {
    const store = createProjectRegistryStore({
      storage: {
        backend: "azuresql",
        azureSql: {
          server: "sql.example.invalid",
          database: "openclaw",
        },
      },
    });
    expect(store).toBeInstanceOf(AzureSqlProjectRegistryStore);
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
