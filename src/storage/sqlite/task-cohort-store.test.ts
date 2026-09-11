import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { settleSubagentCompletionDelivery } from "../../agents/subagents/completion/subagent-completion-admission.store.js";
import { records } from "../../agents/subagents/completion/subagent-completion-admission.test-helpers.js";
import {
  bindSubagentRunRecord,
  readSubagentRun,
  upsertSubagentRunRowInDatabase,
} from "../../agents/subagents/registry/subagent-registry.store.sqlite.js";
import { upsertCronJobRow } from "../../cron/store/row-codec.js";
import type { CronJob } from "../../cron/types.js";
import { prepareClaimedSessionDelivery } from "../../infra/session-delivery-queue-storage.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import type { TaskDeliveryState, TaskRecord } from "../../tasks/task-registry.types.js";
import { prepareTaskCohortOperation } from "../task-cohort-operation.js";
import type {
  AdmitSubagentCompletionCommand,
  BindTaskExecutionCommand,
  BlockSubagentCompletionCommand,
  CommitTaskStateCommand,
  RecoverCronRunCommand,
  ReplaceSubagentTaskCommand,
  SettleSubagentCompletionCommand,
  TaskCohortTaskState,
} from "../task-cohort-store.js";
import { createSqliteTaskCohortStore } from "./task-cohort-store.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function task(taskId = "task-1"): TaskRecord {
  return {
    taskId,
    runtime: "subagent",
    requesterSessionKey: "agent:main:main",
    ownerKey: "agent:main:main",
    scopeKind: "session",
    runId: "run-1",
    task: "verify the cohort",
    status: "running",
    deliveryStatus: "pending",
    notifyPolicy: "done_only",
    createdAt: 1_000,
    startedAt: 1_100,
    lastEventAt: 1_100,
  };
}

function absent(taskId: string): TaskCohortTaskState {
  return { taskId, task: null, deliveryState: null };
}

function present(record: TaskRecord, deliveryState: TaskDeliveryState): TaskCohortTaskState {
  return { taskId: record.taskId, task: record, deliveryState };
}

function commitCommand(
  expected: TaskCohortTaskState,
  next: TaskCohortTaskState,
): CommitTaskStateCommand {
  return prepareTaskCohortOperation("commit-task-state", { expected, next });
}

