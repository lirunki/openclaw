import { describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => {
  class OutcomeUnknownError extends Error {}
  return {
    OutcomeUnknownError,
    request: vi.fn(),
  };
});

vi.mock("../storage/storage-sync-bridge.js", () => ({
  requestStorageSyncBridge: bridge.request,
  StorageSyncBridgeOutcomeUnknownError: bridge.OutcomeUnknownError,
}));

import { prepareTaskCohortOperation } from "../storage/task-cohort-operation.js";
import type { CommitTaskStateCommand } from "../storage/task-cohort-store.js";
import { taskCohortSyncBridge } from "./task-cohort-sync-bridge.js";
import type { TaskRecord } from "./task-registry.types.js";

describe("task cohort ambiguous response handling", () => {
  it("reconciles the same command without replay and then requires restart", () => {
    const task: TaskRecord = {
      taskId: "task-ambiguous",
      runtime: "subagent",
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      runId: "run-ambiguous",
      task: "reconcile the exact command",
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
    bridge.request
      .mockImplementationOnce(() => {
        throw new bridge.OutcomeUnknownError("response lost; commit outcome is unknown");
      })
      .mockReturnValueOnce({ status: "already-applied" });

    expect(() =>
      taskCohortSyncBridge.commitTaskState({ command, options: { mode: "execute" } }),
    ).toThrow("blocked until the command is reconciled");
    expect(() => taskCohortSyncBridge.loadSnapshot()).toThrow(
      "previous task mutation committed after its response was lost",
    );

    expect(bridge.request).toHaveBeenCalledTimes(2);
    expect(bridge.request.mock.calls[1]?.[0]).toMatchObject({
      payload: {
        request: {
          command: { operationId: command.operationId },
          options: { mode: "reconcile" },
        },
      },
    });
  });
});
