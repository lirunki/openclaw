import type mssql from "mssql";
import { describe, expect, it } from "vitest";
import { records } from "../../agents/subagents/completion/subagent-completion-admission.test-helpers.js";
import type { CronJob } from "../../cron/types.js";
import { prepareClaimedSessionDelivery } from "../../infra/session-delivery-queue-storage.js";
import type { TaskDeliveryState, TaskRecord } from "../../tasks/task-registry.types.js";
import { prepareTaskCohortOperation } from "../task-cohort-operation.js";
import type {
  AdmitSubagentCompletionCommand,
  BlockSubagentCompletionCommand,
  RecoverCronRunCommand,
  ReplaceSubagentTaskCommand,
  SettleSubagentCompletionCommand,
  TaskCohortTaskState,
} from "../task-cohort-store.js";
import type { AzureSqlRequest, AzureSqlResult, AzureSqlTransaction } from "./runtime.js";
import { AzureSqlTaskCohortStore } from "./task-cohort-store.js";

class FakeRequest implements AzureSqlRequest {
  readonly values = new Map<string, unknown>();

  input(name: string, value: unknown): AzureSqlRequest;
  input(name: string, type: mssql.ISqlType, value: unknown): AzureSqlRequest;
  input(name: string, valueOrType: unknown, value?: unknown): AzureSqlRequest {
    this.values.set(name, value === undefined ? valueOrType : value);
    return this;
  }

  async query<Row>(): Promise<AzureSqlResult<Row>> {
    throw new Error("FakeRequest.query is not used directly");
  }
}

type FakeState = {
  tasks: Map<string, string>;
  deliveryStates: Map<string, string>;
  bindings: Map<string, { context_id: string; execution_id: string }>;
  subagents: Map<string, string>;
  queues: Map<string, string>;
  flows: Map<string, string>;
  cronJobs: Map<string, { record_json: string; sort_order: number }>;
  receipts: Map<string, Record<string, unknown>>;
};

function cloneState(state: FakeState): FakeState {
  return {
    tasks: new Map(state.tasks),
    deliveryStates: new Map(state.deliveryStates),
    bindings: new Map(state.bindings),
    subagents: new Map(state.subagents),
    queues: new Map(state.queues),
    flows: new Map(state.flows),
    cronJobs: new Map(state.cronJobs),
    receipts: new Map(state.receipts),
  };
}

class FakeAzureTaskDatabase {
  state: FakeState = {
    tasks: new Map(),
    deliveryStates: new Map(),
    bindings: new Map(),
    subagents: new Map(),
    queues: new Map(),
    flows: new Map(),
    cronJobs: new Map(),
    receipts: new Map(),
  };
  migrationQueries = 0;
  closed = false;
  failDeliveryWrite = false;
  failTaskWrite = false;

