import type { AgentRunSessionTarget } from "../agents/run-session-target.js";
import type {
  SubagentRestartRecoveryReceipt,
  SubagentRunRecord,
} from "../agents/subagents/registry/subagent-registry.types.js";
import type {
  ExecutionOwnerBinding,
  ExecutionOwnerBindingResult,
} from "../audit/execution-owner-binding.js";
import type { QueuedSessionDelivery } from "../infra/session-delivery-queue-storage.js";
import type { PreparedCanonicalTaskActivation } from "../tasks/task-backing-authority-write.js";
import type { TaskFlowRecord } from "../tasks/task-flow-registry.types.js";
import type { TaskDeliveryState, TaskRecord, TaskRuntime } from "../tasks/task-registry.types.js";

/** JSON-safe canonical snapshot used by async stores and the compatibility mailbox. */
export type TaskCohortSnapshot = Readonly<{
  /** Ordered by creation time and then task id. */
  tasks: readonly TaskRecord[];
  /** Ordered by task id. */
  deliveryStates: readonly TaskDeliveryState[];
}>;

/**
 * Complete durable state owned by one task id. Backends also validate that all
 * present records carry the outer taskId before comparing or mutating rows.
 */
export type TaskCohortTaskState =
  | Readonly<{ taskId: string; task: null; deliveryState: null }>
  | Readonly<{
      taskId: string;
      task: TaskRecord;
      deliveryState: TaskDeliveryState | null;
    }>;

/**
 * Atomically compare-replaces one task and its delivery companion. The backend
 * must return already-applied when current state equals next after a retry.
 */
export type CommitTaskStateCommand = Readonly<{
  operationId: string;
  expected: TaskCohortTaskState;
  next: TaskCohortTaskState;
}>;

type TaskCohortOperationResult<Result> = Readonly<{ operationId: string }> &
  (Result | Readonly<{ status: "conflict"; reason: "operation-id-reused" }>);

export type CommitTaskStateResult = TaskCohortOperationResult<
  | Readonly<{ status: "applied" | "already-applied"; state: TaskCohortTaskState }>
  | Readonly<{
      status: "conflict";
      reason: "task-changed" | "delivery-state-changed";
      current: TaskCohortTaskState;
    }>
>;

/** Exact task owner and eligibility accepted for one post-admission binding. */
export type BindTaskExecutionCommand = Readonly<{
  operationId: string;
  taskId: string;
  expected: Readonly<{
    runtime: TaskRuntime;
    runId: string | null;
  }>;
  binding: ExecutionOwnerBinding;
}>;

export type BindTaskExecutionResult = TaskCohortOperationResult<
  Readonly<{ status: Exclude<ExecutionOwnerBindingResult, "disabled"> }>
>;

/** Inserts one queue generation and advances its correlated subagent/task projections. */
export type AdmitSubagentCompletionCommand = Readonly<{
  operationId: string;
  queueEntry: QueuedSessionDelivery;
  expectedSubagent: SubagentRunRecord;
  nextSubagent: SubagentRunRecord;
  expectedTask: TaskRecord;
  nextTask: TaskRecord;
}>;

export type AdmitSubagentCompletionResult = TaskCohortOperationResult<
  | Readonly<{
      status: "applied" | "already-applied";
      claimed: boolean;
      queueEntry: QueuedSessionDelivery;
      subagent: SubagentRunRecord;
      task: TaskRecord;
    }>
  | Readonly<{
      status: "conflict";
      reason: "queue-owner-changed" | "subagent-changed" | "task-changed";
    }>
>;

/** Applies one correlated queue settlement to its subagent and task projections. */
export type SettleSubagentCompletionCommand = Readonly<{
  operationId: string;
  expectedSubagent: SubagentRunRecord;
  nextSubagent: SubagentRunRecord;
  expectedTask: TaskRecord;
  nextTask: TaskRecord;
}>;

export type SettleSubagentCompletionResult = TaskCohortOperationResult<
  | Readonly<{
      status: "applied" | "already-applied";
      subagent: SubagentRunRecord;
      task: TaskRecord;
    }>
  | Readonly<{
      status: "conflict";
      reason: "subagent-changed" | "task-changed";
    }>
