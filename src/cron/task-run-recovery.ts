import type { JsonValue, TaskRecord } from "../tasks/task-registry.types.js";
import { createCronExecutionId } from "./run-id.js";
import type { CronRunLogEntry } from "./run-log-types.js";
import {
  cronTaskRecordStoreKey,
  cronTaskRecordToRunLogEntry,
  cronTaskRecordToScriptRunResult,
  cronTaskRecordToTriggerEval,
  resolveCronTaskRecordTimestamp,
} from "./task-run-detail.js";
import type { CronRunStatus } from "./types.js";

export function findLatestCronTaskRunForRecoveryFromRecords(
  records: readonly TaskRecord[],
  jobId: string,
  startedAt: number,
  storeKey: string,
  receiptId?: string,
): TaskRecord | undefined {
  const executionRunId = createCronExecutionId(jobId, startedAt);
  const prefix = `${executionRunId}:`;
  const receiptRunId = receiptId ? `${prefix}${receiptId}` : undefined;
  return records
    .filter((task) => {
      if (task.runtime !== "cron" || task.sourceId !== jobId) {
        return false;
      }
      const taskStoreKey = cronTaskRecordStoreKey(task);
      if (receiptRunId) {
        return (
          taskStoreKey === storeKey &&
          (task.runId === receiptRunId || task.runId?.startsWith(`${receiptRunId}:`))
        );
      }
      if (taskStoreKey === undefined) {
        return task.runId === executionRunId;
      }
      return (
        taskStoreKey === storeKey &&
        (task.runId === executionRunId || task.runId?.startsWith(prefix))
      );
    })
    .toSorted(
      (left, right) =>
        Number(left.endedAt !== undefined) - Number(right.endedAt !== undefined) ||
        resolveCronTaskRecordTimestamp(right) - resolveCronTaskRecordTimestamp(left) ||
        right.createdAt - left.createdAt ||
        right.taskId.localeCompare(left.taskId),
    )[0];
}

export type FinalizedCronTaskRun = {
  entry: CronRunLogEntry & { status: CronRunStatus };
  scriptResult?: { scriptStateChanged: true; scriptState?: JsonValue };
  triggerEval?: { fired: boolean; stateChanged: boolean; state?: JsonValue };
};

export function finalizedCronTaskRun(
  task: TaskRecord | undefined,
  jobId: string,
): FinalizedCronTaskRun | undefined {
  if (task?.runtime !== "cron" || task.sourceId !== jobId || task.endedAt === undefined) {
    return undefined;
  }
  const triggerEval = cronTaskRecordToTriggerEval(task);
  const storedEntry = cronTaskRecordToRunLogEntry(task);
  const entry =
    storedEntry ??
    (task.status === "succeeded" && triggerEval?.fired === false
      ? {
          ts: task.endedAt,
          jobId,
          action: "finished" as const,
          status: "ok" as const,
          ...(task.startedAt === undefined
            ? {}
            : {
                runAtMs: task.startedAt,
                durationMs: Math.max(0, task.endedAt - task.startedAt),
              }),
        }
      : undefined);
  if (!entry?.status) {
    return undefined;
  }
  const scriptResult = cronTaskRecordToScriptRunResult(task);
  return {
    entry: { ...entry, status: entry.status },
    ...(scriptResult ? { scriptResult } : {}),
    ...(triggerEval ? { triggerEval } : {}),
  };
}
