import { isDeepStrictEqual } from "node:util";
import mssql from "mssql";
import { normalizeSubagentRunState } from "../../agents/subagents/registry/subagent-delivery-state.js";
import type { SubagentRunRecord } from "../../agents/subagents/registry/subagent-registry.types.js";
import type { ExecutionOwnerBinding } from "../../audit/execution-owner-binding.js";
import { loadSessionEntryReadOnly } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { getInvalidPersistedCronJobReason } from "../../cron/persisted-shape.js";
import type { CronRunReceipt } from "../../cron/store/run-receipt-store.js";
import { findLatestCronTaskRunForRecoveryFromRecords } from "../../cron/task-run-recovery.js";
import type { CronJob } from "../../cron/types.js";
import {
  SESSION_DELIVERY_QUEUE_NAME,
  type QueuedSessionDelivery,
} from "../../infra/session-delivery-queue-storage.js";
import type { TaskFlowRecord } from "../../tasks/task-flow-registry.types.js";
import { normalizeTaskTimestamps } from "../../tasks/task-registry-records.js";
import {
  parseTaskDeliveryStatus,
  parseTaskNotifyPolicy,
  parseTaskRuntime,
  parseTaskScopeKind,
  parseTaskStatus,
  type TaskDeliveryState,
  type TaskRecord,
} from "../../tasks/task-registry.types.js";
import {
  isValidAdmitSubagentCompletionCommand,
  isValidBindTaskExecutionCommand,
  isValidBlockSubagentCompletionCommand,
  isValidCommitTaskStateCommand,
  isValidRecoverCronRunCommand,
  isValidReplaceSubagentTaskCommand,
  isValidSettleSubagentCompletionCommand,
} from "../task-cohort-command-validation.js";
import { isValidTaskCohortOperation } from "../task-cohort-operation.js";
import type {
  AdmitSubagentCompletionCommand,
  AdmitSubagentCompletionResult,
  BindTaskExecutionCommand,
  BindTaskExecutionResult,
  BlockSubagentCompletionCommand,
  BlockSubagentCompletionResult,
  CommitTaskStateCommand,
  CommitTaskStateResult,
  CronRunRecoverySelector,
  CronRunRecoverySnapshot,
  RecoverCronRunCommand,
  RecoverCronRunResult,
  ReplaceSubagentTaskCommand,
  ReplaceSubagentTaskResult,
  SettleSubagentCompletionCommand,
  SettleSubagentCompletionResult,
  SubagentRunChange,
  TaskCohortMutationOptions,
  TaskCohortSnapshot,
  TaskCohortStore,
  TaskCohortTaskState,
} from "../task-cohort-store.js";
import { runAzureSqlMigrations } from "./migrations.js";
import type { AzureSqlDatabase, AzureSqlRequest, AzureSqlTransaction } from "./runtime.js";
import {
  AZURE_SQL_CRON_AUTHORITIES_TABLE,
  AZURE_SQL_CRON_JOBS_TABLE,
  AZURE_SQL_CRON_RECEIPTS_TABLE,
  AZURE_SQL_CRON_SCRATCH_TABLE,
  AZURE_SQL_DELIVERY_QUEUE_TABLE,
  AZURE_SQL_EXECUTION_BINDINGS_TABLE,
  AZURE_SQL_FLOW_RUNS_TABLE,
  AZURE_SQL_SUBAGENT_RUNS_TABLE,
  AZURE_SQL_TASK_COHORT_MIGRATION,
  AZURE_SQL_TASK_DELIVERY_STATE_TABLE,
  AZURE_SQL_TASK_RUNS_TABLE,
} from "./task-cohort-schema.js";

const COHORT_LOCK_RESOURCE = "openclaw.task-cohort.v1";
type Queryable = Pick<AzureSqlDatabase, "query"> | AzureSqlTransaction;

type JsonRow = { record_json: string };
type TaskJsonRow = JsonRow & { task_id: string };
type DeliveryJsonRow = JsonRow & { task_id: string };
type SubagentJsonRow = JsonRow & { run_id: string };
type FlowJsonRow = JsonRow & { flow_id: string };
type CronJobJsonRow = JsonRow & { store_key: string; job_id: string; sort_order: number };
type BindingRow = { owner_id: string; context_id: string; execution_id: string };
type ReceiptRow = {
  receipt_id: string;
  store_key: string;
  job_id: string;
  config_revision: string;
  agent_id: string;
  request_run_id: string | null;
  status: CronRunReceipt["status"];
  owner_pid: number;
  owner_start_time: number | string | null;
  started_at_ms: number | string;
  finished_at_ms: number | string | null;
  error_text: string | null;
};

