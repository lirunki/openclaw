import {
  bindDeliveryQueueEntry,
  loadDeliveryQueueEntryInDatabase,
  upsertBoundDeliveryQueueEntryInDatabase,
} from "../../../infra/delivery-queue-sqlite-bound.js";
import { scheduleSessionDelivery } from "../../../infra/session-delivery-queue-runtime.js";
import {
  prepareClaimedSessionDelivery,
  SESSION_DELIVERY_QUEUE_NAME,
  type QueuedSessionDelivery,
} from "../../../infra/session-delivery-queue-storage.js";
import { deferSqlitePostCommitPublication } from "../../../infra/sqlite-post-commit.js";
import { resolveEventSessionKey } from "../../../routing/session-key.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../../../state/openclaw-state-db.js";
import { prepareTaskCohortOperation } from "../../../storage/task-cohort-operation.js";
import type {
  AdmitSubagentCompletionCommand,
  SettleSubagentCompletionCommand,
} from "../../../storage/task-cohort-store.js";
import { getTaskById, publishTaskRecordAfterAtomicStore } from "../../../tasks/runtime-internal.js";
import { taskCohortSyncBridge } from "../../../tasks/task-cohort-sync-bridge.js";
import { resolveRequiredCompletionDeliveryFailureTerminalResult } from "../../../tasks/task-completion-contract.js";
import { formatTaskBlockedFollowupMessage } from "../../../tasks/task-executor-policy.js";
import {
  bindTaskRecord,
  readTaskRecord,
  upsertTaskRunRowInDatabase,
} from "../../../tasks/task-registry.store.sqlite.js";
import type { TaskRecord } from "../../../tasks/task-registry.types.js";
import { ensureDeliveryState } from "../registry/subagent-delivery-state.js";
import { resolveFinalizedSubagentTaskState } from "../registry/subagent-registry-completion.js";
import {
  loadPendingFinalDeliveryPayload,
  markRequesterSettleWakePending,
} from "../registry/subagent-registry-lifecycle-delivery.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import {
  bindSubagentRunRecord,
  readSubagentRun,
  upsertSubagentRunRowInDatabase,
} from "../registry/subagent-registry.store.sqlite.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";

export const SUSPENDED_RETENTION_MS = 7 * 24 * 60 * 60_000;

type AdmissionTestHooks = {
  afterBind?: () => unknown;
  afterMutation?: (
    phase: "queue" | "subagent" | "task",
    database: OpenClawStateDatabase,
  ) => unknown;
};

function invokeSynchronousHook(hook: (() => unknown) | undefined): void {
  const result = hook?.();
  if (result && typeof (result as PromiseLike<unknown>).then === "function") {
    throw new Error("subagent completion admission transaction hooks must be synchronous");
  }
}

export function publishCommittedRecords(subagent: SubagentRunRecord, task: TaskRecord): void {
  const live = subagentRuns.get(subagent.runId);
  if (live) {
    for (const key of Object.keys(live)) {
      Reflect.deleteProperty(live, key);
    }
    Object.assign(live, subagent);
  } else {
    subagentRuns.set(subagent.runId, subagent);
  }
  publishTaskRecordAfterAtomicStore(task);
}

function assertCorrelatedEntry(params: {
  queueEntry: QueuedSessionDelivery;
  subagent: SubagentRunRecord;
  task: TaskRecord;
}): void {
  const owner = params.queueEntry.kind === "agentTurn" ? params.queueEntry.owner : undefined;
  const delivery = params.subagent.delivery;
  if (
    !owner ||
    owner.kind !== "subagent_completion" ||
    owner.runId !== params.subagent.runId ||
    owner.taskId !== params.task.taskId ||
    owner.generation !== delivery?.generation ||
    owner.deadlineAt !== delivery.deadlineAt ||
    params.queueEntry.id !== delivery.queueId ||
    params.task.deliveryStatus !== "session_queued"
  ) {
    throw new Error("subagent completion admission records do not share one owner generation");
  }
}

/**
 * Commits the physical queue generation, logical completion owner, and task
 * projection as one database-only transaction on one exact shared-state handle.
 */
