import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveRuntimeWorkerArgv } from "../infra/runtime-worker-url.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { StorageSyncBridgeClient } from "../storage/storage-sync-bridge-client.js";
import { prepareTaskCohortOperation } from "../storage/task-cohort-operation.js";
import type { CommitTaskStateCommand } from "../storage/task-cohort-store.js";
import { closeTaskCohortSyncBridge, taskCohortSyncBridge } from "./task-cohort-sync-bridge.js";
import type { TaskCohortBridgeEnvelope } from "./task-cohort-sync-bridge.shared.js";
import type { TaskRecord } from "./task-registry.types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("task cohort synchronous compatibility bridge", () => {
  afterEach(async () => {
    await closeTaskCohortSyncBridge();
    closeOpenClawStateDatabaseForTest();
  });

  it("executes and reconciles one task mutation through the persistent worker", () => {
    const databasePath = path.join(tempDirs.make("openclaw-task-bridge-"), "state.sqlite");
    const task: TaskRecord = {
      taskId: "task-bridge",
      runtime: "subagent",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      runId: "run-bridge",
      task: "cross the compatibility bridge",
      status: "running",
      deliveryStatus: "pending",
      notifyPolicy: "done_only",
      createdAt: 1_000,
      startedAt: 1_100,
      lastEventAt: 1_100,
    };
    const command: CommitTaskStateCommand = prepareTaskCohortOperation("commit-task-state", {
      expected: { taskId: task.taskId, task: null, deliveryState: null },
      next: { taskId: task.taskId, task, deliveryState: null },
    });

    expect(
      taskCohortSyncBridge.commitTaskState({ command, options: { mode: "execute" } }, databasePath),
    ).toMatchObject({ status: "applied" });
    expect(
      taskCohortSyncBridge.commitTaskState(
        { command, options: { mode: "reconcile" } },
        databasePath,
      ),
    ).toMatchObject({ status: "already-applied", state: { task } });
    expect(taskCohortSyncBridge.loadSnapshot(databasePath)).toEqual({
      tasks: [task],
      deliveryStates: [],
    });
  });

  it("classifies a lost post-commit response as outcome unknown", async () => {
    const databasePath = path.join(tempDirs.make("openclaw-task-response-loss-"), "state.sqlite");
    const task: TaskRecord = {
      taskId: "task-response-loss",
      runtime: "subagent",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      runId: "run-response-loss",
      task: "commit before the oversized response is replaced",
      status: "running",
      deliveryStatus: "pending",
      notifyPolicy: "done_only",
      createdAt: 2_000,
      startedAt: 2_100,
      lastEventAt: 2_100,
    };
    const command: CommitTaskStateCommand = prepareTaskCohortOperation("commit-task-state", {
      expected: { taskId: task.taskId, task: null, deliveryState: null },
      next: { taskId: task.taskId, task, deliveryState: null },
    });
    const workerUrl = new URL("../storage/storage-sync-bridge.worker.ts", import.meta.url);
    const client = new StorageSyncBridgeClient({
      workerUrl,
      workerExecArgv: resolveRuntimeWorkerArgv(workerUrl).slice(0, -1),
      maxPayloadBytes: 256,
    });
    try {
      expect(() =>
        client.request({
          domain: "task-cohort",
          payload: {
            databasePath,
            request: { operation: "commitTaskState", command, options: { mode: "execute" } },
          } satisfies TaskCohortBridgeEnvelope,
          maxPayloadBytes: 1024 * 1024,
        }),
      ).toThrow("commit outcome is unknown");
    } finally {
      await client.close();
    }

    expect(taskCohortSyncBridge.loadSnapshot(databasePath).tasks).toEqual([task]);
  });
});
