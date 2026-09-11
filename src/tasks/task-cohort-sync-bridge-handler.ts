import { createSqliteTaskCohortStore } from "../storage/sqlite/task-cohort-store.js";
import type { TaskCohortStore } from "../storage/task-cohort-store.js";
import type { TaskCohortBridgeEnvelope } from "./task-cohort-sync-bridge.shared.js";

let activeStore: TaskCohortStore | undefined;
let activeDatabasePath: string | undefined;

async function resolveStore(envelope: TaskCohortBridgeEnvelope): Promise<TaskCohortStore> {
  if (activeStore && activeDatabasePath === envelope.databasePath) {
    return activeStore;
  }
  if (activeStore) {
    await activeStore.close();
  }
  activeDatabasePath = envelope.databasePath;
  activeStore = createSqliteTaskCohortStore(
    envelope.databasePath ? { path: envelope.databasePath } : {},
  );
  return activeStore;
}

export async function handleTaskCohortSyncBridgeRequest(
  envelope: TaskCohortBridgeEnvelope,
): Promise<unknown> {
  const request = envelope.request;
  if (request.operation === "close") {
    await closeTaskCohortSyncBridgeHandler();
    return undefined;
  }
  const store = await resolveStore(envelope);
  switch (request.operation) {
    case "loadSnapshot":
      return await store.loadSnapshot();
    case "inspectReadOnly":
      return await store.inspectReadOnly();
    case "listTasksForOwnerKey":
      return await store.listTasksForOwnerKey(request.ownerKey);
    case "listTasksByRuntimeSource":
      return await store.listTasksByRuntimeSource(request.params);
    case "commitTaskState":
      return await store.commitTaskState(request.command, request.options);
    case "bindTaskExecution":
      return await store.bindTaskExecution(request.command, request.options);
    case "admitSubagentCompletion":
      return await store.admitSubagentCompletion(request.command, request.options);
    case "settleSubagentCompletion":
      return await store.settleSubagentCompletion(request.command, request.options);
    case "blockSubagentCompletion":
      return await store.blockSubagentCompletion(request.command, request.options);
    case "replaceSubagentTask":
      return await store.replaceSubagentTask(request.command, request.options);
    case "inspectCronRunRecovery":
      return await store.inspectCronRunRecovery(request.selector);
    case "recoverCronRun":
      return await store.recoverCronRun(request.command, request.options);
  }
  request satisfies never;
  throw new Error("Unsupported task cohort bridge operation.");
}

export async function closeTaskCohortSyncBridgeHandler(): Promise<void> {
  const store = activeStore;
  activeStore = undefined;
  activeDatabasePath = undefined;
  await store?.close();
}
