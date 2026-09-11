import { isDeepStrictEqual } from "node:util";
import {
  deleteCronJobRowInDatabase,
  loadedCronStoreFromRows,
  loadCronRows,
  upsertCronJobRow,
} from "../../cron/store/row-codec.js";
import {
  findActiveCronRunReceiptInDatabase,
  findCronRunReceiptByIdInDatabase,
  finishCronRunReceiptInDatabase,
  type CronRunReceipt,
} from "../../cron/store/run-receipt-store.js";
import { findLatestCronTaskRunForRecoveryFromRecords } from "../../cron/task-run-recovery.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import {
  bindTaskRecord,
  listTaskRecordsByRuntimeSourceIdInDatabase,
} from "../../tasks/task-registry.store.sqlite.js";
import type { TaskRecord } from "../../tasks/task-registry.types.js";
import { isValidRecoverCronRunCommand } from "../task-cohort-command-validation.js";
import { isValidTaskCohortOperation } from "../task-cohort-operation.js";
import type {
  CronRunRecoverySelector,
  CronRunRecoverySnapshot,
  RecoverCronRunCommand,
  RecoverCronRunResult,
  TaskCohortMutationOptions,
} from "../task-cohort-store.js";

function taskRecordsEqual(left: TaskRecord | null | undefined, right: TaskRecord | null): boolean {
  if (!left || !right) {
    return left == null && right === null;
  }
  return isDeepStrictEqual(bindTaskRecord(left), bindTaskRecord(right));
}

function cronRunRecoverySnapshot(
  database: OpenClawStateDatabase,
  selector: CronRunRecoverySelector,
): CronRunRecoverySnapshot {
  const rows = loadCronRows(database.db, selector.storeKey, new Set([selector.jobId]));
  const row = rows[0];
  const job = row ? loadedCronStoreFromRows([row]).store.jobs[0] : undefined;
  const task = findLatestCronTaskRunForRecoveryFromRecords(
    listTaskRecordsByRuntimeSourceIdInDatabase(database.db, "cron", selector.jobId),
    selector.jobId,
    selector.startedAt,
    selector.storeKey,
    selector.receiptId,
  );
  return {
    job: row && job ? { job, sortOrder: row.sort_order } : null,
    receipt:
      findActiveCronRunReceiptInDatabase({
        database: database.db,
        storeKey: selector.storeKey,
        jobId: selector.jobId,
      }) ?? null,
    task: task ?? null,
  };
}

function receiptCompletionMatches(
  receipt: CronRunReceipt | undefined,
  completion: RecoverCronRunCommand["next"]["receipt"],
): boolean {
  if (!completion) {
    return receipt === undefined;
  }
  const { handle } = completion;
  return (
    receipt?.receiptId === handle.receiptId &&
    receipt.storeKey === handle.storeKey &&
    receipt.jobId === handle.jobId &&
    receipt.configRevision === handle.configRevision &&
    receipt.agentId === handle.agentId &&
    receipt.ownerPid === handle.ownerPid &&
    receipt.ownerStartTime === handle.ownerStartTime &&
    receipt.startedAtMs === handle.startedAtMs &&
    receipt.status === completion.status &&
    receipt.finishedAtMs === completion.finishedAtMs &&
    receipt.error === completion.error
  );
}

export function inspectSqliteCronRunRecovery(
  selector: CronRunRecoverySelector,
  options: OpenClawStateDatabaseOptions,
): CronRunRecoverySnapshot {
  return cronRunRecoverySnapshot(openOpenClawStateDatabase(options), selector);
}

export function recoverSqliteCronRun(
  command: RecoverCronRunCommand,
  mutationOptions: TaskCohortMutationOptions,
  databaseOptions: OpenClawStateDatabaseOptions,
): RecoverCronRunResult {
  if (!isValidTaskCohortOperation("recover-cron-run", command)) {
    return {
      operationId: command.operationId,
      status: "conflict",
      reason: "operation-id-mismatch",
    };
  }
  if (!isValidRecoverCronRunCommand(command)) {
    return { operationId: command.operationId, status: "conflict", reason: "invalid-command" };
  }
  return runOpenClawStateWriteTransaction(
    (database): RecoverCronRunResult => {
      const current = cronRunRecoverySnapshot(database, command.selector);
      const terminalReceipt = command.next.receipt
        ? findCronRunReceiptByIdInDatabase(database.db, command.next.receipt.handle.receiptId)
        : undefined;
      const nextMatches =
        isDeepStrictEqual(current.job, command.next.job) &&
        taskRecordsEqual(current.task, command.next.task) &&
        current.receipt === null &&
        receiptCompletionMatches(terminalReceipt, command.next.receipt);
      if (nextMatches) {
        return { operationId: command.operationId, status: "already-applied", state: command.next };
      }
      if (mutationOptions.mode === "reconcile") {
        return {
          operationId: command.operationId,
          status: "outcome-unknown",
          reason: "postcondition-not-proven",
        };
      }
      if (!isDeepStrictEqual(current.job, command.expected.job)) {
        return { operationId: command.operationId, status: "conflict", reason: "job-changed" };
      }
      if (!isDeepStrictEqual(current.receipt, command.expected.receipt)) {
        return { operationId: command.operationId, status: "conflict", reason: "receipt-changed" };
      }
      if (!taskRecordsEqual(current.task, command.expected.task)) {
        return {
          operationId: command.operationId,
          status: "conflict",
          reason: "task-recovery-changed",
        };
      }
      if (command.next.job) {
        upsertCronJobRow(
          database.db,
          command.selector.storeKey,
          command.next.job.job,
          command.next.job.sortOrder,
        );
      } else if (command.expected.job) {
        deleteCronJobRowInDatabase(database.db, command.selector.storeKey, command.selector.jobId);
      }
      if (command.next.receipt) {
        const completion = command.next.receipt;
        const receipt = finishCronRunReceiptInDatabase({
          database: database.db,
          handle: completion.handle,
          status: completion.status,
          finishedAtMs: completion.finishedAtMs,
          ...(completion.error === undefined ? {} : { error: completion.error }),
        });
        if (!receiptCompletionMatches(receipt, completion)) {
          throw new Error("cron run recovery receipt changed during commit");
        }
      }
      return { operationId: command.operationId, status: "applied", state: command.next };
    },
    databaseOptions,
    { operationLabel: "task.cohort.recover-cron-run" },
  );
}
