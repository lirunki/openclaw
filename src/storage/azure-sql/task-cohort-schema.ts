import type { AzureSqlMigration } from "./migrations.js";

const SCHEMA = "openclaw_global";
const IDENTITY_COLLATION = "Latin1_General_100_BIN2";
const table = (name: string) => `[${SCHEMA}].[${name}]`;

export const AZURE_SQL_TASK_RUNS_TABLE = table("task_runs");
export const AZURE_SQL_TASK_DELIVERY_STATE_TABLE = table("task_delivery_state");
export const AZURE_SQL_EXECUTION_BINDINGS_TABLE = table("execution_owner_lifecycle_bindings");
export const AZURE_SQL_SUBAGENT_RUNS_TABLE = table("subagent_runs");
export const AZURE_SQL_DELIVERY_QUEUE_TABLE = table("delivery_queue_entries");
export const AZURE_SQL_FLOW_RUNS_TABLE = table("flow_runs");
export const AZURE_SQL_CRON_JOBS_TABLE = table("cron_jobs");
export const AZURE_SQL_CRON_RECEIPTS_TABLE = table("cron_run_receipts");
export const AZURE_SQL_CRON_AUTHORITIES_TABLE = table("cron_job_runtime_authorities");
export const AZURE_SQL_CRON_SCRATCH_TABLE = table("cron_job_scratch");