function admitSubagentCompletionDeliveryInSqlite(params: {
  queueEntry: QueuedSessionDelivery;
  subagent: SubagentRunRecord;
  task: TaskRecord;
  databaseOptions?: OpenClawStateDatabaseOptions;
  /** Transaction cut points used by the real-store crash-consistency tests. */
  testHooks?: AdmissionTestHooks;
}): { claimed: boolean } {
  assertCorrelatedEntry(params);
  const boundQueue = bindDeliveryQueueEntry({
    queueName: SESSION_DELIVERY_QUEUE_NAME,
    entry: params.queueEntry,
    insertOnly: true,
  });
  const boundSubagent = bindSubagentRunRecord(params.subagent);
  const boundTask = bindTaskRecord(params.task);
  invokeSynchronousHook(params.testHooks?.afterBind);

  return runOpenClawStateWriteTransaction(
    (database) => {
      const claimed = upsertBoundDeliveryQueueEntryInDatabase(boundQueue, database);
      invokeSynchronousHook(() => params.testHooks?.afterMutation?.("queue", database));
      if (!claimed) {
        const existing = loadDeliveryQueueEntryInDatabase(
          database,
          SESSION_DELIVERY_QUEUE_NAME,
          params.queueEntry.id,
        ) as QueuedSessionDelivery | null;
        const expectedOwner =
          params.queueEntry.kind === "agentTurn" ? params.queueEntry.owner : undefined;
        const existingOwner = existing?.kind === "agentTurn" ? existing.owner : undefined;
        if (
          !existingOwner ||
          !expectedOwner ||
          existingOwner.kind !== expectedOwner.kind ||
          existingOwner.runId !== expectedOwner.runId ||
          existingOwner.taskId !== expectedOwner.taskId ||
          existingOwner.generation !== expectedOwner.generation ||
          existingOwner.deadlineAt !== expectedOwner.deadlineAt
        ) {
          throw new Error(`session delivery queue conflict for ${params.queueEntry.id}`);
        }
      }
      upsertSubagentRunRowInDatabase(database, boundSubagent);
      invokeSynchronousHook(() => params.testHooks?.afterMutation?.("subagent", database));
      upsertTaskRunRowInDatabase(database, boundTask);
      invokeSynchronousHook(() => params.testHooks?.afterMutation?.("task", database));
      return { claimed };
    },
    params.databaseOptions,
    { operationLabel: "subagent completion delivery admission" },
  );
}

export function admitSubagentCompletionDelivery(params: {
  queueEntry: QueuedSessionDelivery;
  subagent: SubagentRunRecord;
  task: TaskRecord;
  databaseOptions?: OpenClawStateDatabaseOptions;
  /** Transaction cut points used by the real-store crash-consistency tests. */
  testHooks?: AdmissionTestHooks;
}): { claimed: boolean } {
  if (params.databaseOptions || params.testHooks) {
    return admitSubagentCompletionDeliveryInSqlite(params);
  }
  const expectedSubagent = subagentRuns.get(params.subagent.runId);
  const expectedTask = getTaskById(params.task.taskId);
  if (!expectedSubagent || !expectedTask) {
    throw new Error("subagent completion admission source changed before commit");
  }
  const command: AdmitSubagentCompletionCommand = prepareTaskCohortOperation(
    "admit-subagent-completion",
    {
      queueEntry: params.queueEntry,
      expectedSubagent: { record: structuredClone(expectedSubagent), allowAbsent: true },
      nextSubagent: params.subagent,
      expectedTask: { record: expectedTask, allowAbsent: true },
      nextTask: params.task,
    },
  );
  const result = taskCohortSyncBridge.admitSubagentCompletion({
    command,
    options: { mode: "execute" },
  });
  if (result.status === "applied" || result.status === "already-applied") {
    return { claimed: result.claimed };
  }
  if (result.status === "outcome-unknown") {
    throw new Error("Subagent completion admission commit outcome is unknown");
  }
  if (result.status === "conflict") {
    throw new Error(`Subagent completion admission conflict: ${result.reason}`);
  }
  throw new Error("Subagent completion admission returned an invalid result");
}

