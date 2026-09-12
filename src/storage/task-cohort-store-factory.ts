import { createHash } from "node:crypto";
import type { StorageConfig } from "../config/types.openclaw.js";
import {
  createAzureSqlDeviceCodeCredential,
  createAzureSqlSecretCredential,
  type AzureSqlSecretResolver,
} from "./azure-sql/credentials.js";
import { AzureSqlDatabase, type AzureSqlTokenCredential } from "./azure-sql/runtime.js";
import { AzureSqlTaskCohortStore } from "./azure-sql/task-cohort-store.js";
import { assertStorageBackendConfig } from "./storage-backend.js";

export type TaskCohortStoreFactoryOptions = {
  storage: StorageConfig;
  azureSqlCredential?: AzureSqlTokenCredential;
  azureSqlSecretResolver?: AzureSqlSecretResolver;
  azureSqlPassword?: { username: string; password: string };
};

type TaskCohortStoreEntry = {
  database: AzureSqlDatabase;
  store: AzureSqlTaskCohortStore;
};

const azureSqlTaskCohortStores = new Map<string, TaskCohortStoreEntry>();
const injectedCredentialIds = new WeakMap<AzureSqlTokenCredential, number>();
let nextInjectedCredentialId = 1;

function injectedCredentialIdentity(credential: AzureSqlTokenCredential): string {
  const existing = injectedCredentialIds.get(credential);
  if (existing !== undefined) {
    return `injected-token:${existing}`;
  }
  const id = nextInjectedCredentialId;
  nextInjectedCredentialId += 1;
  injectedCredentialIds.set(credential, id);
  return `injected-token:${id}`;
}

function taskCohortStoreKey(
  config: NonNullable<StorageConfig["azureSql"]>,
  options: TaskCohortStoreFactoryOptions,
): string {
  const authentication = config.authentication;
  const authenticationIdentity = options.azureSqlCredential
    ? injectedCredentialIdentity(options.azureSqlCredential)
    : options.azureSqlPassword
      ? `sql-password:${options.azureSqlPassword.username}:${createHash("sha256").update(options.azureSqlPassword.password).digest("hex")}`
      : config.credential
        ? `secret-token:${config.credential.source}:${config.credential.provider}:${config.credential.id}`
        : authentication?.mode === "device-code"
          ? `device-code:${authentication.tenantId ?? ""}`
          : "default-token";
  return `${config.server}\u0000${config.database}\u0000${config.port ?? ""}\u0000${authenticationIdentity}`;
}

export function createAzureSqlTaskCohortStore(
  options: TaskCohortStoreFactoryOptions,
): AzureSqlTaskCohortStore {
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
  const key = taskCohortStoreKey(azureSql, options);
  const existing = azureSqlTaskCohortStores.get(key);
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
  const store = new AzureSqlTaskCohortStore(database, async () => {
    const entry = azureSqlTaskCohortStores.get(key);
    if (entry?.store === store) {
      azureSqlTaskCohortStores.delete(key);
    }
    await database.close();
  });
  azureSqlTaskCohortStores.set(key, { database, store });
  return store;
}

export async function closeTaskCohortAzureSqlDatabases(): Promise<void> {
  const stores = [...azureSqlTaskCohortStores.values()].map(({ store }) => store);
  azureSqlTaskCohortStores.clear();
  await Promise.all(stores.map(async (store) => await store.close()));
}
