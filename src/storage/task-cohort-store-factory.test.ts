import { afterEach, describe, expect, it } from "vitest";
import type { AzureSqlTokenCredential } from "./azure-sql/runtime.js";
import { AzureSqlTaskCohortStore } from "./azure-sql/task-cohort-store.js";
import {
  closeTaskCohortAzureSqlDatabases,
  createAzureSqlTaskCohortStore,
} from "./task-cohort-store-factory.js";

afterEach(async () => {
  await closeTaskCohortAzureSqlDatabases();
});

describe("createAzureSqlTaskCohortStore", () => {
  const storage = {
    backend: "azuresql" as const,
    azureSql: { server: "sql.example.invalid", database: "openclaw" },
  };

  it("reuses one pooled store only for the same resolved connection identity", () => {
    const first = createAzureSqlTaskCohortStore({ storage });
    expect(first).toBeInstanceOf(AzureSqlTaskCohortStore);
    expect(createAzureSqlTaskCohortStore({ storage })).toBe(first);
  });

  it("does not alias distinct injected credential identities", () => {
    const credential = (): AzureSqlTokenCredential => ({
      getToken: async () => ({ token: "synthetic", expiresOnTimestamp: Date.now() + 60_000 }),
    });
    const firstCredential = credential();
    const first = createAzureSqlTaskCohortStore({ storage, azureSqlCredential: firstCredential });

    expect(createAzureSqlTaskCohortStore({ storage, azureSqlCredential: firstCredential })).toBe(
      first,
    );
    expect(createAzureSqlTaskCohortStore({ storage, azureSqlCredential: credential() })).not.toBe(
      first,
    );
  });

  it("changes stores when a resolved SQL password rotates", () => {
    const passwordStorage = {
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
    const first = createAzureSqlTaskCohortStore({
      storage: passwordStorage,
      azureSqlPassword: { username: "openclaw", password: "first-password" },
    });
    const rotated = createAzureSqlTaskCohortStore({
      storage: passwordStorage,
      azureSqlPassword: { username: "openclaw", password: "rotated-password" },
    });

    expect(rotated).not.toBe(first);
  });

  it("retires cached stores when the factory lifecycle closes", async () => {
    const store = createAzureSqlTaskCohortStore({ storage });

    await closeTaskCohortAzureSqlDatabases();

    await expect(store.inspectReadOnly()).rejects.toThrow("closed");
    expect(createAzureSqlTaskCohortStore({ storage })).not.toBe(store);
  });

  it("rejects unresolved configured credentials", () => {
    expect(() =>
      createAzureSqlTaskCohortStore({
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