/** Atomically consumes a correlated queue settlement into registry and task projections. */
function settleSubagentCompletionDeliveryInSqlite(params: {
  subagent: SubagentRunRecord;
  task: TaskRecord;
  databaseOptions?: OpenClawStateDatabaseOptions;
  mutateSubagent?: (entry: SubagentRunRecord) => unknown;
}): void {
  const boundTask = bindTaskRecord(params.task);
  runOpenClawStateWriteTransaction(
    (database) => {
      invokeSynchronousHook(() => params.mutateSubagent?.(params.subagent));
      upsertSubagentRunRowInDatabase(database, bindSubagentRunRecord(params.subagent));
      upsertTaskRunRowInDatabase(database, boundTask);
    },
    params.databaseOptions,
    { operationLabel: "subagent completion delivery settlement" },
  );
}

export function settleSubagentCompletionDelivery(params: {
  subagent: SubagentRunRecord;
  task: TaskRecord;
  databaseOptions?: OpenClawStateDatabaseOptions;
  mutateSubagent?: (entry: SubagentRunRecord) => unknown;
}): void {
  if (params.databaseOptions) {
    settleSubagentCompletionDeliveryInSqlite(params);
    return;
  }
  const expectedSubagent = subagentRuns.get(params.subagent.runId);
  const expectedTask = getTaskById(params.task.taskId);
  if (!expectedSubagent || !expectedTask) {
    throw new Error("subagent completion settlement source changed before commit");
  }
  invokeSynchronousHook(() => params.mutateSubagent?.(params.subagent));
  const command: SettleSubagentCompletionCommand = prepareTaskCohortOperation(
    "settle-subagent-completion",
    {
      expectedSubagent: structuredClone(expectedSubagent),
      nextSubagent: params.subagent,
      expectedTask,
      nextTask: params.task,
    },
  );
  const result = taskCohortSyncBridge.settleSubagentCompletion({
    command,
    options: { mode: "execute" },
  });
  if (result.status === "applied" || result.status === "already-applied") {
    return;
  }
  if (result.status === "outcome-unknown") {
    throw new Error("Subagent completion settlement commit outcome is unknown");
  }
  if (result.status === "conflict") {
    throw new Error(`Subagent completion settlement conflict: ${result.reason}`);
  }
  throw new Error("Subagent completion settlement returned an invalid result");
}

type BlockSubagentCompletionInput = {
  subagent: SubagentRunRecord;
  taskId: string;
  reason: string;
  suspendedReason?: "expiry" | "permanent_failure";
  disposition?: NonNullable<SubagentRunRecord["delivery"]>["disposition"];
  databaseOptions?: OpenClawStateDatabaseOptions;
};

type PreparedBlockedCompletion = {
  subagent: SubagentRunRecord;
  task: TaskRecord;
  queued?: QueuedSessionDelivery;
};

function prepareBlockedCompletion(
  input: BlockSubagentCompletionInput,
  subagent: SubagentRunRecord,
  task: TaskRecord,
  generation: number,
  now: number,
): PreparedBlockedCompletion | undefined {
  if (
    task.runtime !== "subagent" ||
    subagent.execution.status !== "terminal" ||
    subagent.expectsCompletionMessage !== true ||
    (subagent.taskRunId ?? subagent.runId) !== task.runId ||
    (subagent.delivery?.generation ?? 1) !== generation
  ) {
    return undefined;
  }
  const successful = task.status === "succeeded" && subagent.execution.outcome?.status === "ok";
  if (
    !successful &&
    (input.suspendedReason !== undefined ||
      !["cancelled", "failed", "timed_out"].includes(task.status) ||
      resolveFinalizedSubagentTaskState(subagent)?.status !== task.status ||
      !["pending", "in_progress", "failed"].includes(subagent.delivery?.status ?? "pending"))
  ) {
    return undefined;
  }
  const delivery = ensureDeliveryState(subagent);
  delivery.payload ??= loadPendingFinalDeliveryPayload(subagent);
  Object.assign(delivery, {
    status: input.suspendedReason ? ("suspended" as const) : ("failed" as const),
    disposition: input.suspendedReason
      ? ("permanent_failure" as const)
      : (input.disposition ?? delivery.disposition),
    lastError: input.reason,
    deliveredAt: undefined,
    announcedAt: undefined,
    suspendedAt: input.suspendedReason ? (delivery.suspendedAt ?? now) : delivery.suspendedAt,
    suspendedReason: input.suspendedReason ?? delivery.suspendedReason,
    nextAttemptAt: undefined,
    queueId: undefined,
  });
  Object.assign(subagent, { cleanupHandled: false, wakeOnDescendantSettle: undefined });
  if (input.suspendedReason) {
    markRequesterSettleWakePending(subagent);
  } else {
    subagent.suppressCompletionDelivery = true;
  }
  if (successful) {
    const terminal = resolveRequiredCompletionDeliveryFailureTerminalResult(input.reason);
    Object.assign(task, {
      ...terminal,
      error: input.reason,
      cleanupAfter: Math.max(task.cleanupAfter ?? 0, now + SUSPENDED_RETENTION_MS),
    });
  }
  Object.assign(task, { deliveryStatus: "failed" as const, lastEventAt: now });
  const text =
    successful && task.notifyPolicy !== "silent" ? formatTaskBlockedFollowupMessage(task) : null;
  const queued = text
    ? prepareClaimedSessionDelivery(
        {
          kind: "systemEvent",
          sessionKey: resolveEventSessionKey(task.requesterSessionKey),
          ...(task.requesterAgentId ? { agentId: task.requesterAgentId } : {}),
          text,
          ...(subagent.requesterOrigin ? { deliveryContext: subagent.requesterOrigin } : {}),
          idempotencyKey: `subagent-completion-blocked:${task.taskId}:generation:${generation}`,
        },
        0,
        now,
      )
    : undefined;
  return { subagent, task, ...(queued ? { queued } : {}) };
}

