import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  requestStorageSyncBridge,
  StorageSyncBridgeOutcomeUnknownError,
} from "../storage/storage-sync-bridge.js";
import type {
  AdmitSubagentCompletionResult,
  BindTaskExecutionResult,
  BlockSubagentCompletionResult,
  CommitTaskStateResult,
  CronRunRecoverySnapshot,
  RecoverCronRunResult,
  ReplaceSubagentTaskResult,
  SettleSubagentCompletionResult,
  TaskCohortSnapshot,
} from "../storage/task-cohort-store.js";
import type {
  TaskCohortBridgeEnvelope,
  TaskCohortBridgeRequest,
} from "./task-cohort-sync-bridge.shared.js";
import type { TaskRecord } from "./task-registry.types.js";

type TaskCohortBridgeResponseMap = {
  close: void;
  loadSnapshot: TaskCohortSnapshot;
  inspectReadOnly: { state: "ready" | "migration-required"; snapshot: TaskCohortSnapshot };
  listTasksForOwnerKey: TaskRecord[];
  listTasksByRuntimeSource: TaskRecord[];
  commitTaskState: CommitTaskStateResult;
  bindTaskExecution: BindTaskExecutionResult;
  admitSubagentCompletion: AdmitSubagentCompletionResult;
  settleSubagentCompletion: SettleSubagentCompletionResult;
  blockSubagentCompletion: BlockSubagentCompletionResult;
  replaceSubagentTask: ReplaceSubagentTaskResult;
  inspectCronRunRecovery: CronRunRecoverySnapshot;
  recoverCronRun: RecoverCronRunResult;
};

type TaskCohortBridgeResponse<Request extends TaskCohortBridgeRequest> =
  TaskCohortBridgeResponseMap[Request["operation"]];

type TaskCohortMutationRequest = Exclude<
  TaskCohortBridgeRequest,
  {
    operation:
      | "close"
      | "inspectCronRunRecovery"
      | "inspectReadOnly"
      | "listTasksByRuntimeSource"
      | "listTasksForOwnerKey"
      | "loadSnapshot";
  }
>;

type PendingAmbiguity = {
  request: TaskCohortMutationRequest;
  databasePath: string;
};

let taskCohortBridgeUsed = false;
let pendingAmbiguity: PendingAmbiguity | undefined;
let terminalAmbiguity: Error | undefined;

function isExecutingMutation(
  request: TaskCohortBridgeRequest,
): request is TaskCohortMutationRequest {
  return "options" in request && request.options.mode === "execute";
}

function sendTaskCohortBridgeRequest<Request extends TaskCohortBridgeRequest>(
  request: Request,
  databasePath: string,
): TaskCohortBridgeResponse<Request> {
  taskCohortBridgeUsed = true;
  return requestStorageSyncBridge<TaskCohortBridgeResponse<Request>>({
    domain: "task-cohort",
    payload: { databasePath, request } satisfies TaskCohortBridgeEnvelope,
  });
}

function reconcilePendingAmbiguity(): never {
  if (terminalAmbiguity) {
    throw terminalAmbiguity;
  }
  const pending = pendingAmbiguity;
  if (!pending) {
    throw new Error(
      "Task cohort ambiguity reconciliation was requested without a pending command.",
    );
  }
  const result = sendTaskCohortBridgeRequest(
    { ...pending.request, options: { mode: "reconcile" } },
    pending.databasePath,
  );
  pendingAmbiguity = undefined;
  terminalAmbiguity = new Error(
    result.status === "already-applied"
      ? "The previous task mutation committed after its response was lost. Restart the Gateway to reload canonical task state before continuing."
      : "The previous task mutation outcome could not be proven. Restart the Gateway to reload canonical task state before continuing.",
  );
  throw terminalAmbiguity;
}

function requestTaskCohortBridge<Request extends TaskCohortBridgeRequest>(
  request: Request,
  databasePath = resolveOpenClawStateSqlitePath(process.env),
): TaskCohortBridgeResponse<Request> {
  if (request.operation === "close") {
    return sendTaskCohortBridgeRequest(request, databasePath);
  }
  if (terminalAmbiguity || pendingAmbiguity) {
    return reconcilePendingAmbiguity();
  }
  try {
    return sendTaskCohortBridgeRequest(request, databasePath);
  } catch (error) {
    if (error instanceof StorageSyncBridgeOutcomeUnknownError && isExecutingMutation(request)) {
      pendingAmbiguity = { request, databasePath };
      throw new StorageSyncBridgeOutcomeUnknownError(
        `${error.message} The task cohort is blocked until the command is reconciled and the Gateway restarts.`,
        { cause: error },
      );
    }
    throw error;
  }
}