  private async execute<Row>(
    state: FakeState,
    text: string,
    bind?: (request: AzureSqlRequest) => void,
  ): Promise<AzureSqlResult<Row>> {
    const request = new FakeRequest();
    bind?.(request);
    const value = (name: string) => request.values.get(name);
    const rows = (items: unknown[]): AzureSqlResult<Row> => ({
      rows: items as Row[],
      rowsAffected: [items.length],
    });

    if (text.includes("storage_migrations")) {
      this.migrationQueries += 1;
      return rows([]);
    }
    if (text.includes("OBJECT_ID")) {
      return rows([
        {
          task_table: 1,
          delivery_table: 1,
          binding_table: 1,
          subagent_table: 1,
          queue_table: 1,
          flow_table: 1,
          cron_job_table: 1,
          cron_receipt_table: 1,
          cron_authority_table: 1,
          cron_scratch_table: 1,
        },
      ]);
    }
    if (text.includes("sp_getapplock")) {
      return rows([]);
    }
    if (text.startsWith("SELECT task_id, record_json FROM [openclaw_global].[task_runs]")) {
      const taskId = value("taskId");
      if (typeof taskId === "string") {
        const record = state.tasks.get(taskId);
        return rows(record ? [{ task_id: taskId, record_json: record }] : []);
      }
      const taskRows = [...state.tasks].map(([id, record_json]) => ({
        task_id: id,
        record_json,
        record: JSON.parse(record_json) as TaskRecord,
      }));
      const ownerKey = value("ownerKey");
      const runtime = value("runtime");
      const sourceId = value("sourceId");
      return rows(
        taskRows
          .filter(({ record }) => ownerKey === undefined || record.ownerKey === ownerKey)
          .filter(({ record }) => runtime === undefined || record.runtime === runtime)
          .filter(({ record }) => sourceId === undefined || record.sourceId === sourceId)
          .map(({ task_id, record_json }) => ({ task_id, record_json })),
      );
    }
    if (
      text.startsWith("SELECT task_id, record_json FROM [openclaw_global].[task_delivery_state]")
    ) {
      const taskId = value("taskId");
      if (typeof taskId === "string") {
        const record = state.deliveryStates.get(taskId);
        return rows(record ? [{ task_id: taskId, record_json: record }] : []);
      }
      return rows(
        [...state.deliveryStates].map(([id, record_json]) => ({
          task_id: id,
          record_json,
        })),
      );
    }
    if (text.startsWith("UPDATE [openclaw_global].[task_runs]")) {
      if (this.failTaskWrite) {
        throw new Error("injected task write failure");
      }
      state.tasks.set(String(value("taskId")), String(value("recordJson")));
      return rows([]);
    }
    if (text.startsWith("UPDATE [openclaw_global].[task_delivery_state]")) {
      if (this.failDeliveryWrite) {
        throw new Error("injected delivery write failure");
      }
      state.deliveryStates.set(String(value("taskId")), String(value("recordJson")));
      return rows([]);
    }
    if (text.startsWith("DELETE FROM [openclaw_global].[task_delivery_state]")) {
      state.deliveryStates.delete(String(value("taskId")));
      return rows([]);
    }
    if (text.includes("DELETE FROM [openclaw_global].[task_runs]")) {
      state.tasks.delete(String(value("taskId")));
      state.bindings.delete(`task\u0000${String(value("taskId"))}`);
      return rows([]);
    }
    if (text.startsWith("SELECT owner_id, context_id, execution_id")) {
      const key = `${String(value("ownerKind"))}\u0000${String(value("ownerId"))}`;
      const binding = state.bindings.get(key);
      return rows(binding ? [{ owner_id: String(value("ownerId")), ...binding }] : []);
    }
    if (text.startsWith("INSERT INTO [openclaw_global].[execution_owner_lifecycle_bindings]")) {
      state.bindings.set(`${String(value("ownerKind"))}\u0000${String(value("ownerId"))}`, {
        context_id: String(value("contextId")),
        execution_id: String(value("executionId")),
      });
      return rows([]);
    }
    if (text.startsWith("SELECT run_id, record_json FROM [openclaw_global].[subagent_runs]")) {
      const runId = String(value("runId"));
      const record = state.subagents.get(runId);
      return rows(record ? [{ run_id: runId, record_json: record }] : []);
    }
    if (text.startsWith("UPDATE [openclaw_global].[subagent_runs]")) {
      state.subagents.set(String(value("runId")), String(value("recordJson")));
      return rows([]);
    }
    if (text.startsWith("DELETE FROM [openclaw_global].[subagent_runs]")) {
      state.subagents.delete(String(value("runId")));
      return rows([]);
    }
    if (text.startsWith("SELECT record_json FROM [openclaw_global].[delivery_queue_entries]")) {
      const key = `${String(value("queueName"))}\u0000${String(value("entryId"))}`;
      const record = state.queues.get(key);
      return rows(record ? [{ record_json: record }] : []);
    }
    if (
      text.startsWith(
        "IF EXISTS (\n       SELECT 1 FROM [openclaw_global].[delivery_queue_entries]",
      )
    ) {
      const key = `${String(value("queueName"))}\u0000${String(value("entryId"))}`;
      if (state.queues.has(key)) {
        return rows([{ inserted: 0 }]);
      }
      state.queues.set(key, String(value("recordJson")));
      return rows([{ inserted: 1 }]);
    }
    if (text.startsWith("SELECT flow_id, record_json FROM [openclaw_global].[flow_runs]")) {
      const flowId = String(value("flowId"));
      const record = state.flows.get(flowId);
      return rows(record ? [{ flow_id: flowId, record_json: record }] : []);
    }
    if (text.startsWith("UPDATE [openclaw_global].[flow_runs]")) {
      state.flows.set(String(value("flowId")), String(value("recordJson")));
      return rows([]);
    }
    if (text.startsWith("SELECT store_key, job_id, sort_order, record_json")) {
      const storeKey = String(value("storeKey"));
      const jobId = String(value("jobId"));
      const row = state.cronJobs.get(`${storeKey}\u0000${jobId}`);
      return rows(row ? [{ store_key: storeKey, job_id: jobId, ...row }] : []);
    }
    if (text.startsWith("UPDATE [openclaw_global].[cron_jobs]")) {
      state.cronJobs.set(`${String(value("storeKey"))}\u0000${String(value("jobId"))}`, {
        record_json: String(value("recordJson")),
        sort_order: Number(value("sortOrder")),
      });
      return rows([]);
    }
    if (text.includes("DELETE FROM [openclaw_global].[cron_jobs]")) {
      state.cronJobs.delete(`${String(value("storeKey"))}\u0000${String(value("jobId"))}`);
      return rows([]);
    }
    if (text.startsWith("SELECT receipt_id, store_key, job_id, config_revision")) {
      const receiptId = value("receiptId");
      if (typeof receiptId === "string") {
        const receipt = state.receipts.get(receiptId);
        return rows(receipt ? [receipt] : []);
      }
      const storeKey = String(value("storeKey"));
      const jobId = String(value("jobId"));
      const receipt = [...state.receipts.values()].find(
        (candidate) =>
          candidate.store_key === storeKey &&
          candidate.job_id === jobId &&
          candidate.status === "running",
      );
      return rows(receipt ? [receipt] : []);
    }
    if (text.startsWith("UPDATE [openclaw_global].[cron_run_receipts]")) {
      const receiptId = String(value("receiptId"));
      const receipt = state.receipts.get(receiptId);
      if (receipt) {
        state.receipts.set(receiptId, {
          ...receipt,
          status: value("status"),
          finished_at_ms: value("finishedAt"),
          error_text: value("error"),
        });
      }
      return rows([]);
    }
    if (text.startsWith("IF SCHEMA_ID")) {
      return rows([]);
    }
    throw new Error(`Unexpected fake Azure SQL query: ${text.slice(0, 120)}`);
  }

