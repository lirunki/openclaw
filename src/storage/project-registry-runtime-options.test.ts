import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveProjectRegistryRuntimeOptions } from "./project-registry-runtime-options.js";

describe("resolveProjectRegistryRuntimeOptions", () => {
  it("keeps SQLite as the implicit default", async () => {
    await expect(resolveProjectRegistryRuntimeOptions({})).resolves.toEqual({});
  });

  it("materializes an already-resolved SQL password without persisting another copy", async () => {
    const config = {
      storage: {
        backend: "azuresql",
        azureSql: {
          server: "sql.example.invalid",
          database: "openclaw",
          authentication: {
            mode: "sql-password",
            username: "openclaw_experiment",
            password: "synthetic-password",
          },
        },
      },
    } satisfies OpenClawConfig;

    await expect(resolveProjectRegistryRuntimeOptions(config)).resolves.toEqual({
      storage: config.storage,
      azureSqlPassword: {
        username: "openclaw_experiment",
        password: "synthetic-password",
      },
    });
  });
});
