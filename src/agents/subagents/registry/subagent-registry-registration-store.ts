import { runOpenClawStateWriteTransaction } from "../../../state/openclaw-state-db.js";
import { readTaskBackingInstance } from "../../../tasks/task-backing-authority.js";
import {
  publishPreparedTaskRecordCreation,
  type PreparedTaskRecordCreation,
} from "../../../tasks/task-registry-record-api.js";
import {
  bindTaskDeliveryState,
  bindTaskRecord,
  upsertTaskDeliveryStateRowInDatabase,
  upsertTaskRunRowInDatabase,
} from "../../../tasks/task-registry.store.sqlite.js";
import type { TaskRecord } from "../../../tasks/task-registry.types.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { publishSubagentRunsAfterAtomicStore } from "./subagent-registry-state.js";
import {
  bindSubagentRunRecord,
  upsertSubagentRunRowInDatabase,
} from "./subagent-registry.store.sqlite.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

function assertRegistrationCorrelation(
  entry: SubagentRunRecord,
  prepared: Extract<PreparedTaskRecordCreation, { kind: "create" }>,
): void {
  const task = prepared.record;
  const backing = readTaskBackingInstance(task.detail);
  if (
    backing?.runtime !== "subagent" ||
    backing.generation !== entry.generation ||
    task.runtime !== "subagent" ||
    task.runId !== (entry.taskRunId ?? entry.runId) ||
    task.ownerKey !== entry.requesterSessionKey ||
    task.childSessionKey !== entry.childSessionKey ||
    (task.status !== "queued" && task.status !== "running")
  ) {
    throw new Error("subagent registration and task do not share one owner generation");
  }
}

/** Commits required registry and task ownership, then releases their process-local observers. */
export function commitSubagentTaskRegistration(params: {
  runs: Map<string, SubagentRunRecord>;
  changedRunIds: readonly string[];
  entry: SubagentRunRecord;
  task: Extract<PreparedTaskRecordCreation, { kind: "create" }>;
  isCurrent: (task: TaskRecord) => boolean;
}): { task: TaskRecord; retainedOwnership: boolean } {
  assertRegistrationCorrelation(params.entry, params.task);
  const runRows = params.changedRunIds.flatMap((runId) => {
    const entry = params.runs.get(runId);
    return entry ? [bindSubagentRunRecord(entry)] : [];
  });
  const taskRow = bindTaskRecord(params.task.record);
  const deliveryRow = params.task.deliveryState
    ? bindTaskDeliveryState(params.task.deliveryState)
    : undefined;

  runOpenClawStateWriteTransaction(
    (database) => {
      for (const row of runRows) {
        upsertSubagentRunRowInDatabase(database, row);
      }
      upsertTaskRunRowInDatabase(database, taskRow);
      if (deliveryRow) {
        upsertTaskDeliveryStateRowInDatabase(database.db, deliveryRow);
      }
    },
    undefined,
    { operationLabel: "subagent task registration" },
  );

  // Observer callbacks can synchronously reenter cancellation and wait paths.
  // Publish ownership and both caches before releasing either callback.
  subagentRuns.commitOwnership(params.entry);
  const deferredObserverEvents: Array<() => void> = [];
  publishSubagentRunsAfterAtomicStore(params.runs, params.changedRunIds, deferredObserverEvents, {
    isCurrent: () => params.isCurrent(params.task.record),
  });
  const task = publishPreparedTaskRecordCreation(params.task, deferredObserverEvents);
  for (const emitObserverEvent of deferredObserverEvents) {
    if (!params.isCurrent(task)) {
      return { task, retainedOwnership: false };
    }
    emitObserverEvent();
  }
  return { task, retainedOwnership: params.isCurrent(task) };
}
