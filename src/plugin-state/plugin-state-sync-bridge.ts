import { spawnSync } from "node:child_process";
import type { Result } from "@openclaw/normalization-core/result";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import type {
  AzureSqlPluginStateRawEntry,
  AzureSqlPluginStateRegisterInput,
  AzureSqlPluginStateScope,
} from "../storage/azure-sql/plugin-state-store.js";
import { PluginStateStoreError, type PluginStateEntry } from "./plugin-state-store.types.js";
import type {
  PluginStateBridgeError,
  PluginStateBridgeLookupResult,
  PluginStateBridgeRequest,
  PluginStateBridgeResponse,
} from "./plugin-state-sync-bridge.shared.js";

const BRIDGE_TIMEOUT_MS = 300_000;
const BRIDGE_MAX_OUTPUT_BYTES = 256 * 1024 * 1024;
const UPDATE_RETRY_LIMIT = 100;

function restoreError(error: PluginStateBridgeError): Error {
  if (error.code && error.operation) {
    return new PluginStateStoreError(error.message, {
      code: error.code,
      operation: error.operation,
    });
  }
  const restored = new Error(error.message);
  restored.name = error.name;
  return restored;
}

function parseResponse(raw: string): Extract<PluginStateBridgeResponse, { ok: true }> {
  let response: PluginStateBridgeResponse;
  try {
    // SAFETY: the bridge subprocess emits exactly one JSON protocol response on stdout.
    response = JSON.parse(raw) as PluginStateBridgeResponse;
  } catch (error) {
    throw new PluginStateStoreError("Azure SQL plugin-state bridge returned an invalid response.", {
      code: "PLUGIN_STATE_OPEN_FAILED",
      operation: "open",
      cause: error,
    });
  }
  if (!response.ok) {
    throw restoreError(response.error);
  }
  return response;
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
    const workerUrl = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.pluginStateSyncBridge);
    const child = spawnSync(process.execPath, resolveRuntimeWorkerArgv(workerUrl), {
      input: JSON.stringify({ config: this.config, env: this.env, request }),
      encoding: "utf8",
      maxBuffer: BRIDGE_MAX_OUTPUT_BYTES,
      timeout: BRIDGE_TIMEOUT_MS,
      windowsHide: true,
      // Device-code authentication publishes its operator prompt on stderr.
      stdio: ["pipe", "pipe", "inherit"],
    });
    if (child.error || child.status !== 0) {
      throw new PluginStateStoreError("Azure SQL plugin-state bridge process failed.", {
        code: "PLUGIN_STATE_OPEN_FAILED",
        operation: "open",
        cause: child.error,
      });
    }
    // SAFETY: each request fixes its response type at the bridge call site.
    return parseResponse(child.stdout).value as T;
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
  // Each compatibility call owns and joins its subprocess before returning.
}
