import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  AzureSqlPluginStateRawEntry,
  AzureSqlPluginStateRegisterInput,
  AzureSqlPluginStateScope,
} from "../storage/azure-sql/plugin-state-store.js";
import type {
  PluginStateEntry,
  PluginStateStoreErrorCode,
  PluginStateStoreOperation,
} from "./plugin-state-store.types.js";

export type PluginStateBridgeError = {
  name: string;
  message: string;
  code?: PluginStateStoreErrorCode;
  operation?: PluginStateStoreOperation;
};

export type PluginStateBridgeLookupResult =
  | { ok: true; value?: unknown }
  | { ok: false; error: PluginStateBridgeError };

export type PluginStateBridgeRequest =
  | {
      operation: "register";
      scope: AzureSqlPluginStateScope;
      input: AzureSqlPluginStateRegisterInput;
    }
  | {
      operation: "registerIfAbsent";
      scope: AzureSqlPluginStateScope;
      input: AzureSqlPluginStateRegisterInput;
    }
  | { operation: "lookupRaw"; scope: AzureSqlPluginStateScope; key: string }
  | {
      operation: "entriesInKeyRange";
      scope: AzureSqlPluginStateScope;
      keyStartInclusive: string;
      keyEndExclusive: string;
      limit: number;
      order?: "asc" | "desc";
    }
  | { operation: "countLiveEntries"; scope: AzureSqlPluginStateScope }
  | { operation: "sweepExpired"; scope: AzureSqlPluginStateScope }
  | {
      operation: "importBatch";
      scope: AzureSqlPluginStateScope;
      entries: AzureSqlPluginStateRegisterInput[];
    }
  | { operation: "lookupMany"; scope: AzureSqlPluginStateScope; keys: string[] }
  | { operation: "consume"; scope: AzureSqlPluginStateScope; key: string }
  | { operation: "delete"; scope: AzureSqlPluginStateScope; key: string }
  | { operation: "entries"; scope: AzureSqlPluginStateScope }
  | { operation: "clear"; scope: AzureSqlPluginStateScope }
  | {
      operation: "appendSequencedJournalEntry";
      scope: AzureSqlPluginStateScope;
      journalScope: AzureSqlPluginStateScope;
      expected?: AzureSqlPluginStateRawEntry;
      cursor: AzureSqlPluginStateRegisterInput;
      journal: AzureSqlPluginStateRegisterInput;
    }
  | {
      operation: "compareAndSet";
      scope: AzureSqlPluginStateScope;
      expected?: AzureSqlPluginStateRawEntry;
      input: AzureSqlPluginStateRegisterInput;
    }
  | {
      operation: "deleteIfUnchanged";
      scope: AzureSqlPluginStateScope;
      expected: AzureSqlPluginStateRawEntry;
    };

export type PluginStateBridgeValue =
  | undefined
  | boolean
  | unknown
  | AzureSqlPluginStateRawEntry
  | PluginStateBridgeLookupResult[]
  | PluginStateEntry<unknown>[]
  | "applied"
  | "conflict";

export type PluginStateBridgeResponse =
  | { ok: true; value?: PluginStateBridgeValue }
  | { ok: false; error: PluginStateBridgeError };

export type PluginStateBridgeEnvelope = {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  request: PluginStateBridgeRequest;
};
