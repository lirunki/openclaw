// Plugin state store exposes persisted per-plugin state operations.
import type { Result } from "@openclaw/normalization-core/result";
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import type {
  AzureSqlPluginStateScope,
  AzureSqlPluginStateStore,
} from "../storage/azure-sql/plugin-state-store.js";
import { resolveStorageBackend } from "../storage/storage-backend.js";
import type { PluginDoctorRawStateEntry } from "./plugin-state-store.sqlite.js";
import {
  clearPluginStateDatabaseForTests,
  closePluginStateDatabase,
  countPluginStateLiveEntries as countPluginStateLiveEntriesSqlite,
  getPluginStateCapacity as getPluginStateCapacitySqlite,
  MAX_PLUGIN_STATE_BULK_DELETE_ENTRIES,
  MAX_PLUGIN_STATE_ENTRIES_PER_PLUGIN,
  MAX_PLUGIN_STATE_VALUE_BYTES,
  PLUGIN_STATE_DOCTOR_IMPORT_BATCH_ROWS,
  pluginStateImportBatch,
  pluginStateClear,
  pluginStateConsume,
  pluginStateDelete,
  pluginStateDeleteEntriesIfUnchanged as pluginStateDeleteEntriesIfUnchangedSqlite,
  pluginStateDeleteIf,
  pluginStateDoctorEntriesInKeyRange as pluginStateDoctorEntriesInKeyRangeSqlite,
  pluginStateEntries,
  pluginStateEntriesInKeyRange as pluginStateEntriesInKeyRangeSqlite,
  pluginStateLookup,
  pluginStateLookupMany,
  pluginStateRegister,
  pluginStateRegisterIfAbsent,
  pluginStateRegisterSequencedJournalEntry,
  pluginStateUpdate,
  sweepExpiredPluginStateEntries as sweepExpiredPluginStateEntriesSqlite,
} from "./plugin-state-store.sqlite.js";
import type {
  OpenKeyedStoreOptions,
  PluginStateEntry,
  PluginStateKeyedStore,
  PluginStateSyncKeyedStore,
  PluginStateOverflowPolicy,
  PluginStateStoreOperation,
} from "./plugin-state-store.types.js";
import { PluginStateStoreError } from "./plugin-state-store.types.js";
import {
  AzureSqlPluginStateSyncBridge,
  closePluginStateSyncBridgeWorker,
} from "./plugin-state-sync-bridge.js";
import {
  createPluginStoreOptionPolicy,
  serializePluginStoreJson,
  validateOptionalPluginStoreTtlMs,
  validatePluginStoreKey,
  validatePluginStoreNamespace,
} from "./plugin-store-validation.js";

// Public plugin-state facade over the sqlite-backed store. It validates plugin
// ids, namespaces, JSON values, TTLs, and per-plugin limits before persistence.
export type {
  OpenKeyedStoreOptions,
  PluginStateEntry,
  PluginStateKeyedStore,
  PluginStateSyncKeyedStore,
} from "./plugin-state-store.types.js";

export type { PluginDoctorRawStateEntry } from "./plugin-state-store.sqlite.js";

export {
  closePluginStateDatabase,
  MAX_PLUGIN_STATE_ENTRIES_PER_PLUGIN,
  MAX_PLUGIN_STATE_BULK_DELETE_ENTRIES,
  resolveMaxPluginStateEntriesPerPlugin,
} from "./plugin-state-store.sqlite.js";

type StoreOptionSignature = {
  maxEntries: number;
  overflowPolicy: PluginStateOverflowPolicy;
  defaultTtlMs?: number;
};

type PreparedRegisterParams = {
  key: string;
  valueJson: string;
  ttlMs?: number;
};

type PluginStateImportEntry = {
  key: string;
  value: unknown;
  createdAt: number;
  ttlMs?: number;
};

function invalidInput(
  message: string,
  operation: PluginStateStoreOperation = "register",
): PluginStateStoreError {
  return new PluginStateStoreError(message, {
    code: "PLUGIN_STATE_INVALID_INPUT",
    operation,
  });
}

function validateNamespace(value: string, operation: PluginStateStoreOperation = "open"): string {
  return validatePluginStoreNamespace({
    value,
    label: "plugin state",
    errors: {
      invalid: (message) => invalidInput(message, operation),
      limit: (message) => invalidInput(message, operation),
    },
  });
}

function validateKey(value: string, operation: PluginStateStoreOperation = "register"): string {
  return validatePluginStoreKey({
    value,
    label: "plugin state",
    errors: {
      invalid: (message) => invalidInput(message, operation),
      limit: (message) => invalidInput(message, operation),
    },
  });
}

function validateMaxEntries(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw invalidInput("plugin state maxEntries must be an integer >= 1", "open");
  }
  return value;
}

const optionPolicy = createPluginStoreOptionPolicy<StoreOptionSignature>({
  label: "plugin state",
  invalid: (message) => invalidInput(message, "open"),
});