>;

/**
 * Converts one still-owned completion generation into a blocked terminal state.
 * `now` is prepared once so retries and backends derive the same durable result.
 */
export type BlockSubagentCompletionCommand = Readonly<{
  operationId: string;
  expectedSubagent: SubagentRunRecord;
  expectedTask: TaskRecord;
  reason: string;
  now: number;
  suspendedReason?: "expiry" | "permanent_failure";
  disposition?: NonNullable<SubagentRunRecord["delivery"]>["disposition"];
}>;

export type BlockSubagentCompletionResult = TaskCohortOperationResult<
  | Readonly<{
      status: "applied" | "already-applied";
      subagent: SubagentRunRecord;
      task: TaskRecord;
      queuedDelivery?: QueuedSessionDelivery;
    }>
  | Readonly<{
      status: "conflict";
      reason: "owner-changed" | "not-eligible";
    }>
>;

export type SubagentRunChange = Readonly<{
  runId: string;
  expected: SubagentRunRecord | null;
  next: SubagentRunRecord | null;
}>;

/**
 * Evidence prepared only while the main-process owner still holds the exact
 * accepted receipt. A backend must independently re-read the named session and
 * match the receipt before reconciling attempted/consumed to accepted.
 */
export type AcceptedRestartReceiptReconciliation = Readonly<{
  receipt: SubagentRestartRecoveryReceipt;
  sessionTarget: AgentRunSessionTarget;
}>;

/** Atomically transfers a subagent generation with its canonical task and mirrored flow. */
export type ReplaceSubagentTaskCommand = Readonly<{
  operationId: string;
  source: SubagentRunRecord;
  successor: SubagentRunRecord;
  runChanges: readonly SubagentRunChange[];
  task: PreparedCanonicalTaskActivation;
  flow?: Readonly<{ current: TaskFlowRecord; next: TaskFlowRecord }>;
  acceptedRestartReceipt?: AcceptedRestartReceiptReconciliation;
}>;

export type ReplaceSubagentTaskResult = TaskCohortOperationResult<
  | Readonly<{
      status: "applied" | "already-applied";
      runs: readonly Readonly<{ runId: string; record: SubagentRunRecord | null }>[];
      task: TaskRecord;
      flow?: TaskFlowRecord;
    }>
  | Readonly<{
      status: "conflict";
      reason: "source-changed" | "run-changed" | "task-changed" | "flow-changed";
    }>
>;

/**
 * Canonical asynchronous storage boundary for the task transaction cohort.
 * Implementations own backend-private transactions; callers never receive a
 * transaction or SQL handle. Snapshot replacement remains migration-only and
 * is intentionally absent from this runtime contract.
 */
export interface TaskCohortStore {
  loadSnapshot(): Promise<TaskCohortSnapshot>;
  inspectReadOnly(): Promise<{
    state: "ready" | "migration-required";
    snapshot: TaskCohortSnapshot;
  }>;
  listTasksForOwnerKey(ownerKey: string): Promise<TaskRecord[]>;
  listTasksByRuntimeSource(params: {
    runtime: TaskRuntime;
    sourceId?: string;
  }): Promise<TaskRecord[]>;
  commitTaskState(command: CommitTaskStateCommand): Promise<CommitTaskStateResult>;
  bindTaskExecution(command: BindTaskExecutionCommand): Promise<BindTaskExecutionResult>;
  admitSubagentCompletion(
    command: AdmitSubagentCompletionCommand,
  ): Promise<AdmitSubagentCompletionResult>;
  settleSubagentCompletion(
    command: SettleSubagentCompletionCommand,
  ): Promise<SettleSubagentCompletionResult>;
  blockSubagentCompletion(
    command: BlockSubagentCompletionCommand,
  ): Promise<BlockSubagentCompletionResult>;
  replaceSubagentTask(command: ReplaceSubagentTaskCommand): Promise<ReplaceSubagentTaskResult>;
  close(): Promise<void>;
}
