import { createHash } from "node:crypto";
import type { StorageConfig } from "../config/types.openclaw.js";
import {
  createAzureSqlDeviceCodeCredential,
  createAzureSqlSecretCredential,
  type AzureSqlSecretResolver,
} from "./azure-sql/credentials.js";
import { AzureSqlPluginStateStore } from "./azure-sql/plugin-state-store.js";
import { AzureSqlDatabase, type AzureSqlTokenCredential } from "./azure-sql/runtime.js";
import { assertStorageBackendConfig } from "./storage-backend.js";

export type PluginStateStoreFactoryOptions = {
  storage: StorageConfig;
  azureSqlCredential?: AzureSqlTokenCredential;
  azureSqlSecretResolver?: AzureSqlSecretResolver;
  azureSqlPassword?: { username: string; password: string };
};

type AzureSqlPluginStateStoreEntry = {
  database: AzureSqlDatabase;
  store: AzureSqlPluginStateStore;
};

const azureSqlPluginStateStores = new Map<string, AzureSqlPluginStateStoreEntry>();

function azureSqlStoreKey(
  config: NonNullable<StorageConfig["azureSql"]>,
  options: PluginStateStoreFactoryOptions,
): string {
  const authentication = config.authentication;
  const authenticationIdentity = options.azureSqlCredential
    ? "injected-token"
    : options.azureSqlPassword
      ? `sql-password:${options.azureSqlPassword.username}:${createHash("sha256").update(options.azureSqlPassword.password).digest("hex")}`
      : config.credential
        ? `secret-token:${config.credential.source}:${config.credential.provider}:${config.credential.id}`
        : authentication?.mode === "device-code"
          ? `device-code:${authentication.tenantId ?? ""}`
          : "default-token";
  return `${config.server}\u0000${config.database}\u0000${config.port ?? ""}\u0000${authenticationIdentity}`;
}

export function createAzureSqlPluginStateStore(
  options: PluginStateStoreFactoryOptions,
): AzureSqlPluginStateStore {
  assertStorageBackendConfig(options.storage);
  const azureSql = options.storage.azureSql;
  if (!azureSql) {
    throw new Error("Azure SQL storage configuration is missing");
  }
  if (azureSql.credential && !options.azureSqlCredential && !options.azureSqlSecretResolver) {
    throw new Error(
      "Azure SQL credential is configured but has not been resolved by the storage runtime",
    );
  }
  if (azureSql.authentication?.mode === "sql-password" && !options.azureSqlPassword) {
    throw new Error(
      "Azure SQL password is configured but has not been resolved by the storage runtime",
    );
  }
  const key = azureSqlStoreKey(azureSql, options);
  const existing = azureSqlPluginStateStores.get(key);
  if (existing) {
    return existing.store;
  }
  const credential =
    options.azureSqlCredential ??
    (azureSql.credential && options.azureSqlSecretResolver
      ? createAzureSqlSecretCredential(azureSql.credential, options.azureSqlSecretResolver)
      : azureSql.authentication?.mode === "device-code"
        ? createAzureSqlDeviceCodeCredential({ tenantId: azureSql.authentication.tenantId })
        : undefined);
  const database = new AzureSqlDatabase({
    server: azureSql.server,
    database: azureSql.database,
    ...(azureSql.authentication?.mode === "device-code" ? { connectionTimeoutMs: 300_000 } : {}),
    ...(azureSql.port === undefined ? {} : { port: azureSql.port }),
    ...(credential ? { credential } : {}),
    ...(options.azureSqlPassword ? { sqlPassword: options.azureSqlPassword } : {}),
  });
  const store = new AzureSqlPluginStateStore(database);
  azureSqlPluginStateStores.set(key, { database, store });
  return store;
}

export async function closePluginStateAzureSqlDatabases(): Promise<void> {
  const entries = [...azureSqlPluginStateStores.values()];
  azureSqlPluginStateStores.clear();
  await Promise.all(entries.map(({ database }) => database.close()));
}