function blockSubagentCompletionDeliveryInSqlite(input: BlockSubagentCompletionInput): boolean {
  const generation = input.subagent.delivery?.generation ?? 1;
  const now = Date.now();
  return runOpenClawStateWriteTransaction((database) => {
    const storedSubagent = readSubagentRun(database, input.subagent.runId);
    const storedTask = readTaskRecord(database.db, input.taskId);
    if (!storedSubagent || !storedTask) {
      return false;
    }
    const prepared = prepareBlockedCompletion(input, storedSubagent, storedTask, generation, now);
    if (!prepared) {
      return false;
    }
    if (prepared.queued) {
      upsertBoundDeliveryQueueEntryInDatabase(
        bindDeliveryQueueEntry({
          queueName: SESSION_DELIVERY_QUEUE_NAME,
          entry: prepared.queued,
          insertOnly: true,
        }),
        database,
      );
    }
    settleSubagentCompletionDeliveryInSqlite({
      subagent: prepared.subagent,
      task: prepared.task,
      databaseOptions: { database },
    });
    deferSqlitePostCommitPublication(database.db, () => {
      publishCommittedRecords(prepared.subagent, prepared.task);
      if (prepared.queued) {
        void scheduleSessionDelivery(prepared.queued.id);
      }
    });
    return true;
  }, input.databaseOptions);
}

export function blockSubagentCompletionDelivery(input: BlockSubagentCompletionInput): boolean {
  if (input.databaseOptions) {
    return blockSubagentCompletionDeliveryInSqlite(input);
  }
  const expectedSubagent = subagentRuns.get(input.subagent.runId);
  const expectedTask = getTaskById(input.taskId);
  if (!expectedSubagent || !expectedTask) {
    return false;
  }
  const prepared = prepareBlockedCompletion(
    input,
    structuredClone(expectedSubagent),
    structuredClone(expectedTask),
    input.subagent.delivery?.generation ?? 1,
    Date.now(),
  );
  if (!prepared) {
    return false;
  }
  const command = prepareTaskCohortOperation("block-subagent-completion", {
    expectedSubagent: structuredClone(expectedSubagent),
    nextSubagent: prepared.subagent,
    expectedTask,
    nextTask: prepared.task,
    ...(prepared.queued ? { queuedDelivery: prepared.queued } : {}),
  });
  const result = taskCohortSyncBridge.blockSubagentCompletion({
    command,
    options: { mode: "execute" },
  });
  if (result.status === "applied" || result.status === "already-applied") {
    publishCommittedRecords(prepared.subagent, prepared.task);
    if (prepared.queued) {
      void scheduleSessionDelivery(prepared.queued.id);
    }
    return true;
  }
  if (result.status === "outcome-unknown") {
    throw new Error("Subagent completion blocking commit outcome is unknown");
  }
  return false;
}