function validateOptionalTtlMs(
  value: number | undefined,
  operation: PluginStateStoreOperation = "register",
): number | undefined {
  return validateOptionalPluginStoreTtlMs({
    value,
    label: "plugin state ttlMs",
    errors: {
      invalid: (message) => invalidInput(message, operation),
      limit: (message) => invalidInput(message, operation),
    },
  });
}

function prepareRegisterParams(
  key: string,
  value: unknown,
  defaultTtlMs?: number,
  opts?: { ttlMs?: number },
): PreparedRegisterParams {
  const normalizedKey = validateKey(key, "register");
  const json = serializePluginStoreJson({
    value,
    label: "plugin state value",
    maxBytes: MAX_PLUGIN_STATE_VALUE_BYTES,
    errors: {
      invalid: (message) => invalidInput(message, "register"),
      limit: (message) =>
        new PluginStateStoreError(message, {
          code: "PLUGIN_STATE_LIMIT_EXCEEDED",
          operation: "register",
        }),
    },
  });
  const ttlMs = validateOptionalTtlMs(opts?.ttlMs, "register") ?? defaultTtlMs;
  return {
    key: normalizedKey,
    valueJson: json,
    ...(ttlMs != null ? { ttlMs } : {}),
  };
}

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? ReadonlyArray<DeepReadonly<U>>
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

type PluginStateRuntimeContext = {
  config?: DeepReadonly<OpenClawConfig>;
};

type PreparedStoreContext = {
  namespace: string;
  maxEntries: number;
  overflowPolicy: PluginStateOverflowPolicy;
  defaultTtlMs?: number;
  env?: NodeJS.ProcessEnv;
};

function resolvePluginStateConfig(context?: PluginStateRuntimeContext): OpenClawConfig {
  if (context?.config) {
    // SAFETY: structuredClone removes readonly views while preserving the config data shape.
    return structuredClone(context.config) as OpenClawConfig;
  }
  return getRuntimeConfig({ skipPluginValidation: true, skipShellEnvFallback: true });
}

function prepareStoreContext(
  pluginId: string,
  options: OpenKeyedStoreOptions,
): PreparedStoreContext {
  const namespace = validateNamespace(options.namespace);
  const maxEntries = validateMaxEntries(options.maxEntries);
  const overflowPolicy = optionPolicy.resolveOverflowPolicy(options.overflowPolicy);
  const defaultTtlMs = validateOptionalTtlMs(options.defaultTtlMs);
  optionPolicy.assertConsistent(pluginId, namespace, {
    maxEntries,
    overflowPolicy,
    defaultTtlMs,
  });
  return {
    namespace,
    maxEntries,
    overflowPolicy,
    defaultTtlMs,
    ...(options.env ? { env: options.env } : {}),
  };
}

function createSqliteKeyedStoreForPluginId<T>(
  pluginId: string,
  options: OpenKeyedStoreOptions,
): Required<PluginStateKeyedStore<T>> {
  const store = createSqliteSyncKeyedStoreForPluginId<T>(pluginId, options);
  return {
    register: async (...args) => store.register(...args),
    registerIfAbsent: async (...args) => store.registerIfAbsent(...args),
    update: async (...args) => store.update(...args),
    deleteIf: async (...args) => store.deleteIf(...args),
    lookup: async (...args) => store.lookup(...args),
    lookupMany: async (...args) => store.lookupMany(...args),
    consume: async (...args) => store.consume(...args),
    delete: async (...args) => store.delete(...args),
    entries: async () => store.entries(),
    clear: async () => store.clear(),
  };
}

