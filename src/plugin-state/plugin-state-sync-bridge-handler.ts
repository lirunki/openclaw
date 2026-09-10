import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SecretRef } from "../config/types.secrets.js";
import { resolveSecretRefString } from "../secrets/resolve.js";
import type { AzureSqlPluginStateStore } from "../storage/azure-sql/plugin-state-store.js";
import { resolvePluginStateRuntimeOptions } from "../storage/plugin-state-runtime-options.js";
import {
  closePluginStateAzureSqlDatabases,
  createAzureSqlPluginStateStore,
} from "../storage/plugin-state-store-factory.js";
import { serializeStorageSyncBridgeError } from "../storage/storage-sync-bridge-protocol.js";
import { PluginStateStoreError } from "./plugin-state-store.types.js";
import type {
  PluginStateBridgeEnvelope,
  PluginStateBridgeError,
  PluginStateBridgeLookupResult,
} from "./plugin-state-sync-bridge.shared.js";

let activeStore: AzureSqlPluginStateStore | undefined;
let currentSecretContext: { config: OpenClawConfig; env: NodeJS.ProcessEnv } | undefined;

const resolveCurrentSecret = async (ref: SecretRef): Promise<string> => {
  if (!currentSecretContext) {
    throw new Error("Plugin-state compatibility worker secret context is unavailable");
  }
  return await resolveSecretRefString(ref, currentSecretContext);
};

function serializePluginStateError(error: unknown): PluginStateBridgeError {
  const serialized = serializeStorageSyncBridgeError(error);
  return {
    name: serialized.name,
    message: serialized.message,
    ...(error instanceof PluginStateStoreError
      ? { code: error.code, operation: error.operation }
      : {}),
  };
}

async function resolveStore(
  envelope: PluginStateBridgeEnvelope,
): Promise<AzureSqlPluginStateStore> {
  currentSecretContext = { config: envelope.config, env: envelope.env };
  const options = await resolvePluginStateRuntimeOptions(envelope.config, envelope.env);
  if (options.storage.azureSql?.credential) {
    options.azureSqlSecretResolver = resolveCurrentSecret;
  }
  let store = createAzureSqlPluginStateStore(options);
  if (activeStore && activeStore !== store) {
    await closePluginStateAzureSqlDatabases();
    store = createAzureSqlPluginStateStore(options);
  }
  activeStore = store;
  return store;
}

export async function handlePluginStateSyncBridgeRequest(
  envelope: PluginStateBridgeEnvelope,
): Promise<unknown> {
  const store = await resolveStore(envelope);
  const request = envelope.request;
  switch (request.operation) {
    case "register":
      return await store.register(request.scope, request.input);
    case "registerIfAbsent":
      return await store.registerIfAbsent(request.scope, request.input);
    case "lookupRaw":
      return await store.lookupRaw(request.scope, request.key);
    case "entriesInKeyRange":
      return await store.entriesInKeyRange(request.scope, request);
    case "countLiveEntries":
      return await store.countLiveEntries(request.scope.pluginId);
    case "sweepExpired":
      return await store.sweepExpired();
    case "importBatch":
      return await store.importBatch(request.scope, request.entries);
    case "lookupMany": {
      const results = await store.lookupMany(request.scope, request.keys);
      return results.map((result): PluginStateBridgeLookupResult =>
        result.ok ? result : { ok: false, error: serializePluginStateError(result.error) },
      );
    }
    case "consume":
      return await store.consume(request.scope, request.key);
    case "delete":
      return await store.delete(request.scope, request.key);
    case "entries":
      return await store.entries(request.scope);
    case "clear":
      return await store.clear(request.scope);
    case "appendSequencedJournalEntry":
      return await store.appendSequencedJournalEntry({
        cursorScope: request.scope,
        journalScope: request.journalScope,
        expectedCursor: request.expected,
        cursor: request.cursor,
        journal: request.journal,
      });
    case "compareAndSet":
      return await store.compareAndSet(request.scope, request.expected, request.input);
    case "deleteIfUnchanged":
      return await store.deleteIfUnchanged(request.scope, request.expected);
  }
}

export async function closePluginStateSyncBridgeHandler(): Promise<void> {
  activeStore = undefined;
  currentSecretContext = undefined;
  await closePluginStateAzureSqlDatabases();
}
