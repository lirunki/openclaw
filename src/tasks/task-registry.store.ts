import { prepareTaskCohortOperation } from "../storage/task-cohort-operation.js";
import type {
  CommitTaskStateCommand,
  CommitTaskStateResult,
  TaskCohortTaskState,
} from "../storage/task-cohort-store.js";
import { closeTaskCohortSyncBridge, taskCohortSyncBridge } from "./task-cohort-sync-bridge.js";
// Stores task registry records in memory and bridges persistence runtime hooks.
import {
  closeTaskRegistryDatabase,
  saveTaskRegistryStateToSqlite,
} from "./task-registry.store.sqlite.js";
import type { TaskRegistryStoreSnapshot } from "./task-registry.store.types.js";
import type { TaskDeliveryState, TaskRecord } from "./task-registry.types.js";

export type { TaskRegistryStoreSnapshot } from "./task-registry.store.types.js";

export type TaskRegistryStore = {
  loadSnapshot: () => TaskRegistryStoreSnapshot;
  saveSnapshot: (snapshot: TaskRegistryStoreSnapshot) => void;
  listTasksForOwnerKey?: (ownerKey: string) => TaskRecord[];
  commitTaskState?: (params: {
    expected: TaskCohortTaskState;
    next: TaskCohortTaskState;
  }) => CommitTaskStateResult;
  upsertTaskWithDeliveryState?: (params: {
    task: TaskRecord;
    deliveryState?: TaskDeliveryState;
  }) => void;
  upsertTask?: (task: TaskRecord) => void;
  deleteTaskWithDeliveryState?: (taskId: string) => void;
  deleteTask?: (taskId: string) => void;
  upsertDeliveryState?: (state: TaskDeliveryState) => void;
  deleteDeliveryState?: (taskId: string) => void;
  close?: () => void;
};

export type TaskRegistryObserverEvent =
  | {
      kind: "restored";
      tasks: TaskRecord[];
    }
  | {
      kind: "upserted";
      task: TaskRecord;
      previous?: TaskRecord;
    }
  | {
      kind: "deleted";
      taskId: string;
      previous: TaskRecord;
    };

type TaskRegistryObservers = {
  // Observers are incremental/best-effort only. Snapshot persistence belongs to TaskRegistryStore.
  onEvent?: (event: TaskRegistryObserverEvent) => void;
};

function loadDefaultTaskSnapshot(): TaskRegistryStoreSnapshot {
  const snapshot = taskCohortSyncBridge.loadSnapshot();
  return {
    tasks: new Map(snapshot.tasks.map((task) => [task.taskId, task])),
    deliveryStates: new Map(snapshot.deliveryStates.map((state) => [state.taskId, state])),
  };
}

function commitDefaultTaskState(params: {
  expected: TaskCohortTaskState;
  next: TaskCohortTaskState;
}): CommitTaskStateResult {
  const command: CommitTaskStateCommand = prepareTaskCohortOperation("commit-task-state", params);
  return taskCohortSyncBridge.commitTaskState({ command, options: { mode: "execute" } });
}

const defaultTaskRegistryStore: TaskRegistryStore = {
  loadSnapshot: loadDefaultTaskSnapshot,
  saveSnapshot: saveTaskRegistryStateToSqlite,
  listTasksForOwnerKey: taskCohortSyncBridge.listTasksForOwnerKey,
  commitTaskState: commitDefaultTaskState,
  close: () => {
    closeTaskCohortSyncBridge();
    closeTaskRegistryDatabase();
  },
};

let configuredTaskRegistryStore: TaskRegistryStore = defaultTaskRegistryStore;
let configuredTaskRegistryObservers: TaskRegistryObservers | null = null;

export function getTaskRegistryStore(): TaskRegistryStore {
  return configuredTaskRegistryStore;
}

export function getTaskRegistryObservers(): TaskRegistryObservers | null {
  return configuredTaskRegistryObservers;
}

export function configureTaskRegistryRuntime(params: {
  store?: TaskRegistryStore;
  observers?: TaskRegistryObservers | null;
}) {
  if (params.store) {
    configuredTaskRegistryStore = params.store;
  }
  if ("observers" in params) {
    configuredTaskRegistryObservers = params.observers ?? null;
  }
}

export function resetTaskRegistryRuntimeForTests() {
  configuredTaskRegistryStore.close?.();
  configuredTaskRegistryStore = defaultTaskRegistryStore;
  configuredTaskRegistryObservers = null;
}