function createSqliteSyncKeyedStoreForPluginId<T>(
  pluginId: string,
  options: OpenKeyedStoreOptions,
): Required<PluginStateSyncKeyedStore<T>> {
  const { namespace, maxEntries, overflowPolicy, defaultTtlMs, env } = prepareStoreContext(
    pluginId,
    options,
  );

  return {
    register(key, value, opts) {
      const params = prepareRegisterParams(key, value, defaultTtlMs, opts);
      pluginStateRegister({
        pluginId,
        namespace,
        key: params.key,
        valueJson: params.valueJson,
        maxEntries,
        overflowPolicy,
        ...(env ? { env } : {}),
        ...(params.ttlMs != null ? { ttlMs: params.ttlMs } : {}),
      });
    },
    registerIfAbsent(key, value, opts) {
      const params = prepareRegisterParams(key, value, defaultTtlMs, opts);
      return pluginStateRegisterIfAbsent({
        pluginId,
        namespace,
        key: params.key,
        valueJson: params.valueJson,
        maxEntries,
        overflowPolicy,
        ...(env ? { env } : {}),
        ...(params.ttlMs != null ? { ttlMs: params.ttlMs } : {}),
      });
    },
    update(key, updateValue, opts) {
      const normalizedKey = validateKey(key, "register");
      return pluginStateUpdate({
        pluginId,
        namespace,
        key: normalizedKey,
        maxEntries,
        overflowPolicy,
        updateValueJson: (current) => {
          const next = updateValue(current as T | undefined);
          if (next === undefined) {
            return undefined;
          }
          const params = prepareRegisterParams(normalizedKey, next, defaultTtlMs, opts);
          return {
            valueJson: params.valueJson,
            ...(params.ttlMs != null ? { ttlMs: params.ttlMs } : {}),
          };
        },
        ...(env ? { env } : {}),
      });
    },
    deleteIf(key, predicate) {
      const normalizedKey = validateKey(key, "delete");
      return pluginStateDeleteIf({
        pluginId,
        namespace,
        key: normalizedKey,
        predicate: (current) => predicate(current as T),
        ...(env ? { env } : {}),
      });
    },
    lookup(key) {
      const normalizedKey = validateKey(key, "lookup");
      return pluginStateLookup({
        pluginId,
        namespace,
        key: normalizedKey,
        ...(env ? { env } : {}),
      }) as T | undefined;
    },
    lookupMany(keys) {
      if (keys.length > 10_000) {
        throw invalidInput("plugin state lookupMany accepts at most 10000 keys", "lookup");
      }
      const normalizedKeys = Array.from(keys, (key) => validateKey(key, "lookup"));
      const values = pluginStateLookupMany({
        pluginId,
        namespace,
        keys: normalizedKeys,
        ...(env ? { env } : {}),
      });
      // SAFETY: This namespace uses the caller's JSON value type, as with lookup.
      return values as Array<Result<T | undefined, PluginStateStoreError>>;
    },
    consume(key) {
      const normalizedKey = validateKey(key, "consume");
      return pluginStateConsume({
        pluginId,
        namespace,
        key: normalizedKey,
        ...(env ? { env } : {}),
      }) as T | undefined;
    },
    delete(key) {
      const normalizedKey = validateKey(key, "delete");
      return pluginStateDelete({
        pluginId,
        namespace,
        key: normalizedKey,
        ...(env ? { env } : {}),
      });
    },
    entries() {
      return pluginStateEntries({
        pluginId,
        namespace,
        ...(env ? { env } : {}),
      }) as PluginStateEntry<T>[];
    },
    clear() {
      pluginStateClear({ pluginId, namespace, ...(env ? { env } : {}) });
    },
  };
}

function createAzureSqlStoreScope(
  pluginId: string,
  context: PreparedStoreContext,
): AzureSqlPluginStateScope {
  return {
    pluginId,
    namespace: context.namespace,
    maxEntries: context.maxEntries,
    overflowPolicy: context.overflowPolicy,
  };
}

function createAzureSqlKeyedStoreForPluginId<T>(
  pluginId: string,
  options: OpenKeyedStoreOptions,
  config: OpenClawConfig,
): Required<PluginStateKeyedStore<T>> {
  const context = prepareStoreContext(pluginId, options);
  const scope = createAzureSqlStoreScope(pluginId, context);
  let storePromise: Promise<AzureSqlPluginStateStore> | undefined;
  const getStore = (): Promise<AzureSqlPluginStateStore> => {
    if (storePromise) {
      return storePromise;
    }
    storePromise = (async () => {
      const [{ createAzureSqlPluginStateStore }, { resolvePluginStateRuntimeOptions }] =
        await Promise.all([
          import("../storage/plugin-state-store-factory.js"),
          import("../storage/plugin-state-runtime-options.js"),
        ]);
      return createAzureSqlPluginStateStore(
        await resolvePluginStateRuntimeOptions(config, context.env ?? process.env),
      );
    })();
    void storePromise.catch(() => {
      storePromise = undefined;
    });
    return storePromise;
  };

  return {
    async register(key, value, opts) {
      const input = prepareRegisterParams(key, value, context.defaultTtlMs, opts);
      await (await getStore()).register(scope, input);
    },
    async registerIfAbsent(key, value, opts) {
      const input = prepareRegisterParams(key, value, context.defaultTtlMs, opts);
      return await (await getStore()).registerIfAbsent(scope, input);
    },
    async update(key, updateValue, opts) {
      const normalizedKey = validateKey(key, "register");
      return await (
        await getStore()
      ).update(scope, normalizedKey, (current) => {
        // SAFETY: values in this namespace were serialized through this typed store.
        const next = updateValue(current as T | undefined);
        if (next === undefined) {
          return undefined;
        }
        const input = prepareRegisterParams(normalizedKey, next, context.defaultTtlMs, opts);
        return {
          valueJson: input.valueJson,
          ...(input.ttlMs == null ? {} : { ttlMs: input.ttlMs }),
        };
      });
    },
    async deleteIf(key, predicate) {
      const normalizedKey = validateKey(key, "delete");
      return await (
        await getStore()
      ).deleteIf(scope, normalizedKey, (current) => {
        // SAFETY: values in this namespace were serialized through this typed store.
        return predicate(current as T);
      });
    },
    async lookup(key) {
      const normalizedKey = validateKey(key, "lookup");
      // SAFETY: values in this namespace were serialized through this typed store.
      return (await (await getStore()).lookup(scope, normalizedKey)) as T | undefined;
    },
    async lookupMany(keys) {
      if (keys.length > 10_000) {
        throw invalidInput("plugin state lookupMany accepts at most 10000 keys", "lookup");
      }
      const normalizedKeys = Array.from(keys, (key) => validateKey(key, "lookup"));
      // SAFETY: each successful value belongs to this typed namespace.
      return (await (await getStore()).lookupMany(scope, normalizedKeys)) as Array<
        Result<T | undefined, PluginStateStoreError>
      >;
    },
    async consume(key) {
      const normalizedKey = validateKey(key, "consume");
      // SAFETY: values in this namespace were serialized through this typed store.
      return (await (await getStore()).consume(scope, normalizedKey)) as T | undefined;
    },
    async delete(key) {
      const normalizedKey = validateKey(key, "delete");
      return await (await getStore()).delete(scope, normalizedKey);
    },
    async entries() {
      // SAFETY: every entry belongs to this typed namespace.
      return (await (await getStore()).entries(scope)) as PluginStateEntry<T>[];
    },
    async clear() {
      await (await getStore()).clear(scope);
    },
  };
}

