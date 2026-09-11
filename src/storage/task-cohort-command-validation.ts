import { isDeepStrictEqual } from "node:util";
import type {
  AdmitSubagentCompletionCommand,
  BindTaskExecutionCommand,
  BlockSubagentCompletionCommand,
  CommitTaskStateCommand,
  RecoverCronRunCommand,
  ReplaceSubagentTaskCommand,
  SettleSubagentCompletionCommand,
  TaskCohortTaskState,
} from "./task-cohort-store.js";

function validText(value: string): boolean {
  return value.trim().length > 0;
}

function validTaskStateIdentity(state: TaskCohortTaskState): boolean {
  if (!validText(state.taskId)) {
    return false;
  }
  if (!state.task) {
    return state.deliveryState === null;
  }
  return (
    state.task.taskId === state.taskId &&
    (!state.deliveryState || state.deliveryState.taskId === state.taskId)
  );
}

function validSubagentTaskPair(
  subagent: { runId: string; taskRunId?: string },
  task: { taskId: string; runId?: string },
): boolean {
  return (
    validText(subagent.runId) &&
    validText(task.taskId) &&
    validText(task.runId ?? "") &&
    (subagent.taskRunId ?? subagent.runId) === task.runId
  );
}

export function isValidCommitTaskStateCommand(command: CommitTaskStateCommand): boolean {
  return (
    command.expected.taskId === command.next.taskId &&
    validTaskStateIdentity(command.expected) &&
    validTaskStateIdentity(command.next)
  );
}

export function isValidBindTaskExecutionCommand(command: BindTaskExecutionCommand): boolean {
  return (
    validText(command.expectedTask.taskId) &&
    validText(command.binding.contextId) &&
    validText(command.binding.executionId)
  );
}

export function isValidAdmitSubagentCompletionCommand(
  command: AdmitSubagentCompletionCommand,
): boolean {
  const owner = command.queueEntry.kind === "agentTurn" ? command.queueEntry.owner : undefined;
  const delivery = command.nextSubagent.delivery;
  return (
    command.expectedSubagent.record.runId === command.nextSubagent.runId &&
    command.expectedTask.record.taskId === command.nextTask.taskId &&
    validSubagentTaskPair(command.expectedSubagent.record, command.expectedTask.record) &&
    validSubagentTaskPair(command.nextSubagent, command.nextTask) &&
    owner?.kind === "subagent_completion" &&
    owner.runId === command.nextSubagent.runId &&
    owner.taskId === command.nextTask.taskId &&
    owner.generation === delivery?.generation &&
    owner.deadlineAt === delivery.deadlineAt &&
    command.queueEntry.id === delivery.queueId &&
    command.nextTask.deliveryStatus === "session_queued"
  );
}

export function isValidSettleSubagentCompletionCommand(
  command: SettleSubagentCompletionCommand,
): boolean {
  return (
    command.expectedSubagent.runId === command.nextSubagent.runId &&
    command.expectedTask.taskId === command.nextTask.taskId &&
    validSubagentTaskPair(command.expectedSubagent, command.expectedTask) &&
    validSubagentTaskPair(command.nextSubagent, command.nextTask)
  );
}

export function isValidBlockSubagentCompletionCommand(
  command: BlockSubagentCompletionCommand,
): boolean {
  const queueOwner =
    command.queuedDelivery?.kind === "agentTurn" ? command.queuedDelivery.owner : undefined;
  return (
    command.expectedSubagent.runId === command.nextSubagent.runId &&
    command.expectedTask.taskId === command.nextTask.taskId &&
    validSubagentTaskPair(command.expectedSubagent, command.expectedTask) &&
    validSubagentTaskPair(command.nextSubagent, command.nextTask) &&
    command.nextTask.deliveryStatus === "failed" &&
    (!queueOwner ||
      (queueOwner.kind === "subagent_completion" &&
        queueOwner.runId === command.nextSubagent.runId &&
        queueOwner.taskId === command.nextTask.taskId))
  );
}

export function isValidRecoverCronRunCommand(command: RecoverCronRunCommand): boolean {
  const { selector, expected, next } = command;
  const jobStateIsValid = (state: typeof expected.job): boolean =>
    !state ||
    (state.job.id === selector.jobId &&
      Number.isSafeInteger(state.sortOrder) &&
      state.sortOrder >= 0);
  const taskIsValid = (task: typeof expected.task): boolean =>
    !task || (task.runtime === "cron" && task.sourceId === selector.jobId);
  const expectedReceipt = expected.receipt;
  const completion = next.receipt;
  const receiptIsValid =
    (!expectedReceipt && !completion) ||
    (expectedReceipt !== null &&
      completion !== null &&
      isDeepStrictEqual(completion.handle, expectedReceipt) &&
      expectedReceipt.storeKey === selector.storeKey &&
      expectedReceipt.jobId === selector.jobId &&
      expectedReceipt.receiptId === selector.receiptId &&
      Number.isFinite(completion.finishedAtMs));
  return (
    validText(selector.storeKey) &&
    validText(selector.jobId) &&
    Number.isFinite(selector.startedAt) &&
    jobStateIsValid(expected.job) &&
    jobStateIsValid(next.job) &&
    taskIsValid(expected.task) &&
    taskIsValid(next.task) &&
    isDeepStrictEqual(next.task, expected.task) &&
    receiptIsValid
  );
}

export function isValidReplaceSubagentTaskCommand(command: ReplaceSubagentTaskCommand): boolean {
  const changesByRunId = new Map(command.runChanges.map((change) => [change.runId, change]));
  const sourceChange = changesByRunId.get(command.source.runId);
  const successorChange = changesByRunId.get(command.successor.runId);
  const canonicalTaskRunId = command.source.taskRunId ?? command.source.runId;
  const flowMatches =
    !command.flow ||
    (command.flow.current.flowId === command.flow.next.flowId &&
      command.task.current.parentFlowId === command.flow.current.flowId &&
      command.task.next.parentFlowId === command.flow.next.flowId);
  const receiptMatches =
    !command.acceptedRestartReceipt ||
    (command.acceptedRestartReceipt.receipt.phase === "accepted" &&
      command.acceptedRestartReceipt.receipt.idempotencyKey === command.successor.runId &&
      validText(command.acceptedRestartReceipt.sessionTarget.sessionKey ?? "") &&
      validText(command.acceptedRestartReceipt.sessionTarget.storePath ?? ""));
  return (
    command.runChanges.length > 0 &&
    changesByRunId.size === command.runChanges.length &&
    command.runChanges.every(
      (change) =>
        validText(change.runId) &&
        (!change.expected || change.expected.runId === change.runId) &&
        (!change.next || change.next.runId === change.runId),
    ) &&
    sourceChange?.expected?.runId === command.source.runId &&
    successorChange?.next?.runId === command.successor.runId &&
    command.task.current.taskId === command.task.next.taskId &&
    command.task.current.runId === canonicalTaskRunId &&
    command.task.next.runId === canonicalTaskRunId &&
    command.successor.taskRunId === canonicalTaskRunId &&
    command.successor.childSessionKey === command.source.childSessionKey &&
    command.task.current.childSessionKey === command.source.childSessionKey &&
    command.task.next.childSessionKey === command.successor.childSessionKey &&
    flowMatches &&
    receiptMatches
  );
}
