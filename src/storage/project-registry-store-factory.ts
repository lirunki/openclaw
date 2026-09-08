import { createHash } from "node:crypto";
import type { StorageConfig } from "../config/types.openclaw.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import {
  createAzureSqlDeviceCodeCredential,
  createAzureSqlSecretCredential,
  type AzureSqlSecretResolver,
} from "./azure-sql/credentials.js";
import { AzureSqlProjectRegistryStore } from "./azure-sql/project-registry-store.js";
import { AzureSqlDatabase, type AzureSqlTokenCredential } from "./azure-sql/runtime.js";
import type { ProjectRegistryStore } from "./project-registry-store.js";
import { createSqliteProjectRegistryStore } from "./sqlite/project-registry-store.js";
import { assertStorageBackendConfig, resolveStorageBackend } from "./storage-backend.js";

export type ProjectRegistryStoreOptions = OpenClawStateDatabaseOptions & {
  storage?: StorageConfig;
  /** Resolved credential supplied by setup/runtime; never read from config directly. */
  azureSqlCredential?: AzureSqlTokenCredential;
  /** Secret resolver supplied by setup/runtime for a configured SecretRef. */
  azureSqlSecretResolver?: AzureSqlSecretResolver;
  /** Resolved SQL authentication supplied by the runtime; never persisted by this factory. */
  azureSqlPassword?: { username: string; password: string };
};

type AzureSqlProjectStoreEntry = {
  database: AzureSqlDatabase;
  store: AzureSqlProjectRegistryStore;
};

const azureSqlProjectStores = new Map<string, AzureSqlProjectStoreEntry>();

function azureSqlStoreKey(
  config: NonNullable<StorageConfig["azureSql"]>,
  options: ProjectRegistryStoreOptions,
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

function getAzureSqlProjectStore(
  options: ProjectRegistryStoreOptions,
): AzureSqlProjectRegistryStore {
  const storage = options.storage;
  assertStorageBackendConfig(storage);
  const azureSql = storage?.azureSql;
  if (!azureSql) {
    throw new Error("Azure SQL storage configuration is missing");
  }
  if (azureSql.credential && !options.azureSqlCredential && !options.azureSqlSecretResolver) {
    throw new Error(
      "Azure SQL credential is configured but has not been resolved by the storage runtime",
    );
  }
  const key = azureSqlStoreKey(azureSql, options);
  const existing = azureSqlProjectStores.get(key);
  if (existing) {
    return existing.store;
  }
  if (azureSql.authentication?.mode === "sql-password" && !options.azureSqlPassword) {
    throw new Error(
      "Azure SQL password is configured but has not been resolved by the storage runtime",
    );
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
  const store = new AzureSqlProjectRegistryStore(database);
  azureSqlProjectStores.set(key, { database, store });
  return store;
}

export function createProjectRegistryStore(
  options: ProjectRegistryStoreOptions = {},
): ProjectRegistryStore {
  if (
    resolveStorageBackend(options.storage ? { storage: options.storage } : undefined) === "sqlite"
  ) {
    return createSqliteProjectRegistryStore(options);
  }
  return getAzureSqlProjectStore(options);
}

export async function closeProjectRegistryAzureSqlDatabases(): Promise<void> {
  const entries = [...azureSqlProjectStores.values()];
  azureSqlProjectStores.clear();
  await Promise.all(entries.map(({ database }) => database.close()));
}