function createAzureSqlSyncKeyedStoreForPluginId<T>(
  pluginId: string,
  options: OpenKeyedStoreOptions,
  config: OpenClawConfig,
): Required<PluginStateSyncKeyedStore<T>> {
  const context = prepareStoreContext(pluginId, options);
  const bridge = new AzureSqlPluginStateSyncBridge(
    config,
    context.env ?? process.env,
    createAzureSqlStoreScope(pluginId, context),
  );
  return {
    register(key, value, opts) {
      bridge.register(prepareRegisterParams(key, value, context.defaultTtlMs, opts));
    },
    registerIfAbsent(key, value, opts) {
      return bridge.registerIfAbsent(prepareRegisterParams(key, value, context.defaultTtlMs, opts));
    },
    update(key, updateValue, opts) {
      const normalizedKey = validateKey(key, "register");
      return bridge.update(normalizedKey, (current) => {
        // SAFETY: values in this namespace were serialized through this typed store.
        const next = updateValue(current as T | undefined);
        if (next === undefined) {
          return undefined;
        }
        const input = prepareRegisterParams(normalizedKey, next, context.defaultTtlMs, opts);
        return {
          valueJson: input.valueJson,
          ...(input.ttlMs == null ? {} : { ttlMs: input.ttlMs }),
        };
      });
    },
    deleteIf(key, predicate) {
      return bridge.deleteIf(validateKey(key, "delete"), (current) => {
        // SAFETY: values in this namespace were serialized through this typed store.
        return predicate(current as T);
      });
    },
    lookup(key) {
      return bridge.lookup<T>(validateKey(key, "lookup"));
    },
    lookupMany(keys) {
      if (keys.length > 10_000) {
        throw invalidInput("plugin state lookupMany accepts at most 10000 keys", "lookup");
      }
      return bridge.lookupMany<T>(Array.from(keys, (key) => validateKey(key, "lookup")));
    },
    consume(key) {
      return bridge.consume<T>(validateKey(key, "consume"));
    },
    delete(key) {
      return bridge.delete(validateKey(key, "delete"));
    },
    entries() {
      return bridge.entries<T>();
    },
    clear() {
      bridge.clear();
    },
  };
}

function createKeyedStoreForPluginId<T>(
  pluginId: string,
  options: OpenKeyedStoreOptions,
  runtimeContext?: PluginStateRuntimeContext,
): Required<PluginStateKeyedStore<T>> {
  if (runtimeContext?.config && runtimeContext.config.storage?.backend !== "azuresql") {
    return createSqliteKeyedStoreForPluginId<T>(pluginId, options);
  }
  const config = resolvePluginStateConfig(runtimeContext);
  return resolveStorageBackend(config) === "azuresql"
    ? createAzureSqlKeyedStoreForPluginId<T>(pluginId, options, config)
    : createSqliteKeyedStoreForPluginId<T>(pluginId, options);
}

function createSyncKeyedStoreForPluginId<T>(
  pluginId: string,
  options: OpenKeyedStoreOptions,
  runtimeContext?: PluginStateRuntimeContext,
): Required<PluginStateSyncKeyedStore<T>> {
  if (runtimeContext?.config && runtimeContext.config.storage?.backend !== "azuresql") {
    return createSqliteSyncKeyedStoreForPluginId<T>(pluginId, options);
  }
  const config = resolvePluginStateConfig(runtimeContext);
  return resolveStorageBackend(config) === "azuresql"
    ? createAzureSqlSyncKeyedStoreForPluginId<T>(pluginId, options, config)
    : createSqliteSyncKeyedStoreForPluginId<T>(pluginId, options);
}

