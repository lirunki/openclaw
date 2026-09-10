import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSecretRefString } from "../secrets/resolve.js";
import type { PluginStateStoreFactoryOptions } from "./plugin-state-store-factory.js";

const processRuntimeOptions = new WeakMap<
  OpenClawConfig,
  Promise<PluginStateStoreFactoryOptions>
>();

export function resolvePluginStateRuntimeOptions(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PluginStateStoreFactoryOptions> {
  if (env !== process.env) {
    return materializePluginStateRuntimeOptions(config, env);
  }
  const existing = processRuntimeOptions.get(config);
  if (existing) {
    return existing;
  }
  const resolved = materializePluginStateRuntimeOptions(config, env);
  processRuntimeOptions.set(config, resolved);
  void resolved.catch(() => processRuntimeOptions.delete(config));
  return resolved;
}

async function materializePluginStateRuntimeOptions(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): Promise<PluginStateStoreFactoryOptions> {
  const storage = config.storage;
  if (!storage || storage.backend !== "azuresql") {
    throw new Error("Azure SQL plugin state requires storage.backend to be azuresql");
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