function transportCanonicalValue(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function parseJsonObject(json: string, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    throw new Error(`Azure SQL ${label} contains invalid JSON.`, { cause: error });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Azure SQL ${label} must contain a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function safeInteger(value: number | string | null, label: string): number | null {
  if (value === null) {
    return null;
  }
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new Error(`Azure SQL ${label} contains an invalid integer.`);
  }
  return number;
}

function parseTask(row: TaskJsonRow | undefined): TaskRecord | undefined {
  if (!row) {
    return undefined;
  }
  const value = parseJsonObject(row.record_json, "task row");
  if (
    value.taskId !== row.task_id ||
    typeof value.taskId !== "string" ||
    typeof value.requesterSessionKey !== "string" ||
    typeof value.ownerKey !== "string" ||
    typeof value.task !== "string" ||
    !Number.isSafeInteger(value.createdAt)
  ) {
    throw new Error("Azure SQL task row contains invalid identity or required fields.");
  }
  parseTaskRuntime(value.runtime);
  parseTaskStatus(value.status);
  parseTaskDeliveryStatus(value.deliveryStatus);
  parseTaskNotifyPolicy(value.notifyPolicy);
  parseTaskScopeKind(value.scopeKind);
  return value as TaskRecord;
}

function parseDelivery(row: DeliveryJsonRow | undefined): TaskDeliveryState | undefined {
  if (!row) {
    return undefined;
  }
  const value = parseJsonObject(row.record_json, "task delivery row");
  if (value.taskId !== row.task_id || typeof value.taskId !== "string") {
    throw new Error("Azure SQL task delivery row contains an invalid task identity.");
  }
  if (value.lastNotifiedEventAt !== undefined && !Number.isSafeInteger(value.lastNotifiedEventAt)) {
    throw new Error("Azure SQL task delivery row contains an invalid notification timestamp.");
  }
  return value as TaskDeliveryState;
}

function parseSubagent(row: SubagentJsonRow | undefined): SubagentRunRecord | undefined {
  if (!row) {
    return undefined;
  }
  const value = parseJsonObject(row.record_json, "subagent row");
  if (
    value.runId !== row.run_id ||
    typeof value.runId !== "string" ||
    typeof value.childSessionKey !== "string" ||
    typeof value.requesterSessionKey !== "string" ||
    !Number.isSafeInteger(value.createdAt) ||
    !value.execution ||
    typeof value.execution !== "object" ||
    Array.isArray(value.execution)
  ) {
    throw new Error("Azure SQL subagent row contains invalid identity or required fields.");
  }
  return value as SubagentRunRecord;
}

function parseFlow(row: FlowJsonRow | undefined): TaskFlowRecord | undefined {
  if (!row) {
    return undefined;
  }
  const value = parseJsonObject(row.record_json, "task flow row");
  if (
    value.flowId !== row.flow_id ||
    typeof value.flowId !== "string" ||
    typeof value.ownerKey !== "string" ||
    typeof value.status !== "string" ||
    !Number.isSafeInteger(value.revision) ||
    !Number.isSafeInteger(value.createdAt) ||
    !Number.isSafeInteger(value.updatedAt)
  ) {
    throw new Error("Azure SQL task flow row contains invalid identity or required fields.");
  }
  return value as TaskFlowRecord;
}

function parseCronJob(row: CronJobJsonRow | undefined): CronRunRecoverySnapshot["job"] {
  if (!row) {
    return null;
  }
  const value = parseJsonObject(row.record_json, "cron job row");
  if (value.id !== row.job_id || typeof value.id !== "string") {
    throw new Error("Azure SQL cron job row contains an invalid job identity.");
  }
  const invalid = getInvalidPersistedCronJobReason(value);
  if (invalid) {
    throw new Error(`Azure SQL cron job row is invalid: ${invalid}`);
  }
  return { job: value as CronJob, sortOrder: row.sort_order };
}

function parseQueue(
  row: JsonRow | undefined,
  expectedId?: string,
): QueuedSessionDelivery | undefined {
  if (!row) {
    return undefined;
  }
  const value = parseJsonObject(row.record_json, "delivery queue row");
  if (
    typeof value.id !== "string" ||
    (expectedId !== undefined && value.id !== expectedId) ||
    typeof value.kind !== "string" ||
    !Number.isSafeInteger(value.enqueuedAt) ||
    !Number.isSafeInteger(value.retryCount)
  ) {
    throw new Error("Azure SQL delivery queue row contains invalid identity or required fields.");
  }
  return value as QueuedSessionDelivery;
}

function receiptFromRow(row: ReceiptRow | undefined): CronRunReceipt | undefined {
  if (!row) {
    return undefined;
  }
  const ownerStartTime = safeInteger(row.owner_start_time, "cron receipt owner start time");
  const startedAtMs = safeInteger(row.started_at_ms, "cron receipt start time");
  const finishedAtMs = safeInteger(row.finished_at_ms, "cron receipt finish time");
  if (startedAtMs === null) {
    throw new Error("Azure SQL cron receipt is missing its start time.");
  }
  return {
    receiptId: row.receipt_id,
    storeKey: row.store_key,
    jobId: row.job_id,
    configRevision: row.config_revision,
    agentId: row.agent_id,
    ...(row.request_run_id === null ? {} : { requestRunId: row.request_run_id }),
    status: row.status,
    ownerPid: row.owner_pid,
    ownerStartTime,
    startedAtMs,
    finishedAtMs,
    ...(row.error_text === null ? {} : { error: row.error_text }),
  };
}

function receiptCandidate(receipt: CronRunReceipt | undefined) {
  if (!receipt) {
    return null;
  }
  return {
    receiptId: receipt.receiptId,
    storeKey: receipt.storeKey,
    jobId: receipt.jobId,
    configRevision: receipt.configRevision,
    agentId: receipt.agentId,
    ownerPid: receipt.ownerPid,
    ownerStartTime: receipt.ownerStartTime,
    startedAtMs: receipt.startedAtMs,
  };
}

function bindText(request: AzureSqlRequest, name: string, value: string | null): void {
  request.input(name, mssql.NVarChar(mssql.MAX), value);
}

function bindId(request: AzureSqlRequest, name: string, value: string): void {
  bindText(request, name, value);
}

async function acquireCohortLock(
  transaction: AzureSqlTransaction,
  mode: "Shared" | "Exclusive",
): Promise<void> {
  await transaction.query(
    `DECLARE @lockResult int;
     EXEC @lockResult = sp_getapplock
       @Resource = @lockResource,
       @LockMode = @lockMode,
       @LockOwner = N'Transaction',
       @LockTimeout = 30000;
     IF @lockResult < 0
       THROW 51000, 'Could not acquire task-cohort transaction lock', 1;`,
    (request) => {
      request.input("lockResource", mssql.NVarChar(255), COHORT_LOCK_RESOURCE);
      request.input("lockMode", mssql.NVarChar(16), mode);
    },
  );
}

async function readTask(queryable: Queryable, taskId: string): Promise<TaskRecord | undefined> {
  const result = await queryable.query<TaskJsonRow>(
    `SELECT task_id, record_json FROM ${AZURE_SQL_TASK_RUNS_TABLE}
     WHERE task_id_hash = HASHBYTES('SHA2_256', CONVERT(varbinary(max), @taskId))
       AND task_id = @taskId`,
    (request) => bindId(request, "taskId", taskId),
  );
  return parseTask(result.rows[0]);
}

async function readDelivery(
  queryable: Queryable,
  taskId: string,
): Promise<TaskDeliveryState | undefined> {
  const result = await queryable.query<DeliveryJsonRow>(
    `SELECT task_id, record_json FROM ${AZURE_SQL_TASK_DELIVERY_STATE_TABLE}
     WHERE task_id_hash = HASHBYTES('SHA2_256', CONVERT(varbinary(max), @taskId))
       AND task_id = @taskId`,
    (request) => bindId(request, "taskId", taskId),
  );
  return parseDelivery(result.rows[0]);
}

async function readTaskState(queryable: Queryable, taskId: string): Promise<TaskCohortTaskState> {
  const task = await readTask(queryable, taskId);
  if (!task) {
    return { taskId, task: null, deliveryState: null };
  }
  return { taskId, task, deliveryState: (await readDelivery(queryable, taskId)) ?? null };
}

async function writeTask(queryable: Queryable, task: TaskRecord): Promise<void> {
  const record = normalizeTaskTimestamps(structuredClone(task));
  await queryable.query(
    `UPDATE ${AZURE_SQL_TASK_RUNS_TABLE}
       SET task_id = @taskId, runtime = @runtime,
           source_id_hash = CASE WHEN @sourceId IS NULL THEN NULL
             ELSE HASHBYTES('SHA2_256', CONVERT(varbinary(max), @sourceId)) END,
           source_id = @sourceId,
           owner_key_hash = HASHBYTES('SHA2_256', CONVERT(varbinary(max), @ownerKey)),
           owner_key = @ownerKey, status = @status, created_at_ms = @createdAt,
           ended_at_ms = @endedAt, cleanup_after_ms = @cleanupAfter, record_json = @recordJson
     WHERE task_id_hash = HASHBYTES('SHA2_256', CONVERT(varbinary(max), @taskId))
       AND task_id = @taskId;
     IF @@ROWCOUNT = 0
       INSERT INTO ${AZURE_SQL_TASK_RUNS_TABLE}
         (task_id_hash, task_id, runtime, source_id_hash, source_id,
          owner_key_hash, owner_key, status, created_at_ms, ended_at_ms,
          cleanup_after_ms, record_json)
       VALUES
         (HASHBYTES('SHA2_256', CONVERT(varbinary(max), @taskId)), @taskId, @runtime,
          CASE WHEN @sourceId IS NULL THEN NULL
            ELSE HASHBYTES('SHA2_256', CONVERT(varbinary(max), @sourceId)) END,
          @sourceId, HASHBYTES('SHA2_256', CONVERT(varbinary(max), @ownerKey)),
          @ownerKey, @status, @createdAt, @endedAt, @cleanupAfter, @recordJson);`,
    (request) => {
      bindId(request, "taskId", record.taskId);
      request.input("runtime", mssql.NVarChar(32), record.runtime);
      bindText(request, "sourceId", record.sourceId ?? null);
      bindText(request, "ownerKey", record.ownerKey);
      request.input("status", mssql.NVarChar(32), record.status);
      request.input("createdAt", mssql.BigInt(), record.createdAt);
      request.input("endedAt", mssql.BigInt(), record.endedAt ?? null);
      request.input("cleanupAfter", mssql.BigInt(), record.cleanupAfter ?? null);
      bindText(request, "recordJson", JSON.stringify(record));
    },
  );
}

async function writeDelivery(queryable: Queryable, state: TaskDeliveryState): Promise<void> {
  const record = structuredClone(state);
  await queryable.query(
    `UPDATE ${AZURE_SQL_TASK_DELIVERY_STATE_TABLE}
       SET task_id = @taskId, record_json = @recordJson
     WHERE task_id_hash = HASHBYTES('SHA2_256', CONVERT(varbinary(max), @taskId))
       AND task_id = @taskId;
     IF @@ROWCOUNT = 0
       INSERT INTO ${AZURE_SQL_TASK_DELIVERY_STATE_TABLE}
         (task_id_hash, task_id, record_json)
       VALUES
         (HASHBYTES('SHA2_256', CONVERT(varbinary(max), @taskId)), @taskId, @recordJson);`,
    (request) => {
      bindId(request, "taskId", record.taskId);
      bindText(request, "recordJson", JSON.stringify(record));
    },
  );
}

async function deleteDelivery(queryable: Queryable, taskId: string): Promise<void> {
  await queryable.query(
    `DELETE FROM ${AZURE_SQL_TASK_DELIVERY_STATE_TABLE}
     WHERE task_id_hash = HASHBYTES('SHA2_256', CONVERT(varbinary(max), @taskId))
       AND task_id = @taskId`,
    (request) => bindId(request, "taskId", taskId),
  );
}

async function deleteTaskState(queryable: Queryable, taskId: string): Promise<void> {
  await deleteDelivery(queryable, taskId);
  await queryable.query(
    `DELETE FROM ${AZURE_SQL_EXECUTION_BINDINGS_TABLE}
     WHERE owner_kind = N'task'
       AND owner_id_hash = HASHBYTES('SHA2_256', CONVERT(varbinary(max), @taskId))
       AND owner_id = @taskId;
     DELETE FROM ${AZURE_SQL_TASK_RUNS_TABLE}
     WHERE task_id_hash = HASHBYTES('SHA2_256', CONVERT(varbinary(max), @taskId))
       AND task_id = @taskId`,
    (request) => bindId(request, "taskId", taskId),
  );
}

async function writeTaskState(queryable: Queryable, state: TaskCohortTaskState): Promise<void> {
  if (!state.task) {
    await deleteTaskState(queryable, state.taskId);
    return;
  }
  await writeTask(queryable, state.task);
  if (state.deliveryState) {
    await writeDelivery(queryable, state.deliveryState);
  } else {
    await deleteDelivery(queryable, state.taskId);
  }
}

async function readBinding(
  queryable: Queryable,
  ownerKind: string,
  ownerId: string,
): Promise<ExecutionOwnerBinding | undefined> {
  const result = await queryable.query<BindingRow>(
    `SELECT owner_id, context_id, execution_id
     FROM ${AZURE_SQL_EXECUTION_BINDINGS_TABLE}
     WHERE owner_kind = @ownerKind
       AND owner_id_hash = HASHBYTES('SHA2_256', CONVERT(varbinary(max), @ownerId))
       AND owner_id = @ownerId`,
    (request) => {
      request.input("ownerKind", mssql.NVarChar(32), ownerKind);
      bindId(request, "ownerId", ownerId);
    },
  );
  const row = result.rows[0];
  return row ? { contextId: row.context_id, executionId: row.execution_id } : undefined;
}

async function insertBinding(
  queryable: Queryable,
  ownerKind: string,
  ownerId: string,
  binding: ExecutionOwnerBinding,
): Promise<void> {
  await queryable.query(
    `INSERT INTO ${AZURE_SQL_EXECUTION_BINDINGS_TABLE}
       (owner_kind, owner_id_hash, owner_id, context_id, execution_id)
     VALUES
       (@ownerKind, HASHBYTES('SHA2_256', CONVERT(varbinary(max), @ownerId)),
        @ownerId, @contextId, @executionId)`,
    (request) => {
      request.input("ownerKind", mssql.NVarChar(32), ownerKind);
      bindId(request, "ownerId", ownerId);
      bindText(request, "contextId", binding.contextId);
      bindText(request, "executionId", binding.executionId);
    },
  );
}

async function readSubagent(
  queryable: Queryable,
  runId: string,
): Promise<SubagentRunRecord | undefined> {
  const result = await queryable.query<SubagentJsonRow>(
    `SELECT run_id, record_json FROM ${AZURE_SQL_SUBAGENT_RUNS_TABLE}
     WHERE run_id_hash = HASHBYTES('SHA2_256', CONVERT(varbinary(max), @runId))
       AND run_id = @runId`,
    (request) => bindId(request, "runId", runId),
  );
  return parseSubagent(result.rows[0]);
}

async function writeSubagent(queryable: Queryable, record: SubagentRunRecord): Promise<void> {
  const value = normalizeSubagentRunState(structuredClone(record));
  await queryable.query(
    `UPDATE ${AZURE_SQL_SUBAGENT_RUNS_TABLE}
       SET run_id = @runId,
           child_session_key_hash = HASHBYTES('SHA2_256', CONVERT(varbinary(max), @childSessionKey)),
           child_session_key = @childSessionKey,
           controller_session_key_hash = CASE WHEN @controllerSessionKey IS NULL THEN NULL
             ELSE HASHBYTES('SHA2_256', CONVERT(varbinary(max), @controllerSessionKey)) END,
           controller_session_key = @controllerSessionKey,
           requester_session_key_hash = HASHBYTES('SHA2_256', CONVERT(varbinary(max), @requesterSessionKey)),
           requester_session_key = @requesterSessionKey,
           created_at_ms = @createdAt, record_json = @recordJson
     WHERE run_id_hash = HASHBYTES('SHA2_256', CONVERT(varbinary(max), @runId))
       AND run_id = @runId;
     IF @@ROWCOUNT = 0
       INSERT INTO ${AZURE_SQL_SUBAGENT_RUNS_TABLE}
         (run_id_hash, run_id, child_session_key_hash, child_session_key,
          controller_session_key_hash, controller_session_key,
          requester_session_key_hash, requester_session_key, created_at_ms, record_json)
       VALUES
         (HASHBYTES('SHA2_256', CONVERT(varbinary(max), @runId)), @runId,
          HASHBYTES('SHA2_256', CONVERT(varbinary(max), @childSessionKey)), @childSessionKey,
          CASE WHEN @controllerSessionKey IS NULL THEN NULL
            ELSE HASHBYTES('SHA2_256', CONVERT(varbinary(max), @controllerSessionKey)) END,
          @controllerSessionKey,
          HASHBYTES('SHA2_256', CONVERT(varbinary(max), @requesterSessionKey)),
          @requesterSessionKey, @createdAt, @recordJson);`,
    (request) => {
      bindId(request, "runId", value.runId);
      bindText(request, "childSessionKey", value.childSessionKey);
      bindText(request, "controllerSessionKey", value.controllerSessionKey ?? null);
      bindText(request, "requesterSessionKey", value.requesterSessionKey);
      request.input("createdAt", mssql.BigInt(), value.createdAt);
      bindText(request, "recordJson", JSON.stringify(value));
    },
  );
}

async function deleteSubagent(queryable: Queryable, runId: string): Promise<void> {
  await queryable.query(
    `DELETE FROM ${AZURE_SQL_SUBAGENT_RUNS_TABLE}
     WHERE run_id_hash = HASHBYTES('SHA2_256', CONVERT(varbinary(max), @runId))
       AND run_id = @runId`,
    (request) => bindId(request, "runId", runId),
  );
}

async function readQueue(
  queryable: Queryable,
  queueName: string,
  id: string,
): Promise<QueuedSessionDelivery | undefined> {
  const result = await queryable.query<JsonRow>(
    `SELECT record_json FROM ${AZURE_SQL_DELIVERY_QUEUE_TABLE}
     WHERE queue_name = @queueName
       AND entry_id_hash = HASHBYTES('SHA2_256', CONVERT(varbinary(max), @entryId))
       AND entry_id = @entryId`,
    (request) => {
      request.input("queueName", mssql.NVarChar(128), queueName);
      bindId(request, "entryId", id);
    },
  );
  return parseQueue(result.rows[0], id);
}

async function insertQueue(
  queryable: Queryable,
  queueName: string,
  entry: QueuedSessionDelivery,
): Promise<boolean> {
  const value = structuredClone(entry);
  const route =
    value.kind === "agentTurn" ? (value.route ?? value.deliveryContext) : value.deliveryContext;
  const result = await queryable.query<{ inserted: number }>(
    `IF EXISTS (
       SELECT 1 FROM ${AZURE_SQL_DELIVERY_QUEUE_TABLE}
       WHERE queue_name = @queueName
         AND entry_id_hash = HASHBYTES('SHA2_256', CONVERT(varbinary(max), @entryId))
     )
       SELECT CAST(0 AS int) AS inserted;
     ELSE
     BEGIN
       INSERT INTO ${AZURE_SQL_DELIVERY_QUEUE_TABLE}
         (queue_name, entry_id_hash, entry_id, status, entry_kind,
          session_key_hash, session_key, channel, target, account_id,
          retry_count, last_attempt_at_ms, last_error, recovery_state,
          platform_send_started_at_ms, enqueued_at_ms, available_at_ms,
          updated_at_ms, failed_at_ms, record_json)
       VALUES
         (@queueName, HASHBYTES('SHA2_256', CONVERT(varbinary(max), @entryId)), @entryId,
          N'pending', @entryKind,
          CASE WHEN @sessionKey IS NULL THEN NULL
            ELSE HASHBYTES('SHA2_256', CONVERT(varbinary(max), @sessionKey)) END,
          @sessionKey, @channel, @target, @accountId, @retryCount,
          @lastAttemptAt, @lastError, NULL, NULL, @enqueuedAt, @availableAt,
          @updatedAt, NULL, @recordJson);
       SELECT CAST(1 AS int) AS inserted;
     END;`,
    (request) => {
      request.input("queueName", mssql.NVarChar(128), queueName);
      bindId(request, "entryId", value.id);
      request.input("entryKind", mssql.NVarChar(32), value.kind);
      bindText(request, "sessionKey", value.sessionKey);
      bindText(request, "channel", route?.channel ?? null);
      bindText(request, "target", route?.to ?? null);
      bindText(request, "accountId", route?.accountId ?? null);
      request.input("retryCount", mssql.Int(), value.retryCount);
      request.input("lastAttemptAt", mssql.BigInt(), value.lastAttemptAt ?? null);
      bindText(request, "lastError", value.lastError ?? null);
      request.input("enqueuedAt", mssql.BigInt(), value.enqueuedAt);
      request.input("availableAt", mssql.BigInt(), value.availableAt ?? null);
      request.input("updatedAt", mssql.BigInt(), value.enqueuedAt);
      bindText(request, "recordJson", JSON.stringify(value));
    },
  );
  return result.rows[0]?.inserted === 1;
}

async function readFlow(queryable: Queryable, flowId: string): Promise<TaskFlowRecord | undefined> {
  const result = await queryable.query<FlowJsonRow>(
    `SELECT flow_id, record_json FROM ${AZURE_SQL_FLOW_RUNS_TABLE}
     WHERE flow_id_hash = HASHBYTES('SHA2_256', CONVERT(varbinary(max), @flowId))
       AND flow_id = @flowId`,
    (request) => bindId(request, "flowId", flowId),
  );
  return parseFlow(result.rows[0]);
}

async function writeFlow(queryable: Queryable, flow: TaskFlowRecord): Promise<void> {
  const value = structuredClone(flow);
  await queryable.query(
    `UPDATE ${AZURE_SQL_FLOW_RUNS_TABLE}
       SET flow_id = @flowId,
           owner_key_hash = HASHBYTES('SHA2_256', CONVERT(varbinary(max), @ownerKey)),
           owner_key = @ownerKey, status = @status, revision = @revision,
           created_at_ms = @createdAt, updated_at_ms = @updatedAt,
           ended_at_ms = @endedAt, record_json = @recordJson
     WHERE flow_id_hash = HASHBYTES('SHA2_256', CONVERT(varbinary(max), @flowId))
       AND flow_id = @flowId;
     IF @@ROWCOUNT = 0
       INSERT INTO ${AZURE_SQL_FLOW_RUNS_TABLE}
         (flow_id_hash, flow_id, owner_key_hash, owner_key, status, revision,
          created_at_ms, updated_at_ms, ended_at_ms, record_json)
       VALUES
         (HASHBYTES('SHA2_256', CONVERT(varbinary(max), @flowId)), @flowId,
          HASHBYTES('SHA2_256', CONVERT(varbinary(max), @ownerKey)), @ownerKey,
          @status, @revision, @createdAt, @updatedAt, @endedAt, @recordJson);`,
    (request) => {
      bindId(request, "flowId", value.flowId);
      bindText(request, "ownerKey", value.ownerKey);
      request.input("status", mssql.NVarChar(32), value.status);
      request.input("revision", mssql.BigInt(), value.revision);
      request.input("createdAt", mssql.BigInt(), value.createdAt);
      request.input("updatedAt", mssql.BigInt(), value.updatedAt);
      request.input("endedAt", mssql.BigInt(), value.endedAt ?? null);
      bindText(request, "recordJson", JSON.stringify(value));
    },
  );
}

async function readCronJob(
  queryable: Queryable,
  storeKey: string,
  jobId: string,
): Promise<CronRunRecoverySnapshot["job"]> {
  const result = await queryable.query<CronJobJsonRow>(
    `SELECT store_key, job_id, sort_order, record_json
     FROM ${AZURE_SQL_CRON_JOBS_TABLE}
     WHERE store_key_hash = HASHBYTES('SHA2_256', CONVERT(varbinary(max), @storeKey))
       AND job_id_hash = HASHBYTES('SHA2_256', CONVERT(varbinary(max), @jobId))
       AND store_key = @storeKey AND job_id = @jobId`,
    (request) => {
      bindId(request, "storeKey", storeKey);
      bindId(request, "jobId", jobId);
    },
  );
  return parseCronJob(result.rows[0]);
}

async function writeCronJob(
  queryable: Queryable,
  storeKey: string,
  state: NonNullable<CronRunRecoverySnapshot["job"]>,
): Promise<void> {
  const job = structuredClone(state.job);
  await queryable.query(
    `UPDATE ${AZURE_SQL_CRON_JOBS_TABLE}
       SET store_key = @storeKey, job_id = @jobId, sort_order = @sortOrder,
           updated_at_ms = @updatedAt, record_json = @recordJson
     WHERE store_key_hash = HASHBYTES('SHA2_256', CONVERT(varbinary(max), @storeKey))
       AND job_id_hash = HASHBYTES('SHA2_256', CONVERT(varbinary(max), @jobId))
       AND store_key = @storeKey AND job_id = @jobId;
     IF @@ROWCOUNT = 0
       INSERT INTO ${AZURE_SQL_CRON_JOBS_TABLE}
         (store_key_hash, job_id_hash, store_key, job_id, sort_order, updated_at_ms, record_json)
       VALUES
         (HASHBYTES('SHA2_256', CONVERT(varbinary(max), @storeKey)),
          HASHBYTES('SHA2_256', CONVERT(varbinary(max), @jobId)),
          @storeKey, @jobId, @sortOrder, @updatedAt, @recordJson);`,
    (request) => {
      bindId(request, "storeKey", storeKey);
      bindId(request, "jobId", job.id);
      request.input("sortOrder", mssql.Int(), state.sortOrder);
      request.input("updatedAt", mssql.BigInt(), job.updatedAtMs);
      bindText(request, "recordJson", JSON.stringify(job));
    },
  );
}

async function deleteCronJob(queryable: Queryable, storeKey: string, jobId: string): Promise<void> {
  await queryable.query(
    `DELETE FROM ${AZURE_SQL_CRON_SCRATCH_TABLE}
     WHERE store_key_hash = HASHBYTES('SHA2_256', CONVERT(varbinary(max), @storeKey))
       AND job_id_hash = HASHBYTES('SHA2_256', CONVERT(varbinary(max), @jobId))
       AND store_key = @storeKey AND job_id = @jobId;
     DELETE FROM ${AZURE_SQL_CRON_JOBS_TABLE}
     WHERE store_key_hash = HASHBYTES('SHA2_256', CONVERT(varbinary(max), @storeKey))
       AND job_id_hash = HASHBYTES('SHA2_256', CONVERT(varbinary(max), @jobId))
       AND store_key = @storeKey AND job_id = @jobId;`,
    (request) => {
      bindId(request, "storeKey", storeKey);
      bindId(request, "jobId", jobId);
    },
  );
}

async function readActiveReceipt(
  queryable: Queryable,
  storeKey: string,
  jobId: string,
): Promise<CronRunReceipt | undefined> {
  const result = await queryable.query<ReceiptRow>(
    `SELECT receipt_id, store_key, job_id, config_revision, agent_id, request_run_id,
            status, owner_pid, owner_start_time, started_at_ms, finished_at_ms, error_text
     FROM ${AZURE_SQL_CRON_RECEIPTS_TABLE}
     WHERE store_key_hash = HASHBYTES('SHA2_256', CONVERT(varbinary(max), @storeKey))
       AND job_id_hash = HASHBYTES('SHA2_256', CONVERT(varbinary(max), @jobId))
       AND store_key = @storeKey AND job_id = @jobId AND status = N'running'`,
    (request) => {
      bindId(request, "storeKey", storeKey);
      bindId(request, "jobId", jobId);
    },
  );
  return receiptFromRow(result.rows[0]);
}

async function readReceiptById(
  queryable: Queryable,
  receiptId: string,
): Promise<CronRunReceipt | undefined> {
  const result = await queryable.query<ReceiptRow>(
    `SELECT receipt_id, store_key, job_id, config_revision, agent_id, request_run_id,
            status, owner_pid, owner_start_time, started_at_ms, finished_at_ms, error_text
     FROM ${AZURE_SQL_CRON_RECEIPTS_TABLE}
     WHERE receipt_id_hash = HASHBYTES('SHA2_256', CONVERT(varbinary(max), @receiptId))
       AND receipt_id = @receiptId`,
    (request) => bindId(request, "receiptId", receiptId),
  );
  return receiptFromRow(result.rows[0]);
}

async function finishReceipt(
  queryable: Queryable,
  completion: NonNullable<RecoverCronRunCommand["next"]["receipt"]>,
): Promise<CronRunReceipt | undefined> {
  const { handle } = completion;
  await queryable.query(
    `UPDATE ${AZURE_SQL_CRON_RECEIPTS_TABLE}
       SET status = @status, finished_at_ms = @finishedAt, error_text = @error
     WHERE receipt_id_hash = HASHBYTES('SHA2_256', CONVERT(varbinary(max), @receiptId))
       AND receipt_id = @receiptId AND status = N'running' AND owner_pid = @ownerPid
       AND ((owner_start_time IS NULL AND @ownerStartTime IS NULL)
         OR owner_start_time = @ownerStartTime)`,
    (request) => {
      bindId(request, "receiptId", handle.receiptId);
      request.input("status", mssql.NVarChar(32), completion.status);
      request.input("finishedAt", mssql.BigInt(), completion.finishedAtMs);
      bindText(request, "error", completion.error ?? null);
      request.input("ownerPid", mssql.Int(), handle.ownerPid);
      request.input("ownerStartTime", mssql.BigInt(), handle.ownerStartTime);
    },
  );
  return await readReceiptById(queryable, handle.receiptId);
}

function recordsEqual<T>(left: T | null | undefined, right: T | null): boolean {
  if (left == null || right === null) {
    return left == null && right === null;
  }
  return isDeepStrictEqual(transportCanonicalValue(left), transportCanonicalValue(right));
}

function taskStatesEqual(left: TaskCohortTaskState, right: TaskCohortTaskState): boolean {
  return (
    left.taskId === right.taskId &&
    recordsEqual(left.task, right.task) &&
    recordsEqual(left.deliveryState, right.deliveryState)
  );
}

function unknownOutcome(operationId: string) {
  return {
    operationId,
    status: "outcome-unknown" as const,
    reason: "postcondition-not-proven" as const,
  };
}

function invalidOperation(operationId: string) {
  return {
    operationId,
    status: "conflict" as const,
    reason: "operation-id-mismatch" as const,
  };
}

function invalidCommand(operationId: string) {
  return { operationId, status: "conflict" as const, reason: "invalid-command" as const };
}

function reconcileAcceptedReceipt(
  command: ReplaceSubagentTaskCommand,
  storedSource: SubagentRunRecord,
): SubagentRunRecord {
  const evidence = command.acceptedRestartReceipt;
  const storedReceipt = storedSource.execution.restartRecovery;
  if (!evidence || (storedReceipt?.phase !== "attempted" && storedReceipt?.phase !== "consumed")) {
    return storedSource;
  }
  const sessionKey = evidence.sessionTarget.sessionKey;
  const receiptIdentityMatches =
    storedReceipt.sessionId === evidence.receipt.sessionId &&
    storedReceipt.sessionMarker === evidence.receipt.sessionMarker &&
    storedReceipt.sessionLifecycleRevision === evidence.receipt.sessionLifecycleRevision &&
    storedReceipt.idempotencyKey === evidence.receipt.idempotencyKey &&
    storedReceipt.lifecycleGeneration === evidence.receipt.lifecycleGeneration;
  if (!sessionKey || !receiptIdentityMatches) {
    return storedSource;
  }
  const session = loadSessionEntryReadOnly({ ...evidence.sessionTarget, sessionKey });
  if (
    session?.sessionId !== evidence.receipt.sessionId ||
    (evidence.receipt.sessionLifecycleRevision !== undefined &&
      session.lifecycleRevision !== evidence.receipt.sessionLifecycleRevision)
  ) {
    return storedSource;
  }
  const reconciled = structuredClone(storedSource);
  reconciled.execution.restartRecovery = structuredClone(evidence.receipt);
  return reconciled;
}

function receiptCompletionMatches(
  receipt: CronRunReceipt | undefined,
  completion: RecoverCronRunCommand["next"]["receipt"],
): boolean {
  if (!completion) {
    return receipt === undefined;
  }
  const { handle } = completion;
  return (
    receipt?.receiptId === handle.receiptId &&
    receipt.storeKey === handle.storeKey &&
    receipt.jobId === handle.jobId &&
    receipt.configRevision === handle.configRevision &&
    receipt.agentId === handle.agentId &&
    receipt.ownerPid === handle.ownerPid &&
    receipt.ownerStartTime === handle.ownerStartTime &&
    receipt.startedAtMs === handle.startedAtMs &&
    receipt.status === completion.status &&
    receipt.finishedAtMs === completion.finishedAtMs &&
    receipt.error === completion.error
  );
}

type AzureSqlTaskCohortDatabase = Pick<AzureSqlDatabase, "close" | "query" | "transaction">;

export class AzureSqlTaskCohortStore implements TaskCohortStore {
  private schemaReady: Promise<void> | undefined;
  private closed = false;

  constructor(
    private readonly database: AzureSqlTaskCohortDatabase,
    private readonly closeDatabase: () => Promise<void> = async () => await database.close(),
  ) {}

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("Azure SQL task cohort store is closed.");
    }
  }

  private async ensureSchema(): Promise<void> {
    this.assertOpen();
    this.schemaReady ??= runAzureSqlMigrations(this.database, [
      AZURE_SQL_TASK_COHORT_MIGRATION,
    ]).then(() => undefined);
    try {
      await this.schemaReady;
    } catch (error) {
      this.schemaReady = undefined;
      throw error;
    }
  }

  private async transaction<T>(
    mode: "Shared" | "Exclusive",
    operation: (transaction: AzureSqlTransaction) => Promise<T>,
  ): Promise<T> {
    await this.ensureSchema();
    return await this.database.transaction(async (transaction) => {
      await acquireCohortLock(transaction, mode);
      return await operation(transaction);
    });
  }

  private async loadSnapshotInTransaction(
    transaction: AzureSqlTransaction,
  ): Promise<TaskCohortSnapshot> {
    const taskResult = await transaction.query<TaskJsonRow>(
      `SELECT task_id, record_json FROM ${AZURE_SQL_TASK_RUNS_TABLE}`,
    );
    const deliveryResult = await transaction.query<DeliveryJsonRow>(
      `SELECT task_id, record_json FROM ${AZURE_SQL_TASK_DELIVERY_STATE_TABLE}`,
    );
    const tasks = taskResult.rows
      .map((row) => parseTask(row)!)
      .toSorted(
        (left, right) =>
          left.createdAt - right.createdAt || left.taskId.localeCompare(right.taskId),
      );
    const deliveryStates = deliveryResult.rows
      .map((row) => parseDelivery(row)!)
      .toSorted((left, right) => left.taskId.localeCompare(right.taskId));
    return { tasks, deliveryStates };
  }

  async loadSnapshot(): Promise<TaskCohortSnapshot> {
    return await this.transaction(
      "Shared",
      async (transaction) => await this.loadSnapshotInTransaction(transaction),
    );
  }

  async inspectReadOnly(): Promise<{
    state: "ready" | "migration-required";
    snapshot: TaskCohortSnapshot;
  }> {
    this.assertOpen();
    try {
      const readiness = await this.database.query<{
        task_table: number | null;
        delivery_table: number | null;
        binding_table: number | null;
        subagent_table: number | null;
        queue_table: number | null;
        flow_table: number | null;
        cron_job_table: number | null;
        cron_receipt_table: number | null;
        cron_authority_table: number | null;
        cron_scratch_table: number | null;
      }>(
        `SELECT OBJECT_ID(N'${AZURE_SQL_TASK_RUNS_TABLE}', N'U') AS task_table,
                OBJECT_ID(N'${AZURE_SQL_TASK_DELIVERY_STATE_TABLE}', N'U') AS delivery_table,
                OBJECT_ID(N'${AZURE_SQL_EXECUTION_BINDINGS_TABLE}', N'U') AS binding_table,
                OBJECT_ID(N'${AZURE_SQL_SUBAGENT_RUNS_TABLE}', N'U') AS subagent_table,
                OBJECT_ID(N'${AZURE_SQL_DELIVERY_QUEUE_TABLE}', N'U') AS queue_table,
                OBJECT_ID(N'${AZURE_SQL_FLOW_RUNS_TABLE}', N'U') AS flow_table,
                OBJECT_ID(N'${AZURE_SQL_CRON_JOBS_TABLE}', N'U') AS cron_job_table,
                OBJECT_ID(N'${AZURE_SQL_CRON_RECEIPTS_TABLE}', N'U') AS cron_receipt_table,
                OBJECT_ID(N'${AZURE_SQL_CRON_AUTHORITIES_TABLE}', N'U') AS cron_authority_table,
                OBJECT_ID(N'${AZURE_SQL_CRON_SCRATCH_TABLE}', N'U') AS cron_scratch_table`,
      );
      const row = readiness.rows[0];
      if (!row || Object.values(row).some((value) => !value)) {
        return { state: "migration-required", snapshot: { tasks: [], deliveryStates: [] } };
      }
      const snapshot = await this.database.transaction(async (transaction) => {
        await acquireCohortLock(transaction, "Shared");
        return await this.loadSnapshotInTransaction(transaction);
      });
      return { state: "ready", snapshot };
    } catch (error) {
      throw new Error("Failed to inspect Azure SQL task-cohort schema.", { cause: error });
    }
  }

  async listTasksForOwnerKey(ownerKey: string): Promise<TaskRecord[]> {
    if (!ownerKey.trim()) {
      return [];
    }
    await this.ensureSchema();
    const result = await this.database.query<TaskJsonRow>(
      `SELECT task_id, record_json FROM ${AZURE_SQL_TASK_RUNS_TABLE}
       WHERE owner_key_hash = HASHBYTES('SHA2_256', CONVERT(varbinary(max), @ownerKey))
         AND owner_key = @ownerKey`,
      (request) => bindText(request, "ownerKey", ownerKey),
    );
    return result.rows
      .map((row) => parseTask(row)!)
      .toSorted(
        (left, right) =>
          left.createdAt - right.createdAt || left.taskId.localeCompare(right.taskId),
      );
  }

  async listTasksByRuntimeSource(
    params: Parameters<TaskCohortStore["listTasksByRuntimeSource"]>[0],
  ): Promise<TaskRecord[]> {
    if (params.sourceId !== undefined && !params.sourceId.trim()) {
      return [];
    }
    await this.ensureSchema();
    const result = await this.database.query<TaskJsonRow>(
      `SELECT task_id, record_json FROM ${AZURE_SQL_TASK_RUNS_TABLE}
       WHERE runtime = @runtime
         ${params.sourceId === undefined ? "" : `AND source_id_hash = HASHBYTES('SHA2_256', CONVERT(varbinary(max), @sourceId)) AND source_id = @sourceId`}`,
      (request) => {
        request.input("runtime", mssql.NVarChar(32), params.runtime);
        if (params.sourceId !== undefined) {
          bindText(request, "sourceId", params.sourceId);
        }
      },
    );
    return result.rows
      .map((row) => parseTask(row)!)
      .toSorted(
        (left, right) =>
          left.createdAt - right.createdAt || left.taskId.localeCompare(right.taskId),
      );
  }

  async commitTaskState(
    command: CommitTaskStateCommand,
    options: TaskCohortMutationOptions,
  ): Promise<CommitTaskStateResult> {
    if (!isValidTaskCohortOperation("commit-task-state", command)) {
      return invalidOperation(command.operationId);
    }
    if (!isValidCommitTaskStateCommand(command)) {
      return invalidCommand(command.operationId);
    }
    return await this.transaction("Exclusive", async (transaction) => {
      const current = await readTaskState(transaction, command.expected.taskId);
      if (taskStatesEqual(current, command.next)) {
        return { operationId: command.operationId, status: "already-applied", state: current };
      }
      if (options.mode === "reconcile") {
        return unknownOutcome(command.operationId);
      }
      if (!recordsEqual(current.task, command.expected.task)) {
        return {
          operationId: command.operationId,
          status: "conflict",
          reason: "task-changed",
          current,
        };
      }
      if (!recordsEqual(current.deliveryState, command.expected.deliveryState)) {
        return {
          operationId: command.operationId,
          status: "conflict",
          reason: "delivery-state-changed",
          current,
        };
      }
      await writeTaskState(transaction, command.next);
      return {
        operationId: command.operationId,
        status: "applied",
        state: await readTaskState(transaction, command.next.taskId),
      };
    });
  }

  async bindTaskExecution(
    command: BindTaskExecutionCommand,
    options: TaskCohortMutationOptions,
  ): Promise<BindTaskExecutionResult> {
    if (!isValidTaskCohortOperation("bind-task-execution", command)) {
      return invalidOperation(command.operationId);
    }
    if (!isValidBindTaskExecutionCommand(command)) {
      return invalidCommand(command.operationId);
    }
    return await this.transaction("Exclusive", async (transaction) => {
      const currentTask = await readTask(transaction, command.expectedTask.taskId);
      const currentBinding = await readBinding(transaction, "task", command.expectedTask.taskId);
      const taskMatches = recordsEqual(currentTask, command.expectedTask);
      if (taskMatches && isDeepStrictEqual(currentBinding, command.binding)) {
        return {
          operationId: command.operationId,
          status: "already-applied",
          binding: command.binding,
        };
      }
      if (options.mode === "reconcile") {
        return unknownOutcome(command.operationId);
      }
      if (!taskMatches) {
        return { operationId: command.operationId, status: "conflict", reason: "task-changed" };
      }
      if (
        (currentTask?.status !== "queued" && currentTask?.status !== "running") ||
        currentTask.endedAt != null
      ) {
        return { operationId: command.operationId, status: "conflict", reason: "task-ineligible" };
      }
      if (currentBinding) {
        return { operationId: command.operationId, status: "conflict", reason: "binding-mismatch" };
      }
      await insertBinding(transaction, "task", command.expectedTask.taskId, command.binding);
      return { operationId: command.operationId, status: "applied", binding: command.binding };
    });
  }

  async admitSubagentCompletion(
    command: AdmitSubagentCompletionCommand,
    options: TaskCohortMutationOptions,
  ): Promise<AdmitSubagentCompletionResult> {
    if (!isValidTaskCohortOperation("admit-subagent-completion", command)) {
      return invalidOperation(command.operationId);
    }
    if (!isValidAdmitSubagentCompletionCommand(command)) {
      return invalidCommand(command.operationId);
    }
    return await this.transaction("Exclusive", async (transaction) => {
      const currentQueue = await readQueue(
        transaction,
        SESSION_DELIVERY_QUEUE_NAME,
        command.queueEntry.id,
      );
      const currentSubagent = await readSubagent(transaction, command.nextSubagent.runId);
      const currentTask = await readTask(transaction, command.nextTask.taskId);
      if (
        recordsEqual(currentQueue, command.queueEntry) &&
        recordsEqual(currentSubagent, command.nextSubagent) &&
        recordsEqual(currentTask, command.nextTask)
      ) {
        return {
          operationId: command.operationId,
          status: "already-applied",
          claimed: false,
          queueEntry: currentQueue!,
          subagent: currentSubagent!,
          task: currentTask!,
        };
      }
      if (options.mode === "reconcile") {
        return unknownOutcome(command.operationId);
      }
      if (currentQueue) {
        return {
          operationId: command.operationId,
          status: "conflict",
          reason: "queue-owner-changed",
        };
      }
      if (
        currentSubagent
          ? !recordsEqual(currentSubagent, command.expectedSubagent.record)
          : !command.expectedSubagent.allowAbsent
      ) {
        return { operationId: command.operationId, status: "conflict", reason: "subagent-changed" };
      }
      if (
        currentTask
          ? !recordsEqual(currentTask, command.expectedTask.record)
          : !command.expectedTask.allowAbsent
      ) {
        return { operationId: command.operationId, status: "conflict", reason: "task-changed" };
      }
      if (!(await insertQueue(transaction, SESSION_DELIVERY_QUEUE_NAME, command.queueEntry))) {
        return {
          operationId: command.operationId,
          status: "conflict",
          reason: "queue-owner-changed",
        };
      }
      await writeSubagent(transaction, command.nextSubagent);
      await writeTask(transaction, command.nextTask);
      return {
        operationId: command.operationId,
        status: "applied",
        claimed: true,
        queueEntry: command.queueEntry,
        subagent: (await readSubagent(transaction, command.nextSubagent.runId))!,
        task: (await readTask(transaction, command.nextTask.taskId))!,
      };
    });
  }

  async settleSubagentCompletion(
    command: SettleSubagentCompletionCommand,
    options: TaskCohortMutationOptions,
  ): Promise<SettleSubagentCompletionResult> {
    if (!isValidTaskCohortOperation("settle-subagent-completion", command)) {
      return invalidOperation(command.operationId);
    }
    if (!isValidSettleSubagentCompletionCommand(command)) {
      return invalidCommand(command.operationId);
    }
    return await this.transaction("Exclusive", async (transaction) => {
      const currentSubagent = await readSubagent(transaction, command.expectedSubagent.runId);
      const currentTask = await readTask(transaction, command.expectedTask.taskId);
      if (
        recordsEqual(currentSubagent, command.nextSubagent) &&
        recordsEqual(currentTask, command.nextTask)
      ) {
        return {
          operationId: command.operationId,
          status: "already-applied",
          subagent: currentSubagent!,
          task: currentTask!,
        };
      }
      if (options.mode === "reconcile") {
        return unknownOutcome(command.operationId);
      }
      if (!recordsEqual(currentSubagent, command.expectedSubagent)) {
        return { operationId: command.operationId, status: "conflict", reason: "subagent-changed" };
      }
      if (!recordsEqual(currentTask, command.expectedTask)) {
        return { operationId: command.operationId, status: "conflict", reason: "task-changed" };
      }
      await writeSubagent(transaction, command.nextSubagent);
      await writeTask(transaction, command.nextTask);
      return {
        operationId: command.operationId,
        status: "applied",
        subagent: (await readSubagent(transaction, command.nextSubagent.runId))!,
        task: (await readTask(transaction, command.nextTask.taskId))!,
      };
    });
  }

  async blockSubagentCompletion(
    command: BlockSubagentCompletionCommand,
    options: TaskCohortMutationOptions,
  ): Promise<BlockSubagentCompletionResult> {
    if (!isValidTaskCohortOperation("block-subagent-completion", command)) {
      return invalidOperation(command.operationId);
    }
    if (!isValidBlockSubagentCompletionCommand(command)) {
      return invalidCommand(command.operationId);
    }
    return await this.transaction("Exclusive", async (transaction) => {
      const currentSubagent = await readSubagent(transaction, command.expectedSubagent.runId);
      const currentTask = await readTask(transaction, command.expectedTask.taskId);
      const currentQueue = command.queuedDelivery
        ? await readQueue(transaction, SESSION_DELIVERY_QUEUE_NAME, command.queuedDelivery.id)
        : undefined;
      if (
        recordsEqual(currentSubagent, command.nextSubagent) &&
        recordsEqual(currentTask, command.nextTask) &&
        recordsEqual(currentQueue, command.queuedDelivery ?? null)
      ) {
        return {
          operationId: command.operationId,
          status: "already-applied",
          subagent: currentSubagent!,
          task: currentTask!,
          ...(currentQueue ? { queuedDelivery: currentQueue } : {}),
        };
      }
      if (options.mode === "reconcile") {
        return unknownOutcome(command.operationId);
      }
      if (!recordsEqual(currentSubagent, command.expectedSubagent)) {
        return { operationId: command.operationId, status: "conflict", reason: "subagent-changed" };
      }
      if (!recordsEqual(currentTask, command.expectedTask)) {
        return { operationId: command.operationId, status: "conflict", reason: "task-changed" };
      }
      if (currentQueue) {
        return { operationId: command.operationId, status: "conflict", reason: "queue-changed" };
      }
      if (
        command.queuedDelivery &&
        !(await insertQueue(transaction, SESSION_DELIVERY_QUEUE_NAME, command.queuedDelivery))
      ) {
        return { operationId: command.operationId, status: "conflict", reason: "queue-changed" };
      }
      await writeSubagent(transaction, command.nextSubagent);
      await writeTask(transaction, command.nextTask);
      return {
        operationId: command.operationId,
        status: "applied",
        subagent: (await readSubagent(transaction, command.nextSubagent.runId))!,
        task: (await readTask(transaction, command.nextTask.taskId))!,
        ...(command.queuedDelivery ? { queuedDelivery: command.queuedDelivery } : {}),
      };
    });
  }

  async replaceSubagentTask(
    command: ReplaceSubagentTaskCommand,
    options: TaskCohortMutationOptions,
  ): Promise<ReplaceSubagentTaskResult> {
    if (!isValidTaskCohortOperation("replace-subagent-task", command)) {
      return invalidOperation(command.operationId);
    }
    if (!isValidReplaceSubagentTaskCommand(command)) {
      return invalidCommand(command.operationId);
    }
    return await this.transaction("Exclusive", async (transaction) => {
      const currentRuns = [] as Array<{
        change: SubagentRunChange;
        current: SubagentRunRecord | undefined;
      }>;
      for (const change of command.runChanges) {
        currentRuns.push({ change, current: await readSubagent(transaction, change.runId) });
      }
      const currentTask = await readTask(transaction, command.task.current.taskId);
      const currentFlow = command.flow
        ? await readFlow(transaction, command.flow.current.flowId)
        : undefined;
      const nextMatches =
        currentRuns.every(({ change, current }) => recordsEqual(current, change.next)) &&
        recordsEqual(currentTask, command.task.next) &&
        (!command.flow || recordsEqual(currentFlow, command.flow.next));
      if (nextMatches) {
        return {
          operationId: command.operationId,
          status: "already-applied",
          runs: currentRuns.map(({ change, current }) => ({
            runId: change.runId,
            record: current ?? null,
          })),
          task: currentTask!,
          ...(currentFlow ? { flow: currentFlow } : {}),
        };
      }
      if (options.mode === "reconcile") {
        return unknownOutcome(command.operationId);
      }
      const sourceEntry = currentRuns.find(({ change }) => change.runId === command.source.runId);
      if (sourceEntry?.current) {
        sourceEntry.current = reconcileAcceptedReceipt(command, sourceEntry.current);
      }
      if (!recordsEqual(sourceEntry?.current, command.source)) {
        return { operationId: command.operationId, status: "conflict", reason: "source-changed" };
      }
      if (currentRuns.some(({ change, current }) => !recordsEqual(current, change.expected))) {
        return { operationId: command.operationId, status: "conflict", reason: "run-changed" };
      }
      if (!recordsEqual(currentTask, command.task.current)) {
        return { operationId: command.operationId, status: "conflict", reason: "task-changed" };
      }
      if (command.flow && !recordsEqual(currentFlow, command.flow.current)) {
        return { operationId: command.operationId, status: "conflict", reason: "flow-changed" };
      }
      for (const change of command.runChanges) {
        if (change.next) {
          await writeSubagent(transaction, change.next);
        } else {
          await deleteSubagent(transaction, change.runId);
        }
      }
      await writeTask(transaction, command.task.next);
      if (command.flow) {
        await writeFlow(transaction, command.flow.next);
      }
      const runs = [] as Array<{ runId: string; record: SubagentRunRecord | null }>;
      for (const change of command.runChanges) {
        runs.push({
          runId: change.runId,
          record: (await readSubagent(transaction, change.runId)) ?? null,
        });
      }
      return {
        operationId: command.operationId,
        status: "applied",
        runs,
        task: (await readTask(transaction, command.task.next.taskId))!,
        ...(command.flow ? { flow: (await readFlow(transaction, command.flow.next.flowId))! } : {}),
      };
    });
  }

  private async cronSnapshot(
    queryable: Queryable,
    selector: CronRunRecoverySelector,
  ): Promise<CronRunRecoverySnapshot> {
    const job = await readCronJob(queryable, selector.storeKey, selector.jobId);
    const receipt = await readActiveReceipt(queryable, selector.storeKey, selector.jobId);
    const tasks = await this.listTasksByRuntimeSourceInQueryable(queryable, {
      runtime: "cron",
      sourceId: selector.jobId,
    });
    const task = findLatestCronTaskRunForRecoveryFromRecords(
      tasks,
      selector.jobId,
      selector.startedAt,
      selector.storeKey,
      selector.receiptId,
    );
    return { job, receipt: receiptCandidate(receipt), task: task ?? null };
  }

  private async listTasksByRuntimeSourceInQueryable(
    queryable: Queryable,
    params: Parameters<TaskCohortStore["listTasksByRuntimeSource"]>[0],
  ): Promise<TaskRecord[]> {
    const result = await queryable.query<TaskJsonRow>(
      `SELECT task_id, record_json FROM ${AZURE_SQL_TASK_RUNS_TABLE}
       WHERE runtime = @runtime
         ${params.sourceId === undefined ? "" : `AND source_id_hash = HASHBYTES('SHA2_256', CONVERT(varbinary(max), @sourceId)) AND source_id = @sourceId`}`,
      (request) => {
        request.input("runtime", mssql.NVarChar(32), params.runtime);
        if (params.sourceId !== undefined) {
          bindText(request, "sourceId", params.sourceId);
        }
      },
    );
    return result.rows.map((row) => parseTask(row)!);
  }

  async inspectCronRunRecovery(
    selector: CronRunRecoverySelector,
  ): Promise<CronRunRecoverySnapshot> {
    return await this.transaction(
      "Shared",
      async (transaction) => await this.cronSnapshot(transaction, selector),
    );
  }

  async recoverCronRun(
    command: RecoverCronRunCommand,
    options: TaskCohortMutationOptions,
  ): Promise<RecoverCronRunResult> {
    if (!isValidTaskCohortOperation("recover-cron-run", command)) {
      return invalidOperation(command.operationId);
    }
    if (!isValidRecoverCronRunCommand(command)) {
      return invalidCommand(command.operationId);
    }
    return await this.transaction("Exclusive", async (transaction) => {
      const current = await this.cronSnapshot(transaction, command.selector);
      const terminalReceipt = command.next.receipt
        ? await readReceiptById(transaction, command.next.receipt.handle.receiptId)
        : undefined;
      const nextMatches =
        recordsEqual(current.job, command.next.job) &&
        recordsEqual(current.task, command.next.task) &&
        current.receipt === null &&
        receiptCompletionMatches(terminalReceipt, command.next.receipt);
      if (nextMatches) {
        return { operationId: command.operationId, status: "already-applied", state: command.next };
      }
      if (options.mode === "reconcile") {
        return unknownOutcome(command.operationId);
      }
      if (!recordsEqual(current.job, command.expected.job)) {
        return { operationId: command.operationId, status: "conflict", reason: "job-changed" };
      }
      if (!recordsEqual(current.receipt, command.expected.receipt)) {
        return { operationId: command.operationId, status: "conflict", reason: "receipt-changed" };
      }
      if (!recordsEqual(current.task, command.expected.task)) {
        return {
          operationId: command.operationId,
          status: "conflict",
          reason: "task-recovery-changed",
        };
      }
      if (command.next.job) {
        await writeCronJob(transaction, command.selector.storeKey, command.next.job);
      } else if (command.expected.job) {
        await deleteCronJob(transaction, command.selector.storeKey, command.selector.jobId);
      }
      if (command.next.receipt) {
        const receipt = await finishReceipt(transaction, command.next.receipt);
        if (!receiptCompletionMatches(receipt, command.next.receipt)) {
          throw new Error("Azure SQL cron run recovery receipt changed during commit.");
        }
      }
      return { operationId: command.operationId, status: "applied", state: command.next };
    });
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.closeDatabase();
  }
}