  async query<Row>(
    text: string,
    bind?: (request: AzureSqlRequest) => void,
  ): Promise<AzureSqlResult<Row>> {
    if (this.closed) {
      throw new Error("database closed");
    }
    return await this.execute(this.state, text.trim(), bind);
  }

  async transaction<T>(operation: (transaction: AzureSqlTransaction) => Promise<T>): Promise<T> {
    if (this.closed) {
      throw new Error("database closed");
    }
    const pending = cloneState(this.state);
    const result = await operation({
      query: async <Row>(text: string, bind?: (request: AzureSqlRequest) => void) =>
        await this.execute<Row>(pending, text.trim(), bind),
    });
    this.state = pending;
    return result;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function task(taskId = "task-1"): TaskRecord {
  return {
    taskId,
    runtime: "subagent",
    requesterSessionKey: "agent:main:requester",
    ownerKey: "agent:main:requester",
    scopeKind: "session",
    task: "prove Azure task persistence",
    status: "queued",
    deliveryStatus: "pending",
    notifyPolicy: "done_only",
    createdAt: 10,
  };
}

function command(expected: TaskCohortTaskState, next: TaskCohortTaskState) {
  return prepareTaskCohortOperation("commit-task-state", { expected, next });
}

describe("AzureSqlTaskCohortStore", () => {
  it("preserves exact execute and read-only reconciliation semantics", async () => {
    const database = new FakeAzureTaskDatabase();
    const store = new AzureSqlTaskCohortStore(database);
    const record = task();
    const deliveryState: TaskDeliveryState = { taskId: record.taskId, lastNotifiedEventAt: 9 };
    const absent: TaskCohortTaskState = {
      taskId: record.taskId,
      task: null,
      deliveryState: null,
    };
    const present: TaskCohortTaskState = { taskId: record.taskId, task: record, deliveryState };
    const create = command(absent, present);

    await expect(store.commitTaskState(create, { mode: "execute" })).resolves.toMatchObject({
      status: "applied",
      state: present,
    });
    await expect(store.commitTaskState(create, { mode: "execute" })).resolves.toMatchObject({
      status: "already-applied",
      state: present,
    });

    const advanced = { ...record, status: "running" as const, startedAt: 11 };
    const stale = command(absent, {
      taskId: record.taskId,
      task: advanced,
      deliveryState,
    });
    await expect(store.commitTaskState(stale, { mode: "execute" })).resolves.toMatchObject({
      status: "conflict",
      reason: "task-changed",
    });
    await expect(store.commitTaskState(stale, { mode: "reconcile" })).resolves.toMatchObject({
      status: "outcome-unknown",
      reason: "postcondition-not-proven",
    });
    await expect(store.loadSnapshot()).resolves.toEqual({
      tasks: [record],
      deliveryStates: [deliveryState],
    });
  });

  it("filters owner and runtime-source reads without exposing unrelated tasks", async () => {
    const database = new FakeAzureTaskDatabase();
    const store = new AzureSqlTaskCohortStore(database);
    const first = { ...task("task-owner"), ownerKey: "owner-a", sourceId: "source-a" };
    const second = { ...task("task-other"), ownerKey: "owner-b", sourceId: "source-b" };
    for (const record of [first, second]) {
      await store.commitTaskState(
        command(
          { taskId: record.taskId, task: null, deliveryState: null },
          { taskId: record.taskId, task: record, deliveryState: null },
        ),
        { mode: "execute" },
      );
    }

    await expect(store.listTasksForOwnerKey("owner-a")).resolves.toEqual([first]);
    await expect(
      store.listTasksByRuntimeSource({ runtime: "subagent", sourceId: "source-b" }),
    ).resolves.toEqual([second]);
    await expect(store.listTasksForOwnerKey("   ")).resolves.toEqual([]);
    await expect(
      store.listTasksByRuntimeSource({ runtime: "subagent", sourceId: "" }),
    ).resolves.toEqual([]);
  });

  it("atomically admits, settles, and replaces correlated subagent state", async () => {
    const database = new FakeAzureTaskDatabase();
    const store = new AzureSqlTaskCohortStore(database);
    const admitted = records();
    const expectedSubagent = structuredClone(admitted.subagent);
    Object.assign(expectedSubagent.delivery!, {
      status: "pending" as const,
      disposition: "retryable" as const,
      queueId: undefined,
    });
    const expectedTask = { ...admitted.task, deliveryStatus: "pending" as const };
    const admission: AdmitSubagentCompletionCommand = prepareTaskCohortOperation(
      "admit-subagent-completion",
      {
        queueEntry: admitted.queueEntry,
        expectedSubagent: { record: expectedSubagent, allowAbsent: true },
        nextSubagent: admitted.subagent,
        expectedTask: { record: expectedTask, allowAbsent: true },
        nextTask: admitted.task,
      },
    );

    await expect(
      store.admitSubagentCompletion(admission, { mode: "execute" }),
    ).resolves.toMatchObject({
      status: "applied",
      claimed: true,
    });
    await expect(
      store.admitSubagentCompletion(admission, { mode: "reconcile" }),
    ).resolves.toMatchObject({
      status: "already-applied",
    });

    const settledSubagent = structuredClone(admitted.subagent);
    Object.assign(settledSubagent.delivery!, {
      status: "delivered" as const,
      disposition: "delivered" as const,
      queueId: undefined,
    });
    const settledTask = { ...admitted.task, deliveryStatus: "delivered" as const };
    const settlement: SettleSubagentCompletionCommand = prepareTaskCohortOperation(
      "settle-subagent-completion",
      {
        expectedSubagent: admitted.subagent,
        nextSubagent: settledSubagent,
        expectedTask: admitted.task,
        nextTask: settledTask,
      },
    );
    await expect(
      store.settleSubagentCompletion(settlement, { mode: "execute" }),
    ).resolves.toMatchObject({
      status: "applied",
      subagent: {
        runId: settledSubagent.runId,
        delivery: { status: "delivered", disposition: "delivered" },
      },
      task: settledTask,
    });

    const successor = {
      ...structuredClone(settledSubagent),
      runId: "azure-completion-successor",
      generation: (settledSubagent.generation ?? 1) + 1,
      execution: { status: "running" as const, startedAt: Date.now() },
      delivery: { status: "pending" as const },
    };
    const activeTask = {
      ...settledTask,
      status: "running" as const,
      deliveryStatus: "pending" as const,
      endedAt: undefined,
      terminalOutcome: undefined,
    };
    const replacement: ReplaceSubagentTaskCommand = prepareTaskCohortOperation(
      "replace-subagent-task",
      {
        source: settledSubagent,
        successor,
        runChanges: [
          { runId: settledSubagent.runId, expected: settledSubagent, next: null },
          { runId: successor.runId, expected: null, next: successor },
        ],
        task: { current: settledTask, next: activeTask },
      },
    );
    await expect(
      store.replaceSubagentTask(replacement, { mode: "execute" }),
    ).resolves.toMatchObject({
      status: "applied",
      task: {
        taskId: activeTask.taskId,
        status: "running",
        deliveryStatus: "pending",
      },
      runs: [
        { runId: settledSubagent.runId, record: null },
        {
          runId: successor.runId,
          record: { runId: successor.runId, generation: successor.generation },
        },
      ],
    });
  });

  it("rolls back blocked completion queue and subagent changes when the task write fails", async () => {
    const database = new FakeAzureTaskDatabase();
    const store = new AzureSqlTaskCohortStore(database);
    const expected = records();
    database.state.subagents.set(expected.subagent.runId, JSON.stringify(expected.subagent));
    database.state.tasks.set(expected.task.taskId, JSON.stringify(expected.task));
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
        idempotencyKey: "azure-blocked-task-completion",
      },
      0,
      Date.now(),
    );
    const blocked: BlockSubagentCompletionCommand = prepareTaskCohortOperation(
      "block-subagent-completion",
      {
        expectedSubagent: expected.subagent,
        nextSubagent,
        expectedTask: expected.task,
        nextTask,
        queuedDelivery,
      },
    );
    database.failTaskWrite = true;

    await expect(store.blockSubagentCompletion(blocked, { mode: "execute" })).rejects.toThrow(
      "injected task write failure",
    );
    expect(database.state.queues.size).toBe(0);
    expect(JSON.parse(database.state.subagents.get(expected.subagent.runId)!)).toEqual(
      expected.subagent,
    );
    expect(JSON.parse(database.state.tasks.get(expected.task.taskId)!)).toEqual(expected.task);
  });

  it("binds execution identity only to the exact eligible task", async () => {
    const database = new FakeAzureTaskDatabase();
    const store = new AzureSqlTaskCohortStore(database);
    const record = task();
    const absent: TaskCohortTaskState = { taskId: record.taskId, task: null, deliveryState: null };
    const present: TaskCohortTaskState = {
      taskId: record.taskId,
      task: record,
      deliveryState: null,
    };
    await store.commitTaskState(command(absent, present), { mode: "execute" });
    const binding = { contextId: "context-1", executionId: "execution-1" };
    const bind = prepareTaskCohortOperation("bind-task-execution", {
      expectedTask: record,
      binding,
    });

    await expect(store.bindTaskExecution(bind, { mode: "execute" })).resolves.toMatchObject({
      status: "applied",
      binding,
    });
    await expect(store.bindTaskExecution(bind, { mode: "reconcile" })).resolves.toMatchObject({
      status: "already-applied",
      binding,
    });
  });

  it("rejects cron recovery when the selected task evidence advances", async () => {
    const database = new FakeAzureTaskDatabase();
    const store = new AzureSqlTaskCohortStore(database);
    const startedAt = 10_000;
    const cronTask: TaskRecord = {
      ...task("cron-task"),
      runtime: "cron",
      sourceId: "cron-job",
      runId: "cron:cron-job:10000",
      lastEventAt: startedAt,
    };
    const taskState: TaskCohortTaskState = {
      taskId: cronTask.taskId,
      task: cronTask,
      deliveryState: null,
    };
    await store.commitTaskState(
      command({ taskId: cronTask.taskId, task: null, deliveryState: null }, taskState),
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
    database.state.cronJobs.set("cron-store\u0000cron-job", {
      record_json: JSON.stringify(job),
      sort_order: 0,
    });
    const selector = { storeKey: "cron-store", jobId: job.id, startedAt };
    const expected = await store.inspectCronRunRecovery(selector);
    const nextJob = structuredClone(expected.job!);
    nextJob.job.state.runningAtMs = undefined;
    const recovery: RecoverCronRunCommand = prepareTaskCohortOperation("recover-cron-run", {
      selector,
      expected,
      next: { job: nextJob, receipt: null, task: expected.task },
    });
    const advancedTask = { ...cronTask, lastEventAt: startedAt + 1 };
    await store.commitTaskState(
      command(taskState, { taskId: cronTask.taskId, task: advancedTask, deliveryState: null }),
      { mode: "execute" },
    );

    await expect(store.recoverCronRun(recovery, { mode: "execute" })).resolves.toMatchObject({
      status: "conflict",
      reason: "task-recovery-changed",
    });
    await expect(store.inspectCronRunRecovery(selector)).resolves.toMatchObject({
      job: expected.job,
      task: advancedTask,
    });
  });

  it("rolls back a task write when its delivery companion fails", async () => {
    const database = new FakeAzureTaskDatabase();
    const store = new AzureSqlTaskCohortStore(database);
    const record = task();
    const absent: TaskCohortTaskState = {
      taskId: record.taskId,
      task: null,
      deliveryState: null,
    };
    const present: TaskCohortTaskState = {
      taskId: record.taskId,
      task: record,
      deliveryState: { taskId: record.taskId },
    };
    database.failDeliveryWrite = true;

    await expect(
      store.commitTaskState(command(absent, present), { mode: "execute" }),
    ).rejects.toThrow("injected delivery write failure");
    database.failDeliveryWrite = false;
    await expect(store.loadSnapshot()).resolves.toEqual({ tasks: [], deliveryStates: [] });
  });

  it("keeps read-only inspection migration-free and fences use after close", async () => {
    const database = new FakeAzureTaskDatabase();
    const store = new AzureSqlTaskCohortStore(database);

    await expect(store.inspectReadOnly()).resolves.toEqual({
      state: "ready",
      snapshot: { tasks: [], deliveryStates: [] },
    });
    expect(database.migrationQueries).toBe(0);

    await store.close();
    await expect(store.inspectReadOnly()).rejects.toThrow("closed");
    await expect(store.loadSnapshot()).rejects.toThrow("closed");
  });
});