/**
 * Migration-only write path that preserves a legacy entry's original creation
 * timestamp. Cap eviction removes the oldest `created_at` first, so imported
 * rows must keep their real age instead of being stamped with the import time
 * (which would let later live writes evict fresher pre-existing rows first).
 * Not part of the plugin-facing store API.
 */
export function registerMigratedPluginStateEntry(params: {
  pluginId: string;
  namespace: string;
  maxEntries: number;
  overflowPolicy?: PluginStateOverflowPolicy;
  defaultTtlMs?: number;
  key: string;
  value: unknown;
  ttlMs?: number;
  createdAtMs: number;
  env?: NodeJS.ProcessEnv;
}): void {
  if (!Number.isFinite(params.createdAtMs) || params.createdAtMs < 0) {
    throw invalidInput("plugin state migration createdAtMs must be a non-negative finite number");
  }
  const namespace = validateNamespace(params.namespace, "register");
  const maxEntries = validateMaxEntries(params.maxEntries);
  const overflowPolicy = optionPolicy.resolveOverflowPolicy(params.overflowPolicy);
  const defaultTtlMs = validateOptionalTtlMs(params.defaultTtlMs);
  const prepared = prepareRegisterParams(
    params.key,
    params.value,
    defaultTtlMs,
    params.ttlMs != null ? { ttlMs: params.ttlMs } : undefined,
  );
  const input = {
    key: prepared.key,
    valueJson: prepared.valueJson,
    createdAtMs: Math.floor(params.createdAtMs),
    ...(prepared.ttlMs != null ? { ttlMs: prepared.ttlMs } : {}),
  };
  const config = resolvePluginStateConfig();
  if (resolveStorageBackend(config) === "azuresql") {
    new AzureSqlPluginStateSyncBridge(config, params.env ?? process.env, {
      pluginId: params.pluginId,
      namespace,
      maxEntries,
      overflowPolicy,
    }).register(input);
    return;
  }
  pluginStateRegister({
    pluginId: params.pluginId,
    namespace,
    maxEntries,
    overflowPolicy,
    ...input,
    ...(params.env ? { env: params.env } : {}),
  });
}

/** Opens an async plugin-state namespace for a non-core plugin id. */
export function createPluginStateKeyedStore<T>(
  pluginId: string,
  options: OpenKeyedStoreOptions,
): Required<PluginStateKeyedStore<T>> {
  if (pluginId.startsWith("core:")) {
    throw invalidInput("Plugin ids starting with 'core:' are reserved for core consumers.", "open");
  }
  return createKeyedStoreForPluginId<T>(pluginId, options);
}

/** Host-bound variant that uses the immutable config snapshot which created the plugin runtime. */
export function createPluginStateKeyedStoreForRuntime<T>(
  pluginId: string,
  options: OpenKeyedStoreOptions,
  config: DeepReadonly<OpenClawConfig>,
): Required<PluginStateKeyedStore<T>> {
  if (pluginId.startsWith("core:")) {
    throw invalidInput("Plugin ids starting with 'core:' are reserved for core consumers.", "open");
  }
  return createKeyedStoreForPluginId<T>(pluginId, options, { config });
}

/** Opens a sync plugin-state namespace for a non-core plugin id. */
export function createPluginStateSyncKeyedStore<T>(
  pluginId: string,
  options: OpenKeyedStoreOptions,
): Required<PluginStateSyncKeyedStore<T>> {
  if (pluginId.startsWith("core:")) {
    throw invalidInput("Plugin ids starting with 'core:' are reserved for core consumers.", "open");
  }
  return createSyncKeyedStoreForPluginId<T>(pluginId, options);
}

/** Host-bound sync variant used by the trusted plugin runtime proxy. */
export function createPluginStateSyncKeyedStoreForRuntime<T>(
  pluginId: string,
  options: OpenKeyedStoreOptions,
  config: DeepReadonly<OpenClawConfig>,
): Required<PluginStateSyncKeyedStore<T>> {
  if (pluginId.startsWith("core:")) {
    throw invalidInput("Plugin ids starting with 'core:' are reserved for core consumers.", "open");
  }
  return createSyncKeyedStoreForPluginId<T>(pluginId, options, { config });
}

