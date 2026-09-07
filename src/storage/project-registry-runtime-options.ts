import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { coerceSecretRef } from "../config/types.secrets.js";
import { resolveSecretRefString } from "../secrets/resolve.js";
import type { ProjectRegistryStoreOptions } from "./project-registry-store-factory.js";

export async function resolveProjectRegistryRuntimeOptions(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProjectRegistryStoreOptions> {
  const storage = config.storage;
  const authentication = storage?.azureSql?.authentication;
  if (!storage || authentication?.mode !== "sql-password") {
    return storage ? { storage } : {};
  }
  const inlinePassword = normalizeOptionalString(authentication.password);
  const password = inlinePassword ?? (await resolveConfiguredPassword(config, env));
  return {
    storage,
    azureSqlPassword: { username: authentication.username, password },
  };
}

async function resolveConfiguredPassword(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const authentication = config.storage?.azureSql?.authentication;
  if (authentication?.mode !== "sql-password") {
    throw new Error("Azure SQL password authentication is not configured");
  }
  const ref = coerceSecretRef(authentication.password);
  if (!ref) {
    throw new Error("Azure SQL password is missing or invalid");
  }
  return await resolveSecretRefString(ref, { config, env });
}
