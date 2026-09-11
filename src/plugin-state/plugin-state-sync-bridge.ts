import type { Result } from "@openclaw/normalization-core/result";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  AzureSqlPluginStateRawEntry,
  AzureSqlPluginStateRegisterInput,
  AzureSqlPluginStateScope,
} from "../storage/azure-sql/plugin-state-store.js";
import type { SerializedStorageSyncBridgeError } from "../storage/storage-sync-bridge-protocol.js";
import {
  closeStorageSyncBridge,
  requestStorageSyncBridge,
  StorageSyncBridgeOutcomeUnknownError,
  StorageSyncBridgeRemoteError,
} from "../storage/storage-sync-bridge.js";
import {
  PluginStateStoreError,
  type PluginStateEntry,
  type PluginStateStoreErrorCode,
  type PluginStateStoreOperation,
} from "./plugin-state-store.types.js";
import type {
  PluginStateBridgeEnvelope,
  PluginStateBridgeLookupResult,
  PluginStateBridgeRequest,
} from "./plugin-state-sync-bridge.shared.js";

const UPDATE_RETRY_LIMIT = 100;

function isPluginStateErrorCode(value: string): value is PluginStateStoreErrorCode {
  return [
    "PLUGIN_STATE_SQLITE_UNAVAILABLE",
    "PLUGIN_STATE_OPEN_FAILED",
    "PLUGIN_STATE_WRITE_FAILED",
    "PLUGIN_STATE_READ_FAILED",
    "PLUGIN_STATE_CORRUPT",
    "PLUGIN_STATE_LIMIT_EXCEEDED",
    "PLUGIN_STATE_INVALID_INPUT",
  ].includes(value);
}

function isPluginStateOperation(value: string): value is PluginStateStoreOperation {
  return [
    "load-sqlite",
    "open",
    "ensure-schema",
    "register",
    "lookup",
    "consume",
    "delete",
    "entries",
    "clear",
    "sweep",
    "probe",
    "close",
  ].includes(value);
}

function restoreError(error: SerializedStorageSyncBridgeError): Error {
  if (
    error.code &&
    error.operation &&
    isPluginStateErrorCode(error.code) &&
    isPluginStateOperation(error.operation)
  ) {
    return new PluginStateStoreError(error.message, {
      code: error.code,
      operation: error.operation,
    });
  }
  const restored = new Error(error.message);
  restored.name = error.name;
  return restored;
}

function timeoutFailureForRequest(request: PluginStateBridgeRequest): {
  code: PluginStateStoreErrorCode;
  operation: PluginStateStoreOperation;
} {
  switch (request.operation) {
    case "lookupRaw":
    case "lookupMany":
      return { code: "PLUGIN_STATE_READ_FAILED", operation: "lookup" };
    case "entriesInKeyRange":
    case "entries":
    case "countLiveEntries":
      return { code: "PLUGIN_STATE_READ_FAILED", operation: "entries" };
    case "consume":
      return { code: "PLUGIN_STATE_WRITE_FAILED", operation: "consume" };
    case "delete":
    case "deleteIfUnchanged":
      return { code: "PLUGIN_STATE_WRITE_FAILED", operation: "delete" };
    case "clear":
      return { code: "PLUGIN_STATE_WRITE_FAILED", operation: "clear" };
    case "sweepExpired":
      return { code: "PLUGIN_STATE_WRITE_FAILED", operation: "sweep" };
    case "register":
    case "registerIfAbsent":
    case "importBatch":
    case "appendSequencedJournalEntry":
    case "compareAndSet":
      return { code: "PLUGIN_STATE_WRITE_FAILED", operation: "register" };
  }
}

function parseRaw<T>(raw: AzureSqlPluginStateRawEntry, operation: "lookup" | "consume"): T {
  try {
    // SAFETY: JSON decoding is the runtime boundary for the caller-owned namespace type.
    return JSON.parse(raw.valueJson) as T;
  } catch (error) {
    throw new PluginStateStoreError("Plugin state entry contains corrupt JSON.", {
      code: "PLUGIN_STATE_CORRUPT",
      operation,
      cause: error,
    });
  }
}

export class AzureSqlPluginStateSyncBridge {
  constructor(
    private readonly config: OpenClawConfig,
    private readonly env: NodeJS.ProcessEnv,
    private readonly scope: AzureSqlPluginStateScope,
  ) {}

  private request<T>(request: PluginStateBridgeRequest): T {
    try {
      return requestStorageSyncBridge<T>({
        domain: "plugin-state",
        payload: {
          config: this.config,
          env: this.env,
          request,
        } satisfies PluginStateBridgeEnvelope,
      });
    } catch (error) {
      if (error instanceof StorageSyncBridgeRemoteError) {
        throw restoreError(error.remote);
      }
      if (error instanceof StorageSyncBridgeOutcomeUnknownError) {
        throw new PluginStateStoreError(error.message, {
          ...timeoutFailureForRequest(request),
          cause: error,
        });
      }
      throw new PluginStateStoreError("Azure SQL plugin-state bridge worker failed.", {
        code: "PLUGIN_STATE_OPEN_FAILED",
        operation: "open",
        cause: error,
      });
    }
  }

  register(input: AzureSqlPluginStateRegisterInput): void {
    this.request<void>({ operation: "register", scope: this.scope, input });
  }

  registerIfAbsent(input: AzureSqlPluginStateRegisterInput): boolean {
    return this.request<boolean>({ operation: "registerIfAbsent", scope: this.scope, input });
  }

