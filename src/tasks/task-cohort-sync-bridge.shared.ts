import type {
  AdmitSubagentCompletionCommand,
  BindTaskExecutionCommand,
  BlockSubagentCompletionCommand,
  CommitTaskStateCommand,
  CronRunRecoverySelector,
  RecoverCronRunCommand,
  ReplaceSubagentTaskCommand,
  SettleSubagentCompletionCommand,
  TaskCohortMutationOptions,
} from "../storage/task-cohort-store.js";
import type { TaskRuntime } from "./task-registry.types.js";

export type TaskCohortBridgeRequest =
  | Readonly<{ operation: "close" }>
  | Readonly<{ operation: "loadSnapshot" }>
  | Readonly<{ operation: "inspectReadOnly" }>
  | Readonly<{ operation: "listTasksForOwnerKey"; ownerKey: string }>
  | Readonly<{
      operation: "listTasksByRuntimeSource";
      params: { runtime: TaskRuntime; sourceId?: string };
    }>
  | Readonly<{
      operation: "commitTaskState";
      command: CommitTaskStateCommand;
      options: TaskCohortMutationOptions;
    }>
  | Readonly<{
      operation: "bindTaskExecution";
      command: BindTaskExecutionCommand;
      options: TaskCohortMutationOptions;
    }>
  | Readonly<{
      operation: "admitSubagentCompletion";
      command: AdmitSubagentCompletionCommand;
      options: TaskCohortMutationOptions;
    }>
  | Readonly<{
      operation: "settleSubagentCompletion";
      command: SettleSubagentCompletionCommand;
      options: TaskCohortMutationOptions;
    }>
  | Readonly<{
      operation: "blockSubagentCompletion";
      command: BlockSubagentCompletionCommand;
      options: TaskCohortMutationOptions;
    }>
  | Readonly<{
      operation: "replaceSubagentTask";
      command: ReplaceSubagentTaskCommand;
      options: TaskCohortMutationOptions;
    }>
  | Readonly<{
      operation: "inspectCronRunRecovery";
      selector: CronRunRecoverySelector;
    }>
  | Readonly<{
      operation: "recoverCronRun";
      command: RecoverCronRunCommand;
      options: TaskCohortMutationOptions;
    }>;

export type TaskCohortBridgeEnvelope = Readonly<{
  databasePath?: string;
  request: TaskCohortBridgeRequest;
}>;