export const taskCohortSyncBridge = {
  loadSnapshot(databasePath?: string): TaskCohortSnapshot {
    return requestTaskCohortBridge({ operation: "loadSnapshot" }, databasePath);
  },
  inspectReadOnly(databasePath?: string): {
    state: "ready" | "migration-required";
    snapshot: TaskCohortSnapshot;
  } {
    return requestTaskCohortBridge({ operation: "inspectReadOnly" }, databasePath);
  },
  listTasksForOwnerKey(ownerKey: string, databasePath?: string): TaskRecord[] {
    return requestTaskCohortBridge({ operation: "listTasksForOwnerKey", ownerKey }, databasePath);
  },
  listTasksByRuntimeSource(
    params: Extract<TaskCohortBridgeRequest, { operation: "listTasksByRuntimeSource" }>["params"],
    databasePath?: string,
  ): TaskRecord[] {
    return requestTaskCohortBridge({ operation: "listTasksByRuntimeSource", params }, databasePath);
  },
  commitTaskState(
    params: Omit<Extract<TaskCohortBridgeRequest, { operation: "commitTaskState" }>, "operation">,
    databasePath?: string,
  ): CommitTaskStateResult {
    return requestTaskCohortBridge({ operation: "commitTaskState", ...params }, databasePath);
  },
  bindTaskExecution(
    params: Omit<Extract<TaskCohortBridgeRequest, { operation: "bindTaskExecution" }>, "operation">,
    databasePath?: string,
  ): BindTaskExecutionResult {
    return requestTaskCohortBridge({ operation: "bindTaskExecution", ...params }, databasePath);
  },
  admitSubagentCompletion(
    params: Omit<
      Extract<TaskCohortBridgeRequest, { operation: "admitSubagentCompletion" }>,
      "operation"
    >,
    databasePath?: string,
  ): AdmitSubagentCompletionResult {
    return requestTaskCohortBridge(
      { operation: "admitSubagentCompletion", ...params },
      databasePath,
    );
  },
  settleSubagentCompletion(
    params: Omit<
      Extract<TaskCohortBridgeRequest, { operation: "settleSubagentCompletion" }>,
      "operation"
    >,
    databasePath?: string,
  ): SettleSubagentCompletionResult {
    return requestTaskCohortBridge(
      { operation: "settleSubagentCompletion", ...params },
      databasePath,
    );
  },
  blockSubagentCompletion(
    params: Omit<
      Extract<TaskCohortBridgeRequest, { operation: "blockSubagentCompletion" }>,
      "operation"
    >,
    databasePath?: string,
  ): BlockSubagentCompletionResult {
    return requestTaskCohortBridge(
      { operation: "blockSubagentCompletion", ...params },
      databasePath,
    );
  },
  replaceSubagentTask(
    params: Omit<
      Extract<TaskCohortBridgeRequest, { operation: "replaceSubagentTask" }>,
      "operation"
    >,
    databasePath?: string,
  ): ReplaceSubagentTaskResult {
    return requestTaskCohortBridge({ operation: "replaceSubagentTask", ...params }, databasePath);
  },
  inspectCronRunRecovery(
    selector: Extract<TaskCohortBridgeRequest, { operation: "inspectCronRunRecovery" }>["selector"],
    databasePath?: string,
  ): CronRunRecoverySnapshot {
    return requestTaskCohortBridge({ operation: "inspectCronRunRecovery", selector }, databasePath);
  },
  recoverCronRun(
    params: Omit<Extract<TaskCohortBridgeRequest, { operation: "recoverCronRun" }>, "operation">,
    databasePath?: string,
  ): RecoverCronRunResult {
    return requestTaskCohortBridge({ operation: "recoverCronRun", ...params }, databasePath);
  },
};

export function closeTaskCohortSyncBridge(): void {
  if (!taskCohortBridgeUsed) {
    return;
  }
  requestTaskCohortBridge({ operation: "close" });
  taskCohortBridgeUsed = false;
}
