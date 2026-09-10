import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolvePluginStateRuntimeOptions } from "./plugin-state-runtime-options.js";

describe("resolvePluginStateRuntimeOptions", () => {
  it("resolves a SQL password at the async runtime boundary", async () => {
    const config = {
      storage: {
        backend: "azuresql",
        azureSql: {
          server: "sql.example.invalid",
          database: "openclaw",
          authentication: {
            mode: "sql-password",
            username: "openclaw",
            password: { source: "env", provider: "default", id: "AZURE_SQL_PASSWORD" },
          },
        },
      },
    } satisfies OpenClawConfig;

    await expect(
      resolvePluginStateRuntimeOptions(config, {
        AZURE_SQL_PASSWORD: "synthetic-password",
      }),
    ).resolves.toMatchObject({
      storage: config.storage,
      azureSqlPassword: { username: "openclaw", password: "synthetic-password" },
    });
  });

  it("retains a resolver for refreshable token credentials", async () => {
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

    const options = await resolvePluginStateRuntimeOptions(config, {
      AZURE_SQL_TOKEN: "synthetic-token",
    });

    await expect(
      options.azureSqlSecretResolver?.(config.storage.azureSql.credential),
    ).resolves.toBe("synthetic-token");
  });
});
