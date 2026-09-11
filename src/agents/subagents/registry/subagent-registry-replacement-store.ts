import { prepareTaskCohortOperation } from "../../../storage/task-cohort-operation.js";
import type {
  AcceptedRestartReceiptReconciliation,
  ReplaceSubagentTaskCommand,
  SubagentRunChange,
} from "../../../storage/task-cohort-store.js";
import { publishTaskRecordAfterAtomicStore } from "../../../tasks/runtime-internal.js";
import type { PreparedCanonicalTaskActivation } from "../../../tasks/task-backing-authority-write.js";
import { readTaskBackingInstance } from "../../../tasks/task-backing-authority.js";
import { taskCohortSyncBridge } from "../../../tasks/task-cohort-sync-bridge.js";
import {
  prepareTaskMirroredFlowSync,
  publishTaskFlowAfterAtomicStore,
} from "../../../tasks/task-flow-runtime-internal.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { publishSubagentRunsAfterAtomicStore } from "./subagent-registry-state.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

function assertReplacementCorrelation(params: {
  source: SubagentRunRecord;
  successor: SubagentRunRecord;
  task: PreparedCanonicalTaskActivation;
  runChanges: readonly SubagentRunChange[];
}): void {
  const sourceBacking = readTaskBackingInstance(params.task.current.detail);
  const successorBacking = readTaskBackingInstance(params.task.next.detail);
  const canonicalRunId = params.source.taskRunId ?? params.source.runId;
  const preservesAcceptedTerminal =
    (params.task.current.status === "succeeded" || params.task.current.status === "cancelled") &&
    params.task.next.status === params.task.current.status;
  const sourceChange = params.runChanges.find((change) => change.runId === params.source.runId);
  const successorChange = params.runChanges.find(
    (change) => change.runId === params.successor.runId,
  );
  if (
    successorBacking?.runtime !== "subagent" ||
    (sourceBacking !== undefined &&
      (sourceBacking.runtime !== "subagent" ||
        sourceBacking.generation !== params.source.generation)) ||
    successorBacking.generation !== params.successor.generation ||
    params.task.current.runtime !== "subagent" ||
    params.task.current.runId !== canonicalRunId ||
    params.task.current.childSessionKey !== params.source.childSessionKey ||
    params.successor.taskRunId !== canonicalRunId ||
    params.successor.childSessionKey !== params.source.childSessionKey ||
    (params.task.next.status !== "running" && !preservesAcceptedTerminal) ||
    !sourceChange ||
    !successorChange ||
    sourceChange.expected?.runId !== params.source.runId ||
    successorChange.next?.runId !== params.successor.runId ||
    new Set(params.runChanges.map((change) => change.runId)).size !== params.runChanges.length ||
    params.runChanges.some(
      (change) =>
        (change.expected?.runId !== undefined && change.expected.runId !== change.runId) ||
        (change.next?.runId !== undefined && change.next.runId !== change.runId),
    )
  ) {
    throw new Error("replacement subagent and task do not share one owner generation");
  }
}

/** Atomically transfers one subagent owner generation and reactivates its canonical task. */
export function commitSubagentTaskReplacement(params: {
  runs: Map<string, SubagentRunRecord>;
  changedRunIds: readonly string[];
  runChanges: readonly SubagentRunChange[];
  source: SubagentRunRecord;
  successor: SubagentRunRecord;
  task: PreparedCanonicalTaskActivation;
  acceptedRestartReceipt?: AcceptedRestartReceiptReconciliation;
}): void {
  assertReplacementCorrelation(params);
  const flow = prepareTaskMirroredFlowSync(params.task.next);
  const command: ReplaceSubagentTaskCommand = prepareTaskCohortOperation("replace-subagent-task", {
    source: params.source,
    successor: params.successor,
    runChanges: params.runChanges,
    task: params.task,
    ...(flow ? { flow } : {}),
    ...(params.acceptedRestartReceipt
      ? { acceptedRestartReceipt: params.acceptedRestartReceipt }
      : {}),
  });
  const result = taskCohortSyncBridge.replaceSubagentTask({
    command,
    options: { mode: "execute" },
  });
  if (result.status === "outcome-unknown") {
    throw new Error("Subagent task replacement commit outcome is unknown");
  }
  if (result.status === "conflict") {
    throw new Error(`replacement ${result.reason.replaceAll("-", " ")} before commit`);
  }

  subagentRuns.commitOwnership(params.successor);
  const deferredObserverEvents: Array<() => void> = [];
  publishSubagentRunsAfterAtomicStore(params.runs, params.changedRunIds, deferredObserverEvents);
  publishTaskRecordAfterAtomicStore(params.task.next, {
    syncTaskFlow: false,
    deferredObserverEvents,
  });
  if (flow) {
    publishTaskFlowAfterAtomicStore(flow, deferredObserverEvents);
  }
  for (const emitObserverEvent of deferredObserverEvents) {
    emitObserverEvent();
    if (params.runs.get(params.successor.runId) !== params.successor) {
      break;
    }
  }
}