describe("SQLite task cohort store", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
  });

  function setup() {
    const tempDir = tempDirs.make("openclaw-task-cohort-");
    const databasePath = path.join(tempDir, "state.sqlite");
    const options = { path: databasePath };
    const database = openOpenClawStateDatabase(options);
    const store = createSqliteTaskCohortStore(options);
    return { database, store };
  }

  it("atomically compare-replaces a task and delivery state", async () => {
    const { store } = setup();
    const record = task();
    const deliveryState = { taskId: record.taskId, lastNotifiedEventAt: 1_050 };
    const command = commitCommand(absent(record.taskId), present(record, deliveryState));

    await expect(store.commitTaskState(command, { mode: "execute" })).resolves.toEqual({
      operationId: command.operationId,
      status: "applied",
      state: present(record, deliveryState),
    });
    await expect(store.commitTaskState(command, { mode: "execute" })).resolves.toMatchObject({
      status: "already-applied",
    });

    await expect(store.loadSnapshot()).resolves.toEqual({
      tasks: [record],
      deliveryStates: [deliveryState],
    });
  });

  it("never mutates an expected-state match during ambiguity reconciliation", async () => {
    const { store } = setup();
    const record = task();
    const next = { ...record, status: "succeeded" as const, endedAt: 1_200 };
    const seed = commitCommand(absent(record.taskId), {
      taskId: record.taskId,
      task: record,
      deliveryState: null,
    });
    await store.commitTaskState(seed, { mode: "execute" });
    const command = commitCommand(
      { taskId: record.taskId, task: record, deliveryState: null },
      { taskId: record.taskId, task: next, deliveryState: null },
    );

    await expect(store.commitTaskState(command, { mode: "reconcile" })).resolves.toEqual({
      operationId: command.operationId,
      status: "outcome-unknown",
      reason: "postcondition-not-proven",
    });
    await expect(store.loadSnapshot()).resolves.toMatchObject({ tasks: [record] });
  });

  it("reports exact-next reconciliation without replaying the mutation", async () => {
    const { store } = setup();
    const record = task();
    const command = commitCommand(absent(record.taskId), {
      taskId: record.taskId,
      task: record,
      deliveryState: null,
    });
    await store.commitTaskState(command, { mode: "execute" });

    await expect(store.commitTaskState(command, { mode: "reconcile" })).resolves.toMatchObject({
      operationId: command.operationId,
      status: "already-applied",
      state: { task: record },
    });
  });

  it("rejects a command changed after its operation ID was prepared", async () => {
    const { store } = setup();
    const record = task();
    const command = commitCommand(absent(record.taskId), {
      taskId: record.taskId,
      task: record,
      deliveryState: null,
    });
    const changed: CommitTaskStateCommand = {
      ...command,
      next: {
        ...command.next,
        task: command.next.task ? { ...command.next.task, task: "changed intent" } : null,
      },
    };

    await expect(store.commitTaskState(changed, { mode: "execute" })).resolves.toEqual({
      operationId: command.operationId,
      status: "conflict",
      reason: "operation-id-mismatch",
    });
    await expect(store.loadSnapshot()).resolves.toEqual({ tasks: [], deliveryStates: [] });
  });

  it("rolls back the task when its companion delivery write fails", async () => {
    const { database, store } = setup();
    database.db.exec(`CREATE TEMP TRIGGER reject_task_delivery
      BEFORE INSERT ON task_delivery_state
      BEGIN SELECT RAISE(ABORT, 'reject delivery'); END`);
    const record = task();
    const command = commitCommand(
      absent(record.taskId),
      present(record, { taskId: record.taskId, lastNotifiedEventAt: 1_050 }),
    );

    await expect(store.commitTaskState(command, { mode: "execute" })).rejects.toThrow(
      "reject delivery",
    );
    expect(
      database.db.prepare("SELECT task_id FROM task_runs WHERE task_id = ?").get(record.taskId),
    ).toBeUndefined();
  });

  it("atomically admits and reconciles a correlated completion generation", async () => {
    const { database, store } = setup();
    const next = records();
    const expectedSubagent = structuredClone(next.subagent);
    Object.assign(expectedSubagent.delivery!, {
      status: "pending" as const,
      disposition: "retryable" as const,
      queueId: undefined,
    });
    const expectedTask = {
      ...next.task,
      deliveryStatus: "pending" as const,
    };
    settleSubagentCompletionDelivery({
      subagent: expectedSubagent,
      task: expectedTask,
      databaseOptions: { database },
    });
    const command: AdmitSubagentCompletionCommand = prepareTaskCohortOperation(
      "admit-subagent-completion",
      {
        queueEntry: next.queueEntry,
        expectedSubagent: { record: expectedSubagent, allowAbsent: true },
        nextSubagent: next.subagent,
        expectedTask: { record: expectedTask, allowAbsent: true },
        nextTask: next.task,
      },
    );

    await expect(
      store.admitSubagentCompletion(command, { mode: "execute" }),
    ).resolves.toMatchObject({ status: "applied", claimed: true });
    await expect(
      store.admitSubagentCompletion(command, { mode: "reconcile" }),
    ).resolves.toMatchObject({ status: "already-applied" });
    expect(
      database.db
        .prepare("SELECT COUNT(*) AS count FROM delivery_queue_entries WHERE id = ?")
        .get(next.queueEntry.id),
    ).toEqual({ count: 1 });
  });

  it("rejects stale admission projections even when initial rows may be absent", async () => {
    const { database, store } = setup();
    const input = records();
    const expectedSubagent = structuredClone(input.subagent);
    expectedSubagent.delivery!.status = "pending";
    expectedSubagent.delivery!.queueId = undefined;
    const expectedTask = { ...input.task, deliveryStatus: "pending" as const };
    const newerSubagent = {
      ...structuredClone(expectedSubagent),
      task: "newer durable subagent projection",
    };
    settleSubagentCompletionDelivery({
      subagent: expectedSubagent,
      task: expectedTask,
      databaseOptions: { database },
    });
    upsertSubagentRunRowInDatabase(database, bindSubagentRunRecord(newerSubagent));
    const command: AdmitSubagentCompletionCommand = prepareTaskCohortOperation(
      "admit-subagent-completion",
      {
        queueEntry: input.queueEntry,
        expectedSubagent: { record: expectedSubagent, allowAbsent: true },
        nextSubagent: input.subagent,
        expectedTask: { record: expectedTask, allowAbsent: true },
        nextTask: input.task,
      },
    );

    await expect(
      store.admitSubagentCompletion(command, { mode: "execute" }),
    ).resolves.toMatchObject({ status: "conflict", reason: "subagent-changed" });
    expect(readSubagentRun(database, input.subagent.runId)).toMatchObject({
      task: newerSubagent.task,
    });
  });

  it("rejects an uncorrelated completion admission before writing any owner", async () => {
    const { database, store } = setup();
    const input = records();
    const expectedSubagent = structuredClone(input.subagent);
    expectedSubagent.delivery!.status = "pending";
    expectedSubagent.delivery!.queueId = undefined;
    const expectedTask = { ...input.task, deliveryStatus: "pending" as const };
    settleSubagentCompletionDelivery({
      subagent: expectedSubagent,
      task: expectedTask,
      databaseOptions: { database },
    });
    const queueEntry = {
      ...input.queueEntry,
      owner:
        input.queueEntry.kind === "agentTurn" && input.queueEntry.owner
          ? { ...input.queueEntry.owner, taskId: "another-task" }
          : undefined,
    };
    const command: AdmitSubagentCompletionCommand = prepareTaskCohortOperation(
      "admit-subagent-completion",
      {
        queueEntry,
        expectedSubagent: { record: expectedSubagent, allowAbsent: true },
        nextSubagent: input.subagent,
        expectedTask: { record: expectedTask, allowAbsent: true },
        nextTask: input.task,
      },
    );

    await expect(store.admitSubagentCompletion(command, { mode: "execute" })).resolves.toEqual({
      operationId: command.operationId,
      status: "conflict",
      reason: "invalid-command",
    });
    expect(
      database.db.prepare("SELECT COUNT(*) AS count FROM delivery_queue_entries").get(),
    ).toEqual({ count: 0 });
  });

  it("rejects cron recovery when its selected task evidence advances", async () => {
    const { database, store } = setup();
    const startedAt = 10_000;
    const cronTask: TaskRecord = {
      ...task("cron-task"),
      runtime: "cron",
      sourceId: "cron-job",
      runId: "cron:cron-job:10000",
      lastEventAt: startedAt,
    };
    await store.commitTaskState(
      commitCommand(absent(cronTask.taskId), {
        taskId: cronTask.taskId,
        task: cronTask,
        deliveryState: null,
      }),
      { mode: "execute" },
    );
    const job: CronJob = {
      id: "cron-job",
      agentId: "alpha",
      name: "cron-job",
      enabled: true,
      createdAtMs: startedAt - 1,
      updatedAtMs: startedAt - 1,
      schedule: { kind: "every", everyMs: 60_000, anchorMs: startedAt },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "command", argv: ["true"] },
      state: { runningAtMs: startedAt },
    };
    upsertCronJobRow(database.db, "cron-store", job, 0);
    const selector = { storeKey: "cron-store", jobId: job.id, startedAt };
    const expected = await store.inspectCronRunRecovery(selector);
    const nextJob = structuredClone(expected.job!);
    nextJob.job.state.runningAtMs = undefined;
    const command: RecoverCronRunCommand = prepareTaskCohortOperation("recover-cron-run", {
      selector,
      expected,
      next: { job: nextJob, receipt: null, task: expected.task },
    });
    const advancedTask = { ...cronTask, lastEventAt: startedAt + 1 };
    await store.commitTaskState(
      commitCommand(
        { taskId: cronTask.taskId, task: cronTask, deliveryState: null },
        { taskId: cronTask.taskId, task: advancedTask, deliveryState: null },
      ),
      { mode: "execute" },
    );

    await expect(store.recoverCronRun(command, { mode: "execute" })).resolves.toMatchObject({
      status: "conflict",
      reason: "task-recovery-changed",
    });
    await expect(store.inspectCronRunRecovery(selector)).resolves.toMatchObject({
      job: expected.job,
      task: advancedTask,
    });
  });

  it("settles only an exact subagent and task pair", async () => {
    const { database, store } = setup();
    const expected = records();
    settleSubagentCompletionDelivery({
      subagent: expected.subagent,
      task: expected.task,
      databaseOptions: { database },
    });
    const nextSubagent = structuredClone(expected.subagent);
    Object.assign(nextSubagent.delivery!, {
      status: "delivered" as const,
      disposition: "delivered" as const,
      queueId: undefined,
    });
    const nextTask = { ...expected.task, deliveryStatus: "delivered" as const };
    const command: SettleSubagentCompletionCommand = prepareTaskCohortOperation(
      "settle-subagent-completion",
      {
        expectedSubagent: expected.subagent,
        nextSubagent,
        expectedTask: expected.task,
        nextTask,
      },
    );

    await expect(
      store.settleSubagentCompletion(command, { mode: "execute" }),
    ).resolves.toMatchObject({ status: "applied", subagent: nextSubagent, task: nextTask });
    const staleCommand: SettleSubagentCompletionCommand = prepareTaskCohortOperation(
      "settle-subagent-completion",
      {
        expectedSubagent: expected.subagent,
        nextSubagent: { ...nextSubagent, cleanupHandled: true },
        expectedTask: expected.task,
        nextTask,
      },
    );
    await expect(
      store.settleSubagentCompletion(staleCommand, { mode: "execute" }),
    ).resolves.toMatchObject({ status: "conflict", reason: "subagent-changed" });
  });

  it("rolls back a blocked completion and its follow-up queue as one unit", async () => {
    const { database, store } = setup();
    const expected = records();
    settleSubagentCompletionDelivery({
      subagent: expected.subagent,
      task: expected.task,
      databaseOptions: { database },
    });
    const nextSubagent = structuredClone(expected.subagent);
    Object.assign(nextSubagent.delivery!, {
      status: "failed" as const,
      disposition: "retryable" as const,
      queueId: undefined,
      lastError: "requester unavailable",
    });
    nextSubagent.suppressCompletionDelivery = true;
    const nextTask = {
      ...expected.task,
      status: "failed" as const,
      deliveryStatus: "failed" as const,
      terminalOutcome: "blocked" as const,
      error: "requester unavailable",
    };
    const queuedDelivery = prepareClaimedSessionDelivery(
      {
        kind: "systemEvent",
        sessionKey: expected.task.requesterSessionKey,
        text: "Task result delivery was blocked.",
        idempotencyKey: "blocked:task-completion:1",
      },
      0,
      2_000,
    );
    const command: BlockSubagentCompletionCommand = prepareTaskCohortOperation(
      "block-subagent-completion",
      {
        expectedSubagent: expected.subagent,
        nextSubagent,
        expectedTask: expected.task,
        nextTask,
        queuedDelivery,
      },
    );
    database.db.exec(`CREATE TEMP TRIGGER reject_blocked_task
      BEFORE UPDATE ON task_runs
      BEGIN SELECT RAISE(ABORT, 'reject blocked task'); END`);

    await expect(store.blockSubagentCompletion(command, { mode: "execute" })).rejects.toThrow(
      "reject blocked task",
    );
    expect(
      database.db.prepare("SELECT COUNT(*) AS count FROM delivery_queue_entries").get(),
    ).toEqual({ count: 0 });
    expect(readSubagentRun(database, expected.subagent.runId)).toEqual(expected.subagent);
  });

  it("atomically replaces a predecessor with its successor and task activation", async () => {
    const { database, store } = setup();
    const expected = records();
    settleSubagentCompletionDelivery({
      subagent: expected.subagent,
      task: expected.task,
      databaseOptions: { database },
    });
    const successor = {
      ...structuredClone(expected.subagent),
      runId: "completion-successor",
      generation: (expected.subagent.generation ?? 1) + 1,
      execution: { status: "running" as const, startedAt: 2_000 },
      delivery: { status: "pending" as const },
    };
    const nextTask = {
      ...expected.task,
      status: "running" as const,
      deliveryStatus: "pending" as const,
      endedAt: undefined,
      terminalOutcome: undefined,
      lastEventAt: 2_000,
    };
    const command: ReplaceSubagentTaskCommand = prepareTaskCohortOperation(
      "replace-subagent-task",
      {
        source: expected.subagent,
        successor,
        runChanges: [
          { runId: expected.subagent.runId, expected: expected.subagent, next: null },
          { runId: successor.runId, expected: null, next: successor },
        ],
        task: { current: expected.task, next: nextTask },
      },
    );

    await expect(store.replaceSubagentTask(command, { mode: "execute" })).resolves.toMatchObject({
      status: "applied",
      task: nextTask,
    });
    expect(readSubagentRun(database, expected.subagent.runId)).toBeNull();
    expect(readSubagentRun(database, successor.runId)).toEqual(successor);
  });

  it("binds execution identity only to the exact eligible task", async () => {
    const { store } = setup();
    const record = task();
    const seed = commitCommand(absent(record.taskId), {
      taskId: record.taskId,
      task: record,
      deliveryState: null,
    });
    await store.commitTaskState(seed, { mode: "execute" });
    const binding = { contextId: "context-1", executionId: "execution-1" };
    const command: BindTaskExecutionCommand = prepareTaskCohortOperation("bind-task-execution", {
      expectedTask: record,
      binding,
    });

    await expect(store.bindTaskExecution(command, { mode: "execute" })).resolves.toEqual({
      operationId: command.operationId,
      status: "applied",
      binding,
    });
    await expect(store.bindTaskExecution(command, { mode: "reconcile" })).resolves.toEqual({
      operationId: command.operationId,
      status: "already-applied",
      binding,
    });
  });
});
