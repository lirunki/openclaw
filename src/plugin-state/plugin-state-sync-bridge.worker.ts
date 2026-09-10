import { resolvePluginStateRuntimeOptions } from "../storage/plugin-state-runtime-options.js";
import {
  closePluginStateAzureSqlDatabases,
  createAzureSqlPluginStateStore,
} from "../storage/plugin-state-store-factory.js";
import { PluginStateStoreError } from "./plugin-state-store.types.js";
import type {
  PluginStateBridgeEnvelope,
  PluginStateBridgeError,
  PluginStateBridgeResponse,
} from "./plugin-state-sync-bridge.shared.js";

function serializeError(error: unknown): PluginStateBridgeError {
  if (error instanceof PluginStateStoreError) {
    return {
      name: error.name,
      message: error.message,
      code: error.code,
      operation: error.operation,
    };
  }
  return {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
  };
}

async function handleRequest(envelope: PluginStateBridgeEnvelope): Promise<unknown> {
  const options = await resolvePluginStateRuntimeOptions(envelope.config, envelope.env);
  const store = createAzureSqlPluginStateStore(options);
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
      return results.map((result) =>
        result.ok ? result : { ok: false as const, error: serializeError(result.error) },
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

async function readInput(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

let response: PluginStateBridgeResponse;
try {
  const input = await readInput();
  // SAFETY: the parent bridge is the only caller and validates the protocol before serialization.
  const envelope = JSON.parse(input) as PluginStateBridgeEnvelope;
  response = { ok: true, value: await handleRequest(envelope) };
} catch (error) {
  response = { ok: false, error: serializeError(error) };
}
try {
  await closePluginStateAzureSqlDatabases();
} catch (error) {
  if (response.ok) {
    response = { ok: false, error: serializeError(error) };
  }
}
process.stdout.write(JSON.stringify(response));
