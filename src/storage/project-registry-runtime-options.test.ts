import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveProjectRegistryRuntimeOptions } from "./project-registry-runtime-options.js";

describe("resolveProjectRegistryRuntimeOptions", () => {
  it("keeps SQLite as the implicit default", async () => {
    await expect(resolveProjectRegistryRuntimeOptions({})).resolves.toEqual({});
  });

  it("reuses process runtime options for the same immutable config snapshot", async () => {
    const config = { storage: { backend: "sqlite" as const } };
    const first = resolveProjectRegistryRuntimeOptions(config);
    const second = resolveProjectRegistryRuntimeOptions(config);

    expect(second).toBe(first);
    await expect(first).resolves.toEqual({ storage: config.storage });
  });

  it("resolves a SQL password SecretRef at the runtime boundary", async () => {
    const config = {
      storage: {
        backend: "azuresql",
        azureSql: {
          server: "sql.example.invalid",
          database: "openclaw",
          authentication: {
            mode: "sql-password",
            username: "openclaw_experiment",
            password: { source: "env", provider: "default", id: "AZURE_SQL_PASSWORD" },
          },
        },
      },
    } satisfies OpenClawConfig;

    const result = await resolveProjectRegistryRuntimeOptions(config, {
      AZURE_SQL_PASSWORD: "synthetic-password",
    });
    expect(result).toMatchObject({
      storage: config.storage,
      azureSqlPassword: {
        username: "openclaw_experiment",
        password: "synthetic-password",
      },
    });
    expect(result.azureSqlSecretResolver).toEqual(expect.any(Function));
  });

  it("wires a token SecretRef into the refreshable credential resolver", async () => {
    const config = {
      storage: {
        backend: "azuresql",
        azureSql: {
          server: "sql.example.invalid",
          database: "openclaw",
          credential: { source: "env", provider: "default", id: "AZURE_SQL_TOKEN" },
        },
      },
    } satisfies OpenClawConfig;

    const result = await resolveProjectRegistryRuntimeOptions(config, {
      AZURE_SQL_TOKEN: "synthetic-token",
    });
    await expect(result.azureSqlSecretResolver?.(config.storage.azureSql.credential)).resolves.toBe(
      "synthetic-token",
    );
  });
});