  lookupRaw(key: string): AzureSqlPluginStateRawEntry | undefined {
    return this.request<AzureSqlPluginStateRawEntry | undefined>({
      operation: "lookupRaw",
      scope: this.scope,
      key,
    });
  }

  lookup<T>(key: string): T | undefined {
    const raw = this.lookupRaw(key);
    return raw ? parseRaw<T>(raw, "lookup") : undefined;
  }

  entriesInKeyRange(range: {
    keyStartInclusive: string;
    keyEndExclusive: string;
    limit: number;
    order?: "asc" | "desc";
  }): AzureSqlPluginStateRawEntry[] {
    return this.request<AzureSqlPluginStateRawEntry[]>({
      operation: "entriesInKeyRange",
      scope: this.scope,
      ...range,
    });
  }

  countLiveEntries(): number {
    return this.request<number>({ operation: "countLiveEntries", scope: this.scope });
  }

  sweepExpired(): number {
    return this.request<number>({ operation: "sweepExpired", scope: this.scope });
  }

  importBatch(entries: readonly AzureSqlPluginStateRegisterInput[]): void {
    this.request<void>({ operation: "importBatch", scope: this.scope, entries: [...entries] });
  }

  lookupMany<T>(keys: readonly string[]): Array<Result<T | undefined, PluginStateStoreError>> {
    const results = this.request<PluginStateBridgeLookupResult[]>({
      operation: "lookupMany",
      scope: this.scope,
      keys: [...keys],
    });
    return results.map((result) => {
      if (result.ok) {
        // SAFETY: each successful value belongs to this typed namespace.
        return { ok: true, value: result.value as T | undefined };
      }
      const restored = restoreError(result.error);
      return {
        ok: false,
        error:
          restored instanceof PluginStateStoreError
            ? restored
            : new PluginStateStoreError(restored.message, {
                code: "PLUGIN_STATE_READ_FAILED",
                operation: "lookup",
                cause: restored,
              }),
      };
    });
  }

  consume<T>(key: string): T | undefined {
    return this.request<T | undefined>({ operation: "consume", scope: this.scope, key });
  }

  delete(key: string): boolean {
    return this.request<boolean>({ operation: "delete", scope: this.scope, key });
  }

  entries<T>(): PluginStateEntry<T>[] {
    return this.request<PluginStateEntry<T>[]>({ operation: "entries", scope: this.scope });
  }

  clear(): void {
    this.request<void>({ operation: "clear", scope: this.scope });
  }

  appendSequencedJournalEntry(params: {
    journalScope: AzureSqlPluginStateScope;
    cursorKey: string;
    initialSequence: number;
    readCursorSequence: (valueJson: string) => number | undefined;
    prepareEntry: (sequence: number) => {
      cursorValueJson: string;
      journalKey: string;
      journalValueJson: string;
    };
  }): number {
    for (let attempt = 0; attempt < UPDATE_RETRY_LIMIT; attempt += 1) {
      const current = this.lookupRaw(params.cursorKey);
      const cursorSequence = current ? params.readCursorSequence(current.valueJson) : undefined;
      const sequence = Math.max(params.initialSequence, cursorSequence ?? 0) + 1;
      if (!Number.isSafeInteger(sequence)) {
        throw new RangeError("Plugin state journal sequence exhausted safe integer range");
      }
      const prepared = params.prepareEntry(sequence);
      const result = this.request<"applied" | "conflict">({
        operation: "appendSequencedJournalEntry",
        scope: this.scope,
        journalScope: params.journalScope,
        expected: current,
        cursor: { key: params.cursorKey, valueJson: prepared.cursorValueJson },
        journal: { key: prepared.journalKey, valueJson: prepared.journalValueJson },
      });
      if (result === "applied") {
        return sequence;
      }
    }
    throw new PluginStateStoreError(
      "Azure SQL plugin-state journal update could not settle because the cursor kept changing.",
      { code: "PLUGIN_STATE_WRITE_FAILED", operation: "register" },
    );
  }

  update(
    key: string,
    updateValueJson: (current: unknown) => { valueJson: string; ttlMs?: number } | undefined,
  ): boolean {
    for (let attempt = 0; attempt < UPDATE_RETRY_LIMIT; attempt += 1) {
      const current = this.lookupRaw(key);
      const next = updateValueJson(current ? parseRaw(current, "lookup") : undefined);
      if (!next) {
        return false;
      }
      const result = this.request<"applied" | "conflict">({
        operation: "compareAndSet",
        scope: this.scope,
        expected: current,
        input: { key, ...next },
      });
      if (result === "applied") {
        return true;
      }
    }
    throw new PluginStateStoreError(
      "Azure SQL plugin-state update could not settle because the entry kept changing.",
      { code: "PLUGIN_STATE_WRITE_FAILED", operation: "register" },
    );
  }

  deleteIf(key: string, predicate: (current: unknown) => boolean): boolean {
    for (let attempt = 0; attempt < UPDATE_RETRY_LIMIT; attempt += 1) {
      const current = this.lookupRaw(key);
      if (!current || !predicate(parseRaw(current, "lookup"))) {
        return false;
      }
      const result = this.request<"applied" | "conflict">({
        operation: "deleteIfUnchanged",
        scope: this.scope,
        expected: current,
      });
      if (result === "applied") {
        return true;
      }
    }
    throw new PluginStateStoreError(
      "Azure SQL plugin-state delete could not settle because the entry kept changing.",
      { code: "PLUGIN_STATE_WRITE_FAILED", operation: "delete" },
    );
  }
}

export async function closePluginStateSyncBridgeWorker(): Promise<void> {
  await closeStorageSyncBridge();
}
