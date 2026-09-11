import type { AdmittedRunContext } from "../agents/admitted-run-context.js";
import {
  executionOwnerBindingFromAdmission,
  type ExecutionOwnerBindingResult,
} from "../audit/execution-owner-binding.js";
import { prepareTaskCohortOperation } from "../storage/task-cohort-operation.js";
import type { BindTaskExecutionCommand } from "../storage/task-cohort-store.js";
import { taskCohortSyncBridge } from "./task-cohort-sync-bridge.js";
import type { TaskRecord } from "./task-registry.types.js";

/** Binds admitted execution identity through the selected task cohort owner. */
export function bindTaskExecution(params: {
  admitted: AdmittedRunContext;
  expectedTask: TaskRecord;
}): ExecutionOwnerBindingResult {
  const binding = executionOwnerBindingFromAdmission(params.admitted);
  if (!binding) {
    return "disabled";
  }
  const command: BindTaskExecutionCommand = prepareTaskCohortOperation("bind-task-execution", {
    expectedTask: params.expectedTask,
    binding,
  });
  const result = taskCohortSyncBridge.bindTaskExecution({
    command,
    options: { mode: "execute" },
  });
  if (result.status === "applied") {
    return "bound";
  }
  if (result.status === "already-applied") {
    return "already-bound";
  }
  if (result.status === "conflict") {
    return result.reason === "binding-mismatch" ? "mismatch" : "missing";
  }
  throw new Error("Task execution binding commit outcome is unknown");
}
