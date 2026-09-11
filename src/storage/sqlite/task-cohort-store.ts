import { isDeepStrictEqual } from "node:util";
import {
  bindSubagentRunRecord,
  deleteSubagentRunRowInDatabase,
  readSubagentRun,
  upsertSubagentRunRowInDatabase,
} from "../../agents/subagents/registry/subagent-registry.store.sqlite.js";
import {
  bindExecutionOwnerLifecycleMetadata,
  readExecutionOwnerLifecycleMetadata,
} from "../../audit/execution-owner-lifecycle-binding-store.js";
import { loadSessionEntryReadOnly } from "../../config/sessions/session-accessor.sqlite-entry.js";
import {
  bindDeliveryQueueEntry,
  loadDeliveryQueueEntryInDatabase,
  upsertBoundDeliveryQueueEntryInDatabase,
} from "../../infra/delivery-queue-sqlite-bound.js";
import { SESSION_DELIVERY_QUEUE_NAME } from "../../infra/session-delivery-queue-storage.js";
import {
  closeOpenClawStateDatabaseByPath,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import {
  bindTaskFlowRecord,
  readTaskFlowRecord,
  upsertTaskFlowRowInDatabase,
} from "../../tasks/task-flow-registry.store.sqlite.js";
import {
  bindTaskDeliveryState,
  bindTaskRecord,
  deleteTaskDeliveryStateRowInDatabase,
  deleteTaskRowsWithDeliveryStateInDatabase,
  loadTaskRegistryStateFromSqlite,
  loadTaskRegistryStateFromSqliteReadOnlyResult,
  listTaskRegistryRecordsByOwnerKeyFromSqlite,
  listTaskRegistryRecordsByRuntimeSourceIdFromSqlite,
  readTaskDeliveryState,
  readTaskRecord,
  replaceTaskDeliveryStateRowInDatabase,
  upsertTaskRunRowInDatabase,
} from "../../tasks/task-registry.store.sqlite.js";
import type { TaskDeliveryState, TaskRecord } from "../../tasks/task-registry.types.js";
import {
  isValidAdmitSubagentCompletionCommand,
  isValidBindTaskExecutionCommand,
  isValidBlockSubagentCompletionCommand,
  isValidCommitTaskStateCommand,
  isValidReplaceSubagentTaskCommand,
  isValidSettleSubagentCompletionCommand,
} from "../task-cohort-command-validation.js";
import { isValidTaskCohortOperation } from "../task-cohort-operation.js";
import type {
  AdmitSubagentCompletionCommand,
  AdmitSubagentCompletionResult,
  BindTaskExecutionCommand,
  BindTaskExecutionResult,
  BlockSubagentCompletionCommand,
  BlockSubagentCompletionResult,
  CommitTaskStateCommand,
  CommitTaskStateResult,
  CronRunRecoverySelector,
  CronRunRecoverySnapshot,
  RecoverCronRunCommand,
  RecoverCronRunResult,
  ReplaceSubagentTaskCommand,
  ReplaceSubagentTaskResult,
  SettleSubagentCompletionCommand,
  SettleSubagentCompletionResult,
  SubagentRunChange,
  TaskCohortMutationOptions,
  TaskCohortSnapshot,
  TaskCohortStore,
  TaskCohortTaskState,
} from "../task-cohort-store.js";
import { inspectSqliteCronRunRecovery, recoverSqliteCronRun } from "./task-cohort-cron-recovery.js";

function unknownOutcome(operationId: string) {
  return {
    operationId,
    status: "outcome-unknown" as const,
    reason: "postcondition-not-proven" as const,
  };
}

function invalidOperation(operationId: string) {
  return {
    operationId,
    status: "conflict" as const,
    reason: "operation-id-mismatch" as const,
  };
}

function invalidCommand(operationId: string) {
  return {
    operationId,
    status: "conflict" as const,
    reason: "invalid-command" as const,
  };
}

function readTaskState(db: OpenClawStateDatabase["db"], taskId: string): TaskCohortTaskState {
  const task = readTaskRecord(db, taskId);
  if (!task) {
    return { taskId, task: null, deliveryState: null };
  }
  return {
    taskId,
    task,
    deliveryState: readTaskDeliveryState(db, taskId) ?? null,
  };
}

function writeTaskState(database: OpenClawStateDatabase, state: TaskCohortTaskState): void {
  if (!state.task) {
    deleteTaskRowsWithDeliveryStateInDatabase(database.db, state.taskId);
    return;
  }
  upsertTaskRunRowInDatabase(database, bindTaskRecord(state.task));
  if (state.deliveryState) {
    replaceTaskDeliveryStateRowInDatabase(database.db, bindTaskDeliveryState(state.deliveryState));
  } else {
    deleteTaskDeliveryStateRowInDatabase(database.db, state.taskId);
  }
}

function taskRecordsEqual(left: TaskRecord | null | undefined, right: TaskRecord | null): boolean {
  if (!left || !right) {
    return left == null && right === null;
  }
  return isDeepStrictEqual(bindTaskRecord(left), bindTaskRecord(right));
}

function deliveryStatesEqual(
  left: TaskDeliveryState | null | undefined,
  right: TaskDeliveryState | null,
): boolean {
  if (!left || !right) {
    return left == null && right === null;
  }
  return isDeepStrictEqual(bindTaskDeliveryState(left), bindTaskDeliveryState(right));
}

function taskStatesEqual(left: TaskCohortTaskState, right: TaskCohortTaskState): boolean {
  return (
    left.taskId === right.taskId &&
    taskRecordsEqual(left.task, right.task) &&
    deliveryStatesEqual(left.deliveryState, right.deliveryState)
  );
}

function subagentRecordsEqual(
  left: ReturnType<typeof readSubagentRun>,
  right: SubagentRunChange["expected"],
): boolean {
  if (!left || !right) {
    return left === right;
  }
  return isDeepStrictEqual(bindSubagentRunRecord(left), bindSubagentRunRecord(right));
}

function taskSnapshot(options: OpenClawStateDatabaseOptions): TaskCohortSnapshot {
  const snapshot = loadTaskRegistryStateFromSqlite(options);
  return {
    tasks: [...snapshot.tasks.values()],
    deliveryStates: [...snapshot.deliveryStates.values()].toSorted((left, right) =>
      left.taskId.localeCompare(right.taskId),
    ),
  };
}

function reconcileAcceptedReceipt(
  command: ReplaceSubagentTaskCommand,
  storedSource: NonNullable<ReturnType<typeof readSubagentRun>>,
): void {
  const evidence = command.acceptedRestartReceipt;
  const storedReceipt = storedSource.execution.restartRecovery;
  if (!evidence || (storedReceipt?.phase !== "attempted" && storedReceipt?.phase !== "consumed")) {
    return;
  }
  const receiptIdentityMatches =
    storedReceipt.sessionId === evidence.receipt.sessionId &&
    storedReceipt.sessionMarker === evidence.receipt.sessionMarker &&
    storedReceipt.sessionLifecycleRevision === evidence.receipt.sessionLifecycleRevision &&
    storedReceipt.idempotencyKey === evidence.receipt.idempotencyKey &&
    storedReceipt.lifecycleGeneration === evidence.receipt.lifecycleGeneration;
  const sessionKey = evidence.sessionTarget.sessionKey;
  if (!sessionKey) {
    return;
  }
  const session = loadSessionEntryReadOnly({ ...evidence.sessionTarget, sessionKey });
  if (
    !receiptIdentityMatches ||
    session?.sessionId !== evidence.receipt.sessionId ||
    (evidence.receipt.sessionLifecycleRevision !== undefined &&
      session.lifecycleRevision !== evidence.receipt.sessionLifecycleRevision)
  ) {
    return;
  }
  storedSource.execution.restartRecovery = structuredClone(evidence.receipt);
}

export class SqliteTaskCohortStore implements TaskCohortStore {
  constructor(private readonly options: OpenClawStateDatabaseOptions = {}) {}

  async loadSnapshot(): Promise<TaskCohortSnapshot> {
    return taskSnapshot(this.options);
  }

  async inspectReadOnly(): Promise<{
    state: "ready" | "migration-required";
    snapshot: TaskCohortSnapshot;
  }> {
    const result = loadTaskRegistryStateFromSqliteReadOnlyResult(this.options);
    return {
      state: result.state,
      snapshot: {
        tasks: [...result.snapshot.tasks.values()],
        deliveryStates: [...result.snapshot.deliveryStates.values()].toSorted((left, right) =>
          left.taskId.localeCompare(right.taskId),
        ),
      },
    };
  }

  async listTasksForOwnerKey(ownerKey: string): Promise<TaskRecord[]> {
    return listTaskRegistryRecordsByOwnerKeyFromSqlite(ownerKey, this.options);
  }

  async listTasksByRuntimeSource(
    params: Parameters<TaskCohortStore["listTasksByRuntimeSource"]>[0],
  ): Promise<TaskRecord[]> {
    return listTaskRegistryRecordsByRuntimeSourceIdFromSqlite(params, this.options);
  }

  async commitTaskState(
    command: CommitTaskStateCommand,
    options: TaskCohortMutationOptions,
  ): Promise<CommitTaskStateResult> {
    if (!isValidTaskCohortOperation("commit-task-state", command)) {
      return invalidOperation(command.operationId);
    }
    if (!isValidCommitTaskStateCommand(command)) {
      return invalidCommand(command.operationId);
    }
    return runOpenClawStateWriteTransaction(
      (database): CommitTaskStateResult => {
        const current = readTaskState(database.db, command.expected.taskId);
        if (taskStatesEqual(current, command.next)) {
          return { operationId: command.operationId, status: "already-applied", state: current };
        }
        if (options.mode === "reconcile") {
          return unknownOutcome(command.operationId);
        }
        if (!taskRecordsEqual(current.task, command.expected.task)) {
          return {
            operationId: command.operationId,
            status: "conflict",
            reason: "task-changed",
            current,
          };
        }
        if (!deliveryStatesEqual(current.deliveryState, command.expected.deliveryState)) {
          return {
            operationId: command.operationId,
            status: "conflict",
            reason: "delivery-state-changed",
            current,
          };
        }
        writeTaskState(database, command.next);
        return { operationId: command.operationId, status: "applied", state: command.next };
      },
      this.options,
      { operationLabel: "task.cohort.commit-state" },
    );
  }

  async bindTaskExecution(
    command: BindTaskExecutionCommand,
    options: TaskCohortMutationOptions,
  ): Promise<BindTaskExecutionResult> {
    if (!isValidTaskCohortOperation("bind-task-execution", command)) {
      return invalidOperation(command.operationId);
    }
    if (!isValidBindTaskExecutionCommand(command)) {
      return invalidCommand(command.operationId);
    }
    return runOpenClawStateWriteTransaction(
      ({ db }): BindTaskExecutionResult => {
        const currentTask = readTaskRecord(db, command.expectedTask.taskId);
        const currentBinding = readExecutionOwnerLifecycleMetadata({
          db,
          ownerKind: "task",
          ownerId: command.expectedTask.taskId,
        });
        const taskMatches = taskRecordsEqual(currentTask, command.expectedTask);
        if (taskMatches && isDeepStrictEqual(currentBinding, command.binding)) {
          return {
            operationId: command.operationId,
            status: "already-applied",
            binding: command.binding,
          };
        }
        if (options.mode === "reconcile") {
          return unknownOutcome(command.operationId);
        }
        if (!taskMatches) {
          return { operationId: command.operationId, status: "conflict", reason: "task-changed" };
        }
        if (
          (currentTask?.status !== "queued" && currentTask?.status !== "running") ||
          currentTask.endedAt != null
        ) {
          return {
            operationId: command.operationId,
            status: "conflict",
            reason: "task-ineligible",
          };
        }
        const result = bindExecutionOwnerLifecycleMetadata({
          db,
          ownerKind: "task",
          ownerId: command.expectedTask.taskId,
          binding: command.binding,
        });
        if (result === "mismatch") {
          return {
            operationId: command.operationId,
            status: "conflict",
            reason: "binding-mismatch",
          };
        }
        return {
          operationId: command.operationId,
          status: result === "already-bound" ? "already-applied" : "applied",
          binding: command.binding,
        };
      },
      this.options,
      { operationLabel: "task.cohort.bind-execution" },
    );
  }

  async admitSubagentCompletion(
    command: AdmitSubagentCompletionCommand,
    options: TaskCohortMutationOptions,
  ): Promise<AdmitSubagentCompletionResult> {
    if (!isValidTaskCohortOperation("admit-subagent-completion", command)) {
      return invalidOperation(command.operationId);
    }
    if (!isValidAdmitSubagentCompletionCommand(command)) {
      return invalidCommand(command.operationId);
    }
    return runOpenClawStateWriteTransaction(
      (database): AdmitSubagentCompletionResult => {
        const currentQueue = loadDeliveryQueueEntryInDatabase(
          database,
          SESSION_DELIVERY_QUEUE_NAME,
          command.queueEntry.id,
        );
        const currentSubagent = readSubagentRun(database, command.nextSubagent.runId);
        const currentTask = readTaskRecord(database.db, command.nextTask.taskId);
        if (
          isDeepStrictEqual(currentQueue, command.queueEntry) &&
          subagentRecordsEqual(currentSubagent, command.nextSubagent) &&
          taskRecordsEqual(currentTask, command.nextTask)
        ) {
          return {
            operationId: command.operationId,
            status: "already-applied",
            claimed: false,
            queueEntry: command.queueEntry,
            subagent: command.nextSubagent,
            task: command.nextTask,
          };
        }
        if (options.mode === "reconcile") {
          return unknownOutcome(command.operationId);
        }
        if (currentQueue) {
          return {
            operationId: command.operationId,
            status: "conflict",
            reason: "queue-owner-changed",
          };
        }
        if (
          currentSubagent
            ? !subagentRecordsEqual(currentSubagent, command.expectedSubagent.record)
            : !command.expectedSubagent.allowAbsent
        ) {
          return {
            operationId: command.operationId,
            status: "conflict",
            reason: "subagent-changed",
          };
        }
        if (
          currentTask
            ? !taskRecordsEqual(currentTask, command.expectedTask.record)
            : !command.expectedTask.allowAbsent
        ) {
          return { operationId: command.operationId, status: "conflict", reason: "task-changed" };
        }
        const claimed = upsertBoundDeliveryQueueEntryInDatabase(
          bindDeliveryQueueEntry({
            queueName: SESSION_DELIVERY_QUEUE_NAME,
            entry: command.queueEntry,
            insertOnly: true,
          }),
          database,
        );
        if (!claimed) {
          return {
            operationId: command.operationId,
            status: "conflict",
            reason: "queue-owner-changed",
          };
        }
        upsertSubagentRunRowInDatabase(database, bindSubagentRunRecord(command.nextSubagent));
        upsertTaskRunRowInDatabase(database, bindTaskRecord(command.nextTask));
        return {
          operationId: command.operationId,
          status: "applied",
          claimed: true,
          queueEntry: command.queueEntry,
          subagent: command.nextSubagent,
          task: command.nextTask,
        };
      },
      this.options,
      { operationLabel: "task.cohort.admit-subagent-completion" },
    );
  }

  async settleSubagentCompletion(
    command: SettleSubagentCompletionCommand,
    options: TaskCohortMutationOptions,
  ): Promise<SettleSubagentCompletionResult> {
    if (!isValidTaskCohortOperation("settle-subagent-completion", command)) {
      return invalidOperation(command.operationId);
    }
    if (!isValidSettleSubagentCompletionCommand(command)) {
      return invalidCommand(command.operationId);
    }
    return runOpenClawStateWriteTransaction(
      (database): SettleSubagentCompletionResult => {
        const currentSubagent = readSubagentRun(database, command.expectedSubagent.runId);
        const currentTask = readTaskRecord(database.db, command.expectedTask.taskId);
        if (
          subagentRecordsEqual(currentSubagent, command.nextSubagent) &&
          taskRecordsEqual(currentTask, command.nextTask)
        ) {
          return {
            operationId: command.operationId,
            status: "already-applied",
            subagent: command.nextSubagent,
            task: command.nextTask,
          };
        }
        if (options.mode === "reconcile") {
          return unknownOutcome(command.operationId);
        }
        if (!subagentRecordsEqual(currentSubagent, command.expectedSubagent)) {
          return {
            operationId: command.operationId,
            status: "conflict",
            reason: "subagent-changed",
          };
        }
        if (!taskRecordsEqual(currentTask, command.expectedTask)) {
          return { operationId: command.operationId, status: "conflict", reason: "task-changed" };
        }
        upsertSubagentRunRowInDatabase(database, bindSubagentRunRecord(command.nextSubagent));
        upsertTaskRunRowInDatabase(database, bindTaskRecord(command.nextTask));
        return {
          operationId: command.operationId,
          status: "applied",
          subagent: command.nextSubagent,
          task: command.nextTask,
        };
      },
      this.options,
      { operationLabel: "task.cohort.settle-subagent-completion" },
    );
  }

  async blockSubagentCompletion(
    command: BlockSubagentCompletionCommand,
    options: TaskCohortMutationOptions,
  ): Promise<BlockSubagentCompletionResult> {
    if (!isValidTaskCohortOperation("block-subagent-completion", command)) {
      return invalidOperation(command.operationId);
    }
    if (!isValidBlockSubagentCompletionCommand(command)) {
      return invalidCommand(command.operationId);
    }
    return runOpenClawStateWriteTransaction(
      (database): BlockSubagentCompletionResult => {
        const currentSubagent = readSubagentRun(database, command.expectedSubagent.runId);
        const currentTask = readTaskRecord(database.db, command.expectedTask.taskId);
        const currentQueue = command.queuedDelivery
          ? loadDeliveryQueueEntryInDatabase(
              database,
              SESSION_DELIVERY_QUEUE_NAME,
              command.queuedDelivery.id,
            )
          : null;
        if (
          subagentRecordsEqual(currentSubagent, command.nextSubagent) &&
          taskRecordsEqual(currentTask, command.nextTask) &&
          isDeepStrictEqual(currentQueue, command.queuedDelivery ?? null)
        ) {
          return {
            operationId: command.operationId,
            status: "already-applied",
            subagent: command.nextSubagent,
            task: command.nextTask,
            ...(command.queuedDelivery ? { queuedDelivery: command.queuedDelivery } : {}),
          };
        }
        if (options.mode === "reconcile") {
          return unknownOutcome(command.operationId);
        }
        if (!subagentRecordsEqual(currentSubagent, command.expectedSubagent)) {
          return {
            operationId: command.operationId,
            status: "conflict",
            reason: "subagent-changed",
          };
        }
        if (!taskRecordsEqual(currentTask, command.expectedTask)) {
          return { operationId: command.operationId, status: "conflict", reason: "task-changed" };
        }
        if (currentQueue) {
          return { operationId: command.operationId, status: "conflict", reason: "queue-changed" };
        }
        if (command.queuedDelivery) {
          const claimed = upsertBoundDeliveryQueueEntryInDatabase(
            bindDeliveryQueueEntry({
              queueName: SESSION_DELIVERY_QUEUE_NAME,
              entry: command.queuedDelivery,
              insertOnly: true,
            }),
            database,
          );
          if (!claimed) {
            return {
              operationId: command.operationId,
              status: "conflict",
              reason: "queue-changed",
            };
          }
        }
        upsertSubagentRunRowInDatabase(database, bindSubagentRunRecord(command.nextSubagent));
        upsertTaskRunRowInDatabase(database, bindTaskRecord(command.nextTask));
        return {
          operationId: command.operationId,
          status: "applied",
          subagent: command.nextSubagent,
          task: command.nextTask,
          ...(command.queuedDelivery ? { queuedDelivery: command.queuedDelivery } : {}),
        };
      },
      this.options,
      { operationLabel: "task.cohort.block-subagent-completion" },
    );
  }

  async replaceSubagentTask(
    command: ReplaceSubagentTaskCommand,
    options: TaskCohortMutationOptions,
  ): Promise<ReplaceSubagentTaskResult> {
    if (!isValidTaskCohortOperation("replace-subagent-task", command)) {
      return invalidOperation(command.operationId);
    }
    if (!isValidReplaceSubagentTaskCommand(command)) {
      return invalidCommand(command.operationId);
    }
    return runOpenClawStateWriteTransaction(
      (database): ReplaceSubagentTaskResult => {
        const currentRuns = command.runChanges.map((change) => ({
          change,
          current: readSubagentRun(database, change.runId),
        }));
        const currentTask = readTaskRecord(database.db, command.task.current.taskId);
        const currentFlow = command.flow
          ? readTaskFlowRecord(database.db, command.flow.current.flowId)
          : undefined;
        const nextMatches =
          currentRuns.every(({ change, current }) => subagentRecordsEqual(current, change.next)) &&
          taskRecordsEqual(currentTask, command.task.next) &&
          (!command.flow || isDeepStrictEqual(currentFlow, command.flow.next));
        if (nextMatches) {
          return {
            operationId: command.operationId,
            status: "already-applied",
            runs: command.runChanges.map((change) => ({
              runId: change.runId,
              record: change.next,
            })),
            task: command.task.next,
            ...(command.flow ? { flow: command.flow.next } : {}),
          };
        }
        if (options.mode === "reconcile") {
          return unknownOutcome(command.operationId);
        }
        const sourceEntry = currentRuns.find(({ change }) => change.runId === command.source.runId);
        const storedSource = sourceEntry?.current ?? null;
        if (storedSource) {
          reconcileAcceptedReceipt(command, storedSource);
        }
        if (!subagentRecordsEqual(storedSource, command.source)) {
          return {
            operationId: command.operationId,
            status: "conflict",
            reason: "source-changed",
          };
        }
        if (
          currentRuns.some(({ change, current }) => !subagentRecordsEqual(current, change.expected))
        ) {
          return { operationId: command.operationId, status: "conflict", reason: "run-changed" };
        }
        if (!taskRecordsEqual(currentTask, command.task.current)) {
          return { operationId: command.operationId, status: "conflict", reason: "task-changed" };
        }
        if (command.flow && !isDeepStrictEqual(currentFlow, command.flow.current)) {
          return { operationId: command.operationId, status: "conflict", reason: "flow-changed" };
        }
        for (const change of command.runChanges) {
          if (change.next) {
            upsertSubagentRunRowInDatabase(database, bindSubagentRunRecord(change.next));
          } else {
            deleteSubagentRunRowInDatabase(database, change.runId);
          }
        }
        upsertTaskRunRowInDatabase(database, bindTaskRecord(command.task.next));
        if (command.flow) {
          upsertTaskFlowRowInDatabase(database.db, bindTaskFlowRecord(command.flow.next));
        }
        return {
          operationId: command.operationId,
          status: "applied",
          runs: command.runChanges.map((change) => ({
            runId: change.runId,
            record: change.next,
          })),
          task: command.task.next,
          ...(command.flow ? { flow: command.flow.next } : {}),
        };
      },
      this.options,
      { operationLabel: "task.cohort.replace-subagent-task" },
    );
  }

  async inspectCronRunRecovery(
    selector: CronRunRecoverySelector,
  ): Promise<CronRunRecoverySnapshot> {
    return inspectSqliteCronRunRecovery(selector, this.options);
  }

  async recoverCronRun(
    command: RecoverCronRunCommand,
    options: TaskCohortMutationOptions,
  ): Promise<RecoverCronRunResult> {
    return recoverSqliteCronRun(command, options, this.options);
  }

  async close(): Promise<void> {
    closeOpenClawStateDatabaseByPath(
      this.options.path ?? resolveOpenClawStateSqlitePath(this.options.env ?? process.env),
    );
  }
}

export function createSqliteTaskCohortStore(
  options: OpenClawStateDatabaseOptions = {},
): TaskCohortStore {
  return new SqliteTaskCohortStore(options);
}
