import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSecretRefString } from "../secrets/resolve.js";
import type { ProjectRegistryStoreOptions } from "./project-registry-store-factory.js";

const processRuntimeOptions = new WeakMap<OpenClawConfig, Promise<ProjectRegistryStoreOptions>>();

export function resolveProjectRegistryRuntimeOptions(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProjectRegistryStoreOptions> {
  if (env !== process.env) {
    return materializeProjectRegistryRuntimeOptions(config, env);
  }
  const existing = processRuntimeOptions.get(config);
  if (existing) {
    return existing;
  }
  const resolved = materializeProjectRegistryRuntimeOptions(config, env);
  processRuntimeOptions.set(config, resolved);
  void resolved.catch(() => processRuntimeOptions.delete(config));
  return resolved;
}

async function materializeProjectRegistryRuntimeOptions(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): Promise<ProjectRegistryStoreOptions> {
  const storage = config.storage;
  if (!storage) {
    return {};
  }
  const authentication = storage.azureSql?.authentication;
  const azureSqlSecretResolver = async (ref: Parameters<typeof resolveSecretRefString>[0]) =>
    await resolveSecretRefString(ref, { config, env });
  if (authentication?.mode !== "sql-password") {
    return storage.azureSql?.credential ? { storage, azureSqlSecretResolver } : { storage };
  }
  const password = await azureSqlSecretResolver(authentication.password);
  return {
    storage,
    azureSqlSecretResolver,
    azureSqlPassword: { username: authentication.username, password },
  };
}