/** Atomically allocates a workspace sequence and appends one journal entry. */
export function registerPluginStateSyncSequencedJournalEntry(params: {
  pluginId: string;
  cursorOptions: OpenKeyedStoreOptions;
  cursorKey: string;
  journalOptions: OpenKeyedStoreOptions;
  initialSequence: number;
  journalKey: (sequence: number) => string;
  journalValue: (sequence: number) => unknown;
}): number {
  if (params.pluginId.startsWith("core:")) {
    throw invalidInput("Plugin ids starting with 'core:' are reserved for core consumers.", "open");
  }
  if (!Number.isSafeInteger(params.initialSequence) || params.initialSequence < 0) {
    throw invalidInput("plugin state initial journal sequence must be a safe non-negative integer");
  }
  const cursorNamespace = validateNamespace(params.cursorOptions.namespace);
  const cursorMaxEntries = validateMaxEntries(params.cursorOptions.maxEntries);
  const cursorOverflowPolicy = optionPolicy.resolveOverflowPolicy(
    params.cursorOptions.overflowPolicy,
  );
  const cursorDefaultTtlMs = validateOptionalTtlMs(params.cursorOptions.defaultTtlMs);
  const journalNamespace = validateNamespace(params.journalOptions.namespace);
  const journalMaxEntries = validateMaxEntries(params.journalOptions.maxEntries);
  const journalOverflowPolicy = optionPolicy.resolveOverflowPolicy(
    params.journalOptions.overflowPolicy,
  );
  const journalDefaultTtlMs = validateOptionalTtlMs(params.journalOptions.defaultTtlMs);
  if (
    cursorOverflowPolicy !== "evict-oldest" ||
    journalOverflowPolicy !== "evict-oldest" ||
    cursorDefaultTtlMs !== undefined ||
    journalDefaultTtlMs !== undefined
  ) {
    throw invalidInput("sequenced plugin state journals require non-expiring evict-oldest stores");
  }
  if (params.cursorOptions.env !== params.journalOptions.env) {
    throw invalidInput("sequenced plugin state journal stores must share one environment");
  }
  const cursorKey = validateKey(params.cursorKey);
  optionPolicy.assertConsistent(params.pluginId, cursorNamespace, {
    maxEntries: cursorMaxEntries,
    overflowPolicy: cursorOverflowPolicy,
    defaultTtlMs: cursorDefaultTtlMs,
  });
  optionPolicy.assertConsistent(params.pluginId, journalNamespace, {
    maxEntries: journalMaxEntries,
    overflowPolicy: journalOverflowPolicy,
    defaultTtlMs: journalDefaultTtlMs,
  });
  const readCursorSequence = (valueJson: string): number | undefined => {
    try {
      const value = JSON.parse(valueJson) as { kind?: unknown; lastSequence?: unknown };
      return value.kind === "cursor" && Number.isSafeInteger(value.lastSequence)
        ? (value.lastSequence as number)
        : undefined;
    } catch {
      return undefined;
    }
  };
  const prepareEntry = (sequence: number) => {
    const cursor = prepareRegisterParams(cursorKey, { kind: "cursor", lastSequence: sequence });
    const journal = prepareRegisterParams(
      params.journalKey(sequence),
      params.journalValue(sequence),
    );
    return {
      cursorValueJson: cursor.valueJson,
      journalKey: journal.key,
      journalValueJson: journal.valueJson,
    };
  };
  const config = resolvePluginStateConfig();
  if (resolveStorageBackend(config) === "azuresql") {
    const bridge = new AzureSqlPluginStateSyncBridge(
      config,
      params.cursorOptions.env ?? process.env,
      {
        pluginId: params.pluginId,
        namespace: cursorNamespace,
        maxEntries: cursorMaxEntries,
        overflowPolicy: cursorOverflowPolicy,
      },
    );
    return bridge.appendSequencedJournalEntry({
      journalScope: {
        pluginId: params.pluginId,
        namespace: journalNamespace,
        maxEntries: journalMaxEntries,
        overflowPolicy: journalOverflowPolicy,
      },
      cursorKey,
      initialSequence: params.initialSequence,
      readCursorSequence,
      prepareEntry,
    });
  }
  return pluginStateRegisterSequencedJournalEntry({
    pluginId: params.pluginId,
    cursorNamespace,
    cursorKey,
    cursorMaxEntries,
    journalNamespace,
    journalMaxEntries,
    initialSequence: params.initialSequence,
    readCursorSequence,
    prepareEntry,
    ...(params.cursorOptions.env ? { env: params.cursorOptions.env } : {}),
  });
}