const TASK_COHORT_SCHEMA_V4_SQL = `
IF SCHEMA_ID(N'${SCHEMA}') IS NULL
BEGIN
  EXEC(N'CREATE SCHEMA [${SCHEMA}]');
END;

IF OBJECT_ID(N'${AZURE_SQL_TASK_RUNS_TABLE}', N'U') IS NULL
BEGIN
  CREATE TABLE ${AZURE_SQL_TASK_RUNS_TABLE} (
    task_id_hash binary(32) NOT NULL,
    task_id nvarchar(max) COLLATE ${IDENTITY_COLLATION} NOT NULL,
    runtime nvarchar(32) COLLATE ${IDENTITY_COLLATION} NOT NULL,
    source_id_hash binary(32) NULL,
    source_id nvarchar(max) COLLATE ${IDENTITY_COLLATION} NULL,
    owner_key_hash binary(32) NOT NULL,
    owner_key nvarchar(max) COLLATE ${IDENTITY_COLLATION} NOT NULL,
    status nvarchar(32) COLLATE ${IDENTITY_COLLATION} NOT NULL,
    created_at_ms bigint NOT NULL,
    ended_at_ms bigint NULL,
    cleanup_after_ms bigint NULL,
    record_json nvarchar(max) NOT NULL,
    CONSTRAINT PK_openclaw_task_runs PRIMARY KEY (task_id_hash),
    CONSTRAINT CK_openclaw_task_runs_record_json CHECK (ISJSON(record_json) = 1)
  );
  CREATE INDEX IX_openclaw_task_runs_runtime_source
    ON ${AZURE_SQL_TASK_RUNS_TABLE}(runtime, source_id_hash, ended_at_ms, created_at_ms)
    INCLUDE (task_id_hash);
  CREATE INDEX IX_openclaw_task_runs_runtime
    ON ${AZURE_SQL_TASK_RUNS_TABLE}(runtime, ended_at_ms, created_at_ms)
    INCLUDE (task_id_hash);
  CREATE INDEX IX_openclaw_task_runs_owner
    ON ${AZURE_SQL_TASK_RUNS_TABLE}(owner_key_hash, created_at_ms)
    INCLUDE (task_id_hash);
  CREATE INDEX IX_openclaw_task_runs_status
    ON ${AZURE_SQL_TASK_RUNS_TABLE}(status, created_at_ms)
    INCLUDE (task_id_hash);
  CREATE INDEX IX_openclaw_task_runs_cleanup
    ON ${AZURE_SQL_TASK_RUNS_TABLE}(cleanup_after_ms)
    INCLUDE (task_id_hash)
    WHERE cleanup_after_ms IS NOT NULL;
END;

IF OBJECT_ID(N'${AZURE_SQL_TASK_DELIVERY_STATE_TABLE}', N'U') IS NULL
BEGIN
  CREATE TABLE ${AZURE_SQL_TASK_DELIVERY_STATE_TABLE} (
    task_id_hash binary(32) NOT NULL,
    task_id nvarchar(max) COLLATE ${IDENTITY_COLLATION} NOT NULL,
    record_json nvarchar(max) NOT NULL,
    CONSTRAINT PK_openclaw_task_delivery_state PRIMARY KEY (task_id_hash),
    CONSTRAINT FK_openclaw_task_delivery_state_task
      FOREIGN KEY (task_id_hash) REFERENCES ${AZURE_SQL_TASK_RUNS_TABLE}(task_id_hash)
      ON DELETE CASCADE,
    CONSTRAINT CK_openclaw_task_delivery_state_json CHECK (ISJSON(record_json) = 1)
  );
END;

IF OBJECT_ID(N'${AZURE_SQL_EXECUTION_BINDINGS_TABLE}', N'U') IS NULL
BEGIN
  CREATE TABLE ${AZURE_SQL_EXECUTION_BINDINGS_TABLE} (
    owner_kind nvarchar(32) COLLATE ${IDENTITY_COLLATION} NOT NULL,
    owner_id_hash binary(32) NOT NULL,
    owner_id nvarchar(max) COLLATE ${IDENTITY_COLLATION} NOT NULL,
    context_id nvarchar(max) COLLATE ${IDENTITY_COLLATION} NOT NULL,
    execution_id nvarchar(max) COLLATE ${IDENTITY_COLLATION} NOT NULL,
    CONSTRAINT PK_openclaw_execution_owner_bindings PRIMARY KEY (owner_kind, owner_id_hash)
  );
END;

IF OBJECT_ID(N'${AZURE_SQL_SUBAGENT_RUNS_TABLE}', N'U') IS NULL
BEGIN
  CREATE TABLE ${AZURE_SQL_SUBAGENT_RUNS_TABLE} (
    run_id_hash binary(32) NOT NULL,
    run_id nvarchar(max) COLLATE ${IDENTITY_COLLATION} NOT NULL,
    child_session_key_hash binary(32) NOT NULL,
    child_session_key nvarchar(max) COLLATE ${IDENTITY_COLLATION} NOT NULL,
    controller_session_key_hash binary(32) NULL,
    controller_session_key nvarchar(max) COLLATE ${IDENTITY_COLLATION} NULL,
    requester_session_key_hash binary(32) NOT NULL,
    requester_session_key nvarchar(max) COLLATE ${IDENTITY_COLLATION} NOT NULL,
    created_at_ms bigint NOT NULL,
    record_json nvarchar(max) NOT NULL,
    CONSTRAINT PK_openclaw_subagent_runs PRIMARY KEY (run_id_hash),
    CONSTRAINT CK_openclaw_subagent_runs_json CHECK (ISJSON(record_json) = 1)
  );
  CREATE INDEX IX_openclaw_subagent_runs_child
    ON ${AZURE_SQL_SUBAGENT_RUNS_TABLE}(child_session_key_hash, created_at_ms DESC)
    INCLUDE (run_id_hash);
  CREATE INDEX IX_openclaw_subagent_runs_requester
    ON ${AZURE_SQL_SUBAGENT_RUNS_TABLE}(requester_session_key_hash, created_at_ms DESC)
    INCLUDE (run_id_hash);
  CREATE INDEX IX_openclaw_subagent_runs_controller
    ON ${AZURE_SQL_SUBAGENT_RUNS_TABLE}(controller_session_key_hash, created_at_ms DESC)
    INCLUDE (run_id_hash)
    WHERE controller_session_key_hash IS NOT NULL;
END;

IF OBJECT_ID(N'${AZURE_SQL_DELIVERY_QUEUE_TABLE}', N'U') IS NULL
BEGIN
  CREATE TABLE ${AZURE_SQL_DELIVERY_QUEUE_TABLE} (
    queue_name nvarchar(128) COLLATE ${IDENTITY_COLLATION} NOT NULL,
    entry_id_hash binary(32) NOT NULL,
    entry_id nvarchar(max) COLLATE ${IDENTITY_COLLATION} NOT NULL,
    status nvarchar(32) COLLATE ${IDENTITY_COLLATION} NOT NULL,
    entry_kind nvarchar(32) COLLATE ${IDENTITY_COLLATION} NULL,
    session_key_hash binary(32) NULL,
    session_key nvarchar(max) COLLATE ${IDENTITY_COLLATION} NULL,
    channel nvarchar(max) COLLATE ${IDENTITY_COLLATION} NULL,
    target nvarchar(max) COLLATE ${IDENTITY_COLLATION} NULL,
    account_id nvarchar(max) COLLATE ${IDENTITY_COLLATION} NULL,
    retry_count int NOT NULL,
    last_attempt_at_ms bigint NULL,
    last_error nvarchar(max) NULL,
    recovery_state nvarchar(64) COLLATE ${IDENTITY_COLLATION} NULL,
    platform_send_started_at_ms bigint NULL,
    enqueued_at_ms bigint NOT NULL,
    available_at_ms bigint NULL,
    updated_at_ms bigint NOT NULL,
    failed_at_ms bigint NULL,
    record_json nvarchar(max) NOT NULL,
    CONSTRAINT PK_openclaw_delivery_queue PRIMARY KEY (queue_name, entry_id_hash),
    CONSTRAINT CK_openclaw_delivery_queue_json CHECK (ISJSON(record_json) = 1)
  );
  CREATE INDEX IX_openclaw_delivery_queue_pending
    ON ${AZURE_SQL_DELIVERY_QUEUE_TABLE}(queue_name, status, available_at_ms, enqueued_at_ms)
    INCLUDE (entry_id_hash);
  CREATE INDEX IX_openclaw_delivery_queue_session
    ON ${AZURE_SQL_DELIVERY_QUEUE_TABLE}(queue_name, status, session_key_hash, enqueued_at_ms)
    INCLUDE (entry_id_hash)
    WHERE session_key_hash IS NOT NULL;
  CREATE INDEX IX_openclaw_delivery_queue_failed
    ON ${AZURE_SQL_DELIVERY_QUEUE_TABLE}(queue_name, status, failed_at_ms)
    INCLUDE (entry_id_hash)
    WHERE failed_at_ms IS NOT NULL;
END;

IF OBJECT_ID(N'${AZURE_SQL_FLOW_RUNS_TABLE}', N'U') IS NULL
BEGIN
  CREATE TABLE ${AZURE_SQL_FLOW_RUNS_TABLE} (
    flow_id_hash binary(32) NOT NULL,
    flow_id nvarchar(max) COLLATE ${IDENTITY_COLLATION} NOT NULL,
    owner_key_hash binary(32) NOT NULL,
    owner_key nvarchar(max) COLLATE ${IDENTITY_COLLATION} NOT NULL,
    status nvarchar(32) COLLATE ${IDENTITY_COLLATION} NOT NULL,
    revision bigint NOT NULL,
    created_at_ms bigint NOT NULL,
    updated_at_ms bigint NOT NULL,
    ended_at_ms bigint NULL,
    record_json nvarchar(max) NOT NULL,
    CONSTRAINT PK_openclaw_flow_runs PRIMARY KEY (flow_id_hash),
    CONSTRAINT CK_openclaw_flow_runs_json CHECK (ISJSON(record_json) = 1)
  );
  CREATE INDEX IX_openclaw_flow_runs_owner
    ON ${AZURE_SQL_FLOW_RUNS_TABLE}(owner_key_hash, updated_at_ms DESC)
    INCLUDE (flow_id_hash);
  CREATE INDEX IX_openclaw_flow_runs_status
    ON ${AZURE_SQL_FLOW_RUNS_TABLE}(status, updated_at_ms DESC)
    INCLUDE (flow_id_hash);
END;

IF OBJECT_ID(N'${AZURE_SQL_CRON_JOBS_TABLE}', N'U') IS NULL
BEGIN
  CREATE TABLE ${AZURE_SQL_CRON_JOBS_TABLE} (
    store_key_hash binary(32) NOT NULL,
    job_id_hash binary(32) NOT NULL,
    store_key nvarchar(max) COLLATE ${IDENTITY_COLLATION} NOT NULL,
    job_id nvarchar(max) COLLATE ${IDENTITY_COLLATION} NOT NULL,
    sort_order int NOT NULL,
    updated_at_ms bigint NOT NULL,
    record_json nvarchar(max) NOT NULL,
    CONSTRAINT PK_openclaw_cron_jobs PRIMARY KEY (store_key_hash, job_id_hash),
    CONSTRAINT CK_openclaw_cron_jobs_json CHECK (ISJSON(record_json) = 1)
  );
  CREATE INDEX IX_openclaw_cron_jobs_store_order
    ON ${AZURE_SQL_CRON_JOBS_TABLE}(store_key_hash, sort_order, updated_at_ms)
    INCLUDE (job_id_hash);
END;

IF OBJECT_ID(N'${AZURE_SQL_CRON_RECEIPTS_TABLE}', N'U') IS NULL
BEGIN
  CREATE TABLE ${AZURE_SQL_CRON_RECEIPTS_TABLE} (
    receipt_id_hash binary(32) NOT NULL,
    receipt_id nvarchar(max) COLLATE ${IDENTITY_COLLATION} NOT NULL,
    store_key_hash binary(32) NOT NULL,
    store_key nvarchar(max) COLLATE ${IDENTITY_COLLATION} NOT NULL,
    job_id_hash binary(32) NOT NULL,
    job_id nvarchar(max) COLLATE ${IDENTITY_COLLATION} NOT NULL,
    config_revision nvarchar(max) COLLATE ${IDENTITY_COLLATION} NOT NULL,
    agent_id nvarchar(max) COLLATE ${IDENTITY_COLLATION} NOT NULL,
    request_run_id nvarchar(max) COLLATE ${IDENTITY_COLLATION} NULL,
    status nvarchar(32) COLLATE ${IDENTITY_COLLATION} NOT NULL,
    owner_pid int NOT NULL,
    owner_start_time bigint NULL,
    started_at_ms bigint NOT NULL,
    finished_at_ms bigint NULL,
    error_text nvarchar(max) NULL,
    CONSTRAINT PK_openclaw_cron_receipts PRIMARY KEY (receipt_id_hash),
    CONSTRAINT CK_openclaw_cron_receipts_status
      CHECK (status IN (N'running', N'ok', N'error', N'skipped', N'interrupted', N'superseded')),
    CONSTRAINT CK_openclaw_cron_receipts_finish CHECK (
      (status = N'running' AND finished_at_ms IS NULL)
      OR (status <> N'running' AND finished_at_ms IS NOT NULL)
    )
  );
  CREATE UNIQUE INDEX UX_openclaw_cron_receipts_active
    ON ${AZURE_SQL_CRON_RECEIPTS_TABLE}(store_key_hash, job_id_hash)
    WHERE status = N'running';
  CREATE INDEX IX_openclaw_cron_receipts_history
    ON ${AZURE_SQL_CRON_RECEIPTS_TABLE}(store_key_hash, job_id_hash, started_at_ms DESC)
    INCLUDE (receipt_id_hash);
END;

IF OBJECT_ID(N'${AZURE_SQL_CRON_AUTHORITIES_TABLE}', N'U') IS NULL
BEGIN
  CREATE TABLE ${AZURE_SQL_CRON_AUTHORITIES_TABLE} (
    store_key_hash binary(32) NOT NULL,
    job_id_hash binary(32) NOT NULL,
    store_key nvarchar(max) COLLATE ${IDENTITY_COLLATION} NOT NULL,
    job_id nvarchar(max) COLLATE ${IDENTITY_COLLATION} NOT NULL,
    authority_json nvarchar(max) NULL,
    authority_input_fingerprint nvarchar(max) COLLATE ${IDENTITY_COLLATION} NULL,
    recovery_required bit NOT NULL,
    CONSTRAINT PK_openclaw_cron_authorities PRIMARY KEY (store_key_hash, job_id_hash),
    CONSTRAINT FK_openclaw_cron_authorities_job
      FOREIGN KEY (store_key_hash, job_id_hash)
      REFERENCES ${AZURE_SQL_CRON_JOBS_TABLE}(store_key_hash, job_id_hash)
      ON DELETE CASCADE,
    CONSTRAINT CK_openclaw_cron_authorities_json
      CHECK (authority_json IS NULL OR ISJSON(authority_json) = 1),
    CONSTRAINT CK_openclaw_cron_authorities_state CHECK (
      (recovery_required = 0 AND authority_json IS NOT NULL AND authority_input_fingerprint IS NOT NULL)
      OR (recovery_required = 1 AND authority_json IS NULL AND authority_input_fingerprint IS NULL)
    )
  );
END;

IF OBJECT_ID(N'${AZURE_SQL_CRON_SCRATCH_TABLE}', N'U') IS NULL
BEGIN
  CREATE TABLE ${AZURE_SQL_CRON_SCRATCH_TABLE} (
    store_key_hash binary(32) NOT NULL,
    job_id_hash binary(32) NOT NULL,
    store_key nvarchar(max) COLLATE ${IDENTITY_COLLATION} NOT NULL,
    job_id nvarchar(max) COLLATE ${IDENTITY_COLLATION} NOT NULL,
    content nvarchar(max) NULL,
    revision bigint NOT NULL,
    source_sha256 char(64) NULL,
    updated_at_ms bigint NOT NULL,
    CONSTRAINT PK_openclaw_cron_scratch PRIMARY KEY (store_key_hash, job_id_hash),
    CONSTRAINT CK_openclaw_cron_scratch_revision CHECK (revision >= 1)
  );
  CREATE INDEX IX_openclaw_cron_scratch_store_updated
    ON ${AZURE_SQL_CRON_SCRATCH_TABLE}(store_key_hash, updated_at_ms DESC)
    INCLUDE (job_id_hash);
END;
`;

export const AZURE_SQL_TASK_COHORT_MIGRATION: AzureSqlMigration = {
  id: "global.task-cohort.v1",
  version: 4,
  sql: TASK_COHORT_SCHEMA_V4_SQL,
};
