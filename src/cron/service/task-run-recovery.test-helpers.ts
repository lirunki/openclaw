import type { DatabaseSync } from "node:sqlite";
import { listTaskRecordsByRuntimeSourceIdInDatabase } from "../../tasks/task-registry.store.sqlite.js";
import {
  finalizedCronTaskRun,
  findLatestCronTaskRunForRecoveryFromRecords,
} from "../task-run-recovery.js";

export function findCronTaskRunRecoveryInDatabase(params: {
  database: DatabaseSync;
  jobId: string;
  startedAt: number;
  storeKey: string;
  receiptId?: string;
}) {
  const task = findLatestCronTaskRunForRecoveryFromRecords(
    listTaskRecordsByRuntimeSourceIdInDatabase(params.database, "cron", params.jobId),
    params.jobId,
    params.startedAt,
    params.storeKey,
    params.receiptId,
  );
  const finalized = finalizedCronTaskRun(task, params.jobId);
  return {
    ...(task?.runId ? { taskRunId: task.runId } : {}),
    ...(finalized ? { finalized } : {}),
  };
}