/** Doctor-only import that preserves source age and remaining retention. */
export function importPluginStateEntriesForDoctor(
  pluginId: string,
  options: OpenKeyedStoreOptions,
  entries: readonly PluginStateImportEntry[],
  runtimeConfig?: DeepReadonly<OpenClawConfig>,
): void {
  if (pluginId.startsWith("core:")) {
    throw invalidInput("Plugin ids starting with 'core:' are reserved for core consumers.", "open");
  }
  const namespace = validateNamespace(options.namespace);
  const maxEntries = validateMaxEntries(options.maxEntries);
  const overflowPolicy = optionPolicy.resolveOverflowPolicy(options.overflowPolicy);
  const defaultTtlMs = validateOptionalTtlMs(options.defaultTtlMs);
  const env = options.env;
  optionPolicy.assertConsistent(pluginId, namespace, {
    maxEntries,
    overflowPolicy,
    defaultTtlMs,
  });

  const config = resolvePluginStateConfig(runtimeConfig ? { config: runtimeConfig } : undefined);
  const azureBridge =
    resolveStorageBackend(config) === "azuresql"
      ? new AzureSqlPluginStateSyncBridge(config, env ?? process.env, {
          pluginId,
          namespace,
          maxEntries,
          overflowPolicy,
        })
      : undefined;
  let batch: Array<PreparedRegisterParams & { createdAtMs: number }> = [];
  const flush = () => {
    if (azureBridge) {
      azureBridge.importBatch(batch);
    } else {
      pluginStateImportBatch({ pluginId, namespace, maxEntries, overflowPolicy, env }, batch);
    }
    batch = [];
  };
  for (const entry of entries) {
    try {
      if (!Number.isSafeInteger(entry.createdAt)) {
        throw invalidInput("plugin state import createdAt must be a safe integer", "register");
      }
      const prepared = prepareRegisterParams(
        entry.key,
        entry.value,
        defaultTtlMs,
        entry.ttlMs != null ? { ttlMs: entry.ttlMs } : undefined,
      );
      batch.push({ ...prepared, createdAtMs: entry.createdAt });
    } catch (error) {
      // Validation failure must not discard earlier valid rows in this batch.
      flush();
      throw error;
    }
    if (batch.length === PLUGIN_STATE_DOCTOR_IMPORT_BATCH_ROWS) {
      flush();
    }
  }
  flush();
}

/** Opens a sync plugin-state namespace for a trusted core owner id. */
export function createCorePluginStateSyncKeyedStore<T>(
  options: OpenKeyedStoreOptions & { ownerId: `core:${string}` },
): Required<PluginStateSyncKeyedStore<T>> {
  return createSyncKeyedStoreForPluginId<T>(options.ownerId, options);
}

type PluginStateKeyRangeParams = {
  pluginId: string;
  namespace: string;
  keyStartInclusive: string;
  keyEndExclusive: string;
  limit: number;
  order?: "asc" | "desc";
  env?: NodeJS.ProcessEnv;
};

function createAzureSqlAdminBridge(
  params: { pluginId: string; namespace: string; env?: NodeJS.ProcessEnv },
  runtimeConfig?: DeepReadonly<OpenClawConfig>,
): AzureSqlPluginStateSyncBridge | undefined {
  const config = resolvePluginStateConfig(runtimeConfig ? { config: runtimeConfig } : undefined);
  return resolveStorageBackend(config) === "azuresql"
    ? new AzureSqlPluginStateSyncBridge(config, params.env ?? process.env, {
        pluginId: params.pluginId,
        namespace: params.namespace,
        maxEntries: MAX_PLUGIN_STATE_ENTRIES_PER_PLUGIN,
        overflowPolicy: "evict-oldest",
      })
    : undefined;
}

export function pluginStateEntriesInKeyRange(
  params: PluginStateKeyRangeParams,
): PluginStateEntry<unknown>[] {
  const bridge = createAzureSqlAdminBridge(params);
  if (!bridge) {
    return pluginStateEntriesInKeyRangeSqlite(params);
  }
  if (!Number.isSafeInteger(params.limit) || params.limit < 1) {
    throw invalidInput("Plugin state key-range limit must be a positive safe integer.", "entries");
  }
  if (params.keyStartInclusive >= params.keyEndExclusive) {
    throw invalidInput(
      "Plugin state key range must have an increasing exclusive upper bound.",
      "entries",
    );
  }
  return bridge.entriesInKeyRange(params).map((entry) => {
    let value: unknown;
    try {
      value = JSON.parse(entry.valueJson) as unknown;
    } catch (error) {
      throw new PluginStateStoreError("Plugin state entry contains corrupt JSON.", {
        code: "PLUGIN_STATE_CORRUPT",
        operation: "entries",
        cause: error,
      });
    }
    return {
      key: entry.key,
      value,
      createdAt: entry.createdAt,
      ...(entry.expiresAt === null ? {} : { expiresAt: entry.expiresAt }),
    };
  });
}

export function pluginStateDoctorEntriesInKeyRange(
  params: {
    pluginId: string;
    namespace: string;
    prefix: string;
    after?: string;
    limit: number;
    env?: NodeJS.ProcessEnv;
  },
  runtimeConfig?: DeepReadonly<OpenClawConfig>,
): PluginDoctorRawStateEntry[] {
  const bridge = createAzureSqlAdminBridge(params, runtimeConfig);
  if (!bridge) {
    return pluginStateDoctorEntriesInKeyRangeSqlite(params);
  }
  if (
    !params.prefix ||
    !Number.isSafeInteger(params.limit) ||
    params.limit < 1 ||
    params.limit > MAX_PLUGIN_STATE_BULK_DELETE_ENTRIES ||
    (params.after !== undefined && !params.after.startsWith(params.prefix))
  ) {
    throw new RangeError(
      `Plugin doctor state reads require a valid prefix and a limit of 1-${MAX_PLUGIN_STATE_BULK_DELETE_ENTRIES}.`,
    );
  }
  return bridge
    .entriesInKeyRange({
      keyStartInclusive: params.after === undefined ? params.prefix : `${params.after}\0`,
      keyEndExclusive: `${params.prefix}\uffff`,
      limit: params.limit,
    })
    .map((entry) => {
      const result: PluginDoctorRawStateEntry = {
        key: entry.key,
        valueJson: entry.valueJson,
        createdAt: entry.createdAt,
        expiresAt: entry.expiresAt,
      };
      try {
        result.value = JSON.parse(entry.valueJson) as unknown;
      } catch {
        // Doctor must retain corrupt rows so repair can advance past them.
      }
      return result;
    });
}

