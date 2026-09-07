import type { OpenClawConfig, StorageConfig } from "../config/types.openclaw.js";

export type StorageBackendKind = "sqlite" | "azuresql";

export function resolveStorageBackend(
  config?: Pick<OpenClawConfig, "storage">,
): StorageBackendKind {
  return config?.storage?.backend ?? "sqlite";
}

export function assertStorageBackendConfig(storage: StorageConfig | undefined): void {
  if (storage?.backend !== "azuresql") {
    return;
  }
  if (!storage.azureSql) {
    throw new Error("storage.azureSql is required when storage.backend is azuresql");
  }
}
