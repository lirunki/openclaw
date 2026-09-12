import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSecretRefString } from "../secrets/resolve.js";
import type { TaskCohortStoreFactoryOptions } from "./task-cohort-store-factory.js";

const processRuntimeOptions = new WeakMap<OpenClawConfig, Promise<TaskCohortStoreFactoryOptions>>();

export function resolveTaskCohortRuntimeOptions(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<TaskCohortStoreFactoryOptions> {
  if (env !== process.env) {
    return materializeTaskCohortRuntimeOptions(config, env);
  }
  const existing = processRuntimeOptions.get(config);
  if (existing) {
    return existing;
  }
  const resolved = materializeTaskCohortRuntimeOptions(config, env);
  processRuntimeOptions.set(config, resolved);
  void resolved.catch(() => processRuntimeOptions.delete(config));
  return resolved;
}

async function materializeTaskCohortRuntimeOptions(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): Promise<TaskCohortStoreFactoryOptions> {
  const storage = config.storage;
  if (!storage || storage.backend !== "azuresql") {
    throw new Error("Azure SQL task cohort requires storage.backend to be azuresql");
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