export function countPluginStateLiveEntries(pluginId: string, env?: NodeJS.ProcessEnv): number {
  const bridge = createAzureSqlAdminBridge({ pluginId, namespace: "capacity", env });
  return bridge ? bridge.countLiveEntries() : countPluginStateLiveEntriesSqlite(pluginId, env);
}

export function getPluginStateCapacity(
  pluginId: string,
  env?: NodeJS.ProcessEnv,
  runtimeConfig?: DeepReadonly<OpenClawConfig>,
): { liveEntries: number; maxEntries: number } {
  const bridge = createAzureSqlAdminBridge({ pluginId, namespace: "capacity", env }, runtimeConfig);
  return bridge
    ? { liveEntries: bridge.countLiveEntries(), maxEntries: MAX_PLUGIN_STATE_ENTRIES_PER_PLUGIN }
    : getPluginStateCapacitySqlite(pluginId, env);
}

export function sweepExpiredPluginStateEntries(): number {
  const bridge = createAzureSqlAdminBridge({ pluginId: "core:sweep", namespace: "expiry" });
  return bridge ? bridge.sweepExpired() : sweepExpiredPluginStateEntriesSqlite();
}

type PluginStateDoctorDeleteParams = {
  pluginId: string;
  namespace: string;
  entries: readonly PluginDoctorRawStateEntry[];
  assertOwnedInTransaction: Parameters<
    typeof pluginStateDeleteEntriesIfUnchangedSqlite
  >[0]["assertOwnedInTransaction"];
  env?: NodeJS.ProcessEnv;
};

export function pluginStateDeleteEntriesIfUnchanged(params: PluginStateDoctorDeleteParams): {
  deleted: number;
  changed: number;
} {
  return pluginStateDeleteEntriesIfUnchangedSqlite(params);
}

export async function pluginStateDeleteEntriesIfUnchangedAsync(
  params: PluginStateDoctorDeleteParams & { assertCurrent: () => void },
  runtimeConfig?: DeepReadonly<OpenClawConfig>,
): Promise<{ deleted: number; changed: number }> {
  if (params.entries.length > MAX_PLUGIN_STATE_BULK_DELETE_ENTRIES) {
    throw new RangeError(
      `Plugin state bulk deletion cannot exceed ${MAX_PLUGIN_STATE_BULK_DELETE_ENTRIES} entries.`,
    );
  }
  if (params.entries.length === 0) {
    return { deleted: 0, changed: 0 };
  }
  const config = resolvePluginStateConfig(runtimeConfig ? { config: runtimeConfig } : undefined);
  if (resolveStorageBackend(config) !== "azuresql") {
    return pluginStateDeleteEntriesIfUnchanged(params);
  }
  const [{ createAzureSqlPluginStateStore }, { resolvePluginStateRuntimeOptions }] =
    await Promise.all([
      import("../storage/plugin-state-store-factory.js"),
      import("../storage/plugin-state-runtime-options.js"),
    ]);
  const store = createAzureSqlPluginStateStore(
    await resolvePluginStateRuntimeOptions(config, params.env ?? process.env),
  );
  return await store.deleteEntriesIfUnchanged(
    {
      pluginId: params.pluginId,
      namespace: params.namespace,
      maxEntries: MAX_PLUGIN_STATE_ENTRIES_PER_PLUGIN,
      overflowPolicy: "evict-oldest",
    },
    params.entries.map(({ value: _value, ...entry }) => entry),
    params.assertCurrent,
  );
}

export async function closePluginStateAzureSqlRuntime(): Promise<void> {
  await closePluginStateSyncBridgeWorker();
  const { closePluginStateAzureSqlDatabases } =
    await import("../storage/plugin-state-store-factory.js");
  await closePluginStateAzureSqlDatabases();
}

/** Clears plugin-state rows and option signatures for tests. */
function clearPluginStateStoreForTests(): void {
  clearPluginStateDatabaseForTests();
  optionPolicy.clear();
}

/** Resets plugin-state module/database state for isolated tests. */
export function resetPluginStateStoreForTests(options: { closeDatabase?: boolean } = {}): void {
  if (options.closeDatabase !== false) {
    closePluginStateDatabase();
    closeOpenClawStateDatabaseForTest();
  }
  optionPolicy.clear();
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.pluginStateStoreTestApi")] = {
    clearPluginStateStoreForTests,
  };
}
