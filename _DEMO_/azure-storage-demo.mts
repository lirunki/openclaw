import fs from "node:fs";
import path from "node:path";
import mssql from "mssql";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import {
  AzureSqlPluginStateSyncBridge,
  closePluginStateSyncBridgeWorker,
} from "../src/plugin-state/plugin-state-sync-bridge.js";
import {
  AzureSqlPluginStateStore,
  type AzureSqlPluginStateScope,
} from "../src/storage/azure-sql/plugin-state-store.js";
import { AzureSqlProjectRegistryStore } from "../src/storage/azure-sql/project-registry-store.js";
import { AzureSqlDatabase, type AzureSqlRequest } from "../src/storage/azure-sql/runtime.js";
import { AzureSqlTaskCohortStore } from "../src/storage/azure-sql/task-cohort-store.js";
import { prepareTaskCohortOperation } from "../src/storage/task-cohort-operation.js";
import type { TaskCohortTaskState } from "../src/storage/task-cohort-store.js";
import type { TaskDeliveryState, TaskRecord } from "../src/tasks/task-registry.types.js";

type DemoArguments = {
  action: "hold" | "inspect" | "task-demo" | "cleanup" | "write-sql";
  credentialFile: string;
  pluginId: string;
  projectId: string;
  repoRoot: string;
  runtimeDir: string;
};

type CredentialValues = {
  connectionString: string;
  username: string;
  password: string;
};

type DemoCleanupSummary = {
  cleanedProjectRows: number;
  cleanedLeaseRows: number;
  cleanedPluginStateRows: number;
  cleanedTaskRows: number;
  cleanedTaskDeliveryRows: number;
  remainingProjectRows: number;
  remainingLeaseRows: number;
  remainingPluginStateRows: number;
  remainingTaskRows: number;
  remainingTaskDeliveryRows: number;
};

const DEMO_DISPLAY_NAME = "OpenClaw Azure SQL Storage Demo";
const DEMO_PLUGIN_NAMESPACE = "storage-demo";
const DEMO_DIRECT_PLUGIN_KEY = "current-project-direct";
const DEMO_MAILBOX_PLUGIN_KEY = "current-project-mailbox";
const DEMO_PASSWORD_ENV = "OPENCLAW_AZURE_SQL_DEMO_PASSWORD";
const TASK_MIGRATION_ID = "global.task-cohort.v1";
const READY_FILE = "ready.json";
const RELEASED_FILE = "released.json";
const CLEANUP_RESULT_FILE = "cleanup-result.json";
const RELEASE_SIGNAL_FILE = "release";
const CLEANUP_SIGNAL_FILE = "cleanup";

function requiredArgument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1]?.trim() : undefined;
  if (!value) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

function parseArguments(): DemoArguments {
  const action = process.argv[2];
  if (
    action !== "hold" &&
    action !== "inspect" &&
    action !== "task-demo" &&
    action !== "cleanup" &&
    action !== "write-sql"
  ) {
    throw new Error("Expected action: hold, inspect, task-demo, cleanup, or write-sql");
  }
  return {
    action,
    credentialFile: requiredArgument("--credential-file"),
    pluginId: requiredArgument("--plugin-id"),
    projectId: requiredArgument("--project-id"),
    repoRoot: requiredArgument("--repo-root"),
    runtimeDir: requiredArgument("--runtime-dir"),
  };
}

function readCredentials(filePath: string): CredentialValues {
  const values = new Map<string, string>();
  const content = fs.readFileSync(filePath, "utf8");
  for (const line of content.split(/\r?\n/u)) {
    if (!line.trim()) {
      continue;
    }
    const separator = line.indexOf(":");
    if (separator <= 0) {
      throw new Error("Credential file contains an invalid line");
    }
    values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  const connectionString = values.get("connection_string");
  const username = values.get("dbuser");
  const password = values.get("dbpassword");
  if (!connectionString || !username || !password) {
    throw new Error("Credential file must contain connection_string, dbuser, and dbpassword");
  }
  return { connectionString, username, password };
}

function parseDatabaseIdentity(credentials: CredentialValues): {
  server: string;
  database: string;
  port?: number;
} {
  const parsed = mssql.ConnectionPool.parseConnectionString(credentials.connectionString);
  if (!parsed.server || !parsed.database) {
    throw new Error("Connection string must identify an Azure SQL server and database");
  }
  return {
    server: parsed.server,
    database: parsed.database,
    ...(Number.isInteger(parsed.port) ? { port: parsed.port } : {}),
  };
}

function createDatabase(credentials: CredentialValues): AzureSqlDatabase {
  return new AzureSqlDatabase({
    ...parseDatabaseIdentity(credentials),
    sqlPassword: { username: credentials.username, password: credentials.password },
    connectionTimeoutMs: 30_000,
    requestTimeoutMs: 30_000,
  });
}

function createMailboxBridge(
  credentials: CredentialValues,
  scope: AzureSqlPluginStateScope,
): AzureSqlPluginStateSyncBridge {
  const config: OpenClawConfig = {
    storage: {
      backend: "azuresql",
      azureSql: {
        ...parseDatabaseIdentity(credentials),
        authentication: {
          mode: "sql-password",
          username: credentials.username,
          password: { source: "env", provider: "default", id: DEMO_PASSWORD_ENV },
        },
      },
    },
  };
  return new AzureSqlPluginStateSyncBridge(
    config,
    { [DEMO_PASSWORD_ENV]: credentials.password },
    scope,
  );
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function sqlString(value: string): string {
  return `N'${value.replaceAll("'", "''")}'`;
}

function pluginScope(args: DemoArguments): AzureSqlPluginStateScope {
  return {
    pluginId: args.pluginId,
    namespace: DEMO_PLUGIN_NAMESPACE,
    maxEntries: 10,
    overflowPolicy: "reject-new",
  };
}

function taskIds(args: DemoArguments): readonly [string, string] {
  return [`${args.projectId}-simple-task`, `${args.projectId}-cohort-task`];
}

function taskOwnerKey(args: DemoArguments): string {
  return `azure-demo-owner:${args.projectId}`;
}

function taskState(
  taskId: string,
  task: TaskRecord | null,
  deliveryState: TaskDeliveryState | null,
): TaskCohortTaskState {
  return task ? { taskId, task, deliveryState } : { taskId, task: null, deliveryState: null };
}

async function inspectSyntheticNamespace(
  database: AzureSqlDatabase,
  args: DemoArguments,
): Promise<{
  currentProjectRows: number;
  currentLeaseRows: number;
  currentPluginStateRows: number;
  currentTaskRows: number;
  currentTaskDeliveryRows: number;
}> {
  const currentProjects = await database.query<{ count: string | number }>(
    `SELECT COUNT_BIG(*) AS count FROM [openclaw_global].[projects]\n     WHERE id = @id OR repo_root = @repoRoot`,
    (request) => {
      request.input("id", mssql.NVarChar(64), args.projectId);
      request.input("repoRoot", mssql.NVarChar(2048), args.repoRoot);
    },
  );
  const currentLeases = await database.query<{ count: string | number }>(
    `SELECT COUNT_BIG(*) AS count FROM [openclaw_global].[project_checkout_leases]\n     WHERE lease_key = @repoRoot`,
    (request) => request.input("repoRoot", mssql.NVarChar(2048), args.repoRoot),
  );
  const currentPluginState = await database.query<{ count: string | number }>(
    `SELECT COUNT_BIG(*) AS count FROM [openclaw_global].[plugin_state_entries]\n     WHERE plugin_id = @pluginId AND namespace = @namespace`,
    (request) => {
      request.input("pluginId", mssql.NVarChar(256), args.pluginId);
      request.input("namespace", mssql.NVarChar(128), DEMO_PLUGIN_NAMESPACE);
    },
  );
  const [simpleTaskId, cohortTaskId] = taskIds(args);
  const bindTaskIds = (request: AzureSqlRequest) => {
    request.input("simpleTaskId", mssql.NVarChar(256), simpleTaskId);
    request.input("cohortTaskId", mssql.NVarChar(256), cohortTaskId);
  };
  const currentTasks = await database.query<{ count: string | number }>(
    `SELECT COUNT_BIG(*) AS count FROM [openclaw_global].[task_runs]\n     WHERE task_id IN (@simpleTaskId, @cohortTaskId)`,
    bindTaskIds,
  );
  const currentTaskDelivery = await database.query<{ count: string | number }>(
    `SELECT COUNT_BIG(*) AS count FROM [openclaw_global].[task_delivery_state]\n     WHERE task_id IN (@simpleTaskId, @cohortTaskId)`,
    bindTaskIds,
  );
  return {
    currentProjectRows: Number(currentProjects.rows[0]?.count),
    currentLeaseRows: Number(currentLeases.rows[0]?.count),
    currentPluginStateRows: Number(currentPluginState.rows[0]?.count),
    currentTaskRows: Number(currentTasks.rows[0]?.count),
    currentTaskDeliveryRows: Number(currentTaskDelivery.rows[0]?.count),
  };
}

function writeSql(args: DemoArguments): void {
  const content = `-- Generated by _DEMO_/run-demo.sh. Contains no credentials.\n\nDECLARE @project_id nvarchar(64) = ${sqlString(args.projectId)};\nDECLARE @repo_root nvarchar(2048) = ${sqlString(args.repoRoot)};\nDECLARE @plugin_id nvarchar(256) = ${sqlString(args.pluginId)};\nDECLARE @plugin_namespace nvarchar(128) = ${sqlString(DEMO_PLUGIN_NAMESPACE)};\nDECLARE @simple_task_id nvarchar(256) = ${sqlString(taskIds(args)[0])};\nDECLARE @cohort_task_id nvarchar(256) = ${sqlString(taskIds(args)[1])};\n\n-- 1. All demonstrated storage migrations must be present.\nSELECT migration_id, version, applied_at_ms\nFROM openclaw_global.storage_migrations\nWHERE migration_id IN (N'global.projects.v1', N'global.projects.v2', N'global.plugin-state.v1', N'global.task-cohort.v1')\nORDER BY version;\n\n-- 2. During the first pause: one project, one active checkout lease, and two plugin-state rows.\n--    One plugin-state row used the async store directly; the other used the synchronous mailbox.\n--    After releasing the lease: the project and plugin state remain; the lease count becomes zero.\n--    After final cleanup: all three counts become zero.\nSELECT COUNT_BIG(*) AS demo_project_rows\nFROM openclaw_global.projects\nWHERE id = @project_id OR repo_root = @repo_root;\n\nSELECT COUNT_BIG(*) AS demo_lease_rows\nFROM openclaw_global.project_checkout_leases\nWHERE lease_key = @repo_root;\n\nSELECT COUNT_BIG(*) AS demo_plugin_state_rows\nFROM openclaw_global.plugin_state_entries\nWHERE plugin_id = @plugin_id AND namespace = @plugin_namespace;\n\n-- During the task pause: two task rows and one task-delivery companion row.\n-- After task cleanup: both counts become zero.\nSELECT COUNT_BIG(*) AS demo_task_rows\nFROM openclaw_global.task_runs\nWHERE task_id IN (@simple_task_id, @cohort_task_id);\n\nSELECT COUNT_BIG(*) AS demo_task_delivery_rows\nFROM openclaw_global.task_delivery_state\nWHERE task_id IN (@simple_task_id, @cohort_task_id);\n\n-- 3. Inspect the canonical project, plugin-state, and task rows.\nSELECT id, display_name, repo_root, source,\n       DATALENGTH(repo_root_hash) AS repo_root_hash_bytes\nFROM openclaw_global.projects\nWHERE id = @project_id OR repo_root = @repo_root;\n\nSELECT plugin_id, namespace, entry_key, value_json, created_at_ms, expires_at_ms,\n       DATALENGTH(entry_key_hash) AS entry_key_hash_bytes\nFROM openclaw_global.plugin_state_entries\nWHERE plugin_id = @plugin_id AND namespace = @plugin_namespace;\n\nSELECT task_id, runtime, source_id, owner_key, status,\n       JSON_VALUE(record_json, N'$.deliveryStatus') AS delivery_status,\n       created_at_ms, TRY_CONVERT(bigint, JSON_VALUE(record_json, N'$.startedAt')) AS started_at_ms\nFROM openclaw_global.task_runs\nWHERE task_id IN (@simple_task_id, @cohort_task_id)\nORDER BY created_at_ms, task_id;\n\nSELECT task_id,\n       TRY_CONVERT(bigint, JSON_VALUE(record_json, N'$.lastNotifiedEventAt')) AS last_notified_event_at_ms,\n       JSON_QUERY(record_json, N'$.requesterOrigin') AS requester_origin_json\nFROM openclaw_global.task_delivery_state\nWHERE task_id IN (@simple_task_id, @cohort_task_id);\n\n-- 4. Inspect the binary-collated identity columns for all demonstrated verticals.\nSELECT OBJECT_SCHEMA_NAME(c.object_id) AS schema_name, OBJECT_NAME(c.object_id) AS table_name,\n       c.name AS column_name, t.name AS sql_type, c.max_length, c.collation_name\nFROM sys.columns AS c\nJOIN sys.types AS t ON t.user_type_id = c.user_type_id\nWHERE (c.object_id = OBJECT_ID(N'openclaw_global.projects')\n       AND c.name IN (N'id', N'repo_root', N'repo_root_hash', N'origin_url_hash'))\n   OR (c.object_id = OBJECT_ID(N'openclaw_global.plugin_state_entries')\n       AND c.name IN (N'plugin_id', N'namespace', N'entry_key', N'entry_key_hash'))\n   OR (c.object_id = OBJECT_ID(N'openclaw_global.task_runs')\n       AND c.name IN (N'task_id', N'task_id_hash', N'owner_key', N'owner_key_hash'))\nORDER BY table_name, c.column_id;\n`;
  fs.writeFileSync(path.join(args.runtimeDir, "demo-queries.sql"), content, { mode: 0o600 });
}

async function inspect(
  database: AzureSqlDatabase,
  args: DemoArguments,
): Promise<Record<string, unknown>> {
  await database.checkHealth();
  const migrations = await database.query<{ migration_id: string }>(
    `SELECT migration_id FROM [openclaw_global].[storage_migrations]\n     WHERE migration_id IN (N'global.projects.v1', N'global.projects.v2', N'global.plugin-state.v1', N'global.task-cohort.v1')`,
  );
  const counts = await inspectSyntheticNamespace(database, args);
  return {
    backend: "azuresql",
    health: "healthy",
    storageMigrationsPresent: new Set(migrations.rows.map((row) => row.migration_id)).size === 4,
    projectRows: counts.currentProjectRows,
    leaseRows: counts.currentLeaseRows,
    pluginStateRows: counts.currentPluginStateRows,
    taskRows: counts.currentTaskRows,
    taskDeliveryRows: counts.currentTaskDeliveryRows,
  };
}

async function deleteTaskDemoRowsThroughStore(
  store: AzureSqlTaskCohortStore,
  args: DemoArguments,
): Promise<void> {
  const snapshot = await store.loadSnapshot();
  for (const taskId of taskIds(args)) {
    const task = snapshot.tasks.find((candidate) => candidate.taskId === taskId);
    if (!task) {
      continue;
    }
    const deliveryState = snapshot.deliveryStates.find((state) => state.taskId === taskId) ?? null;
    const command = prepareTaskCohortOperation("commit-task-state", {
      expected: taskState(taskId, task, deliveryState),
      next: taskState(taskId, null, null),
    });
    const result = await store.commitTaskState(command, { mode: "execute" });
    if (result.status !== "applied" && result.status !== "already-applied") {
      throw new Error(`Task demo cleanup conflicted for ${taskId}`);
    }
  }
}

async function cleanupCurrentRun(
  database: AzureSqlDatabase,
  args: DemoArguments,
): Promise<Record<string, unknown>> {
  const projectStore = new AzureSqlProjectRegistryStore(database);
  const pluginStore = new AzureSqlPluginStateStore(database);
  const taskStore = new AzureSqlTaskCohortStore(database);
  // Create every demonstrated schema before counting or cleaning this run's exact synthetic IDs.
  await projectStore.list();
  await pluginStore.entries(pluginScope(args));
  await taskStore.loadSnapshot();
  const before = await inspect(database, args);
  await projectStore.remove(args.projectId).catch(() => false);
  await pluginStore.clear(pluginScope(args));
  await deleteTaskDemoRowsThroughStore(taskStore, args);
  await database.query(
    `DELETE FROM [openclaw_global].[projects] WHERE id = @id OR repo_root = @repoRoot`,
    (request) => {
      request.input("id", mssql.NVarChar(64), args.projectId);
      request.input("repoRoot", mssql.NVarChar(2048), args.repoRoot);
    },
  );
  await database.query(
    `DELETE FROM [openclaw_global].[project_checkout_leases] WHERE lease_key = @repoRoot`,
    (request) => request.input("repoRoot", mssql.NVarChar(2048), args.repoRoot),
  );
  const state = await inspect(database, args);
  const cleanupSummary: DemoCleanupSummary = {
    cleanedProjectRows: Number(before.projectRows),
    cleanedLeaseRows: Number(before.leaseRows),
    cleanedPluginStateRows: Number(before.pluginStateRows),
    cleanedTaskRows: Number(before.taskRows),
    cleanedTaskDeliveryRows: Number(before.taskDeliveryRows),
    remainingProjectRows: Number(state.projectRows),
    remainingLeaseRows: Number(state.leaseRows),
    remainingPluginStateRows: Number(state.pluginStateRows),
    remainingTaskRows: Number(state.taskRows),
    remainingTaskDeliveryRows: Number(state.taskDeliveryRows),
  };
  if (
    cleanupSummary.remainingProjectRows !== 0 ||
    cleanupSummary.remainingLeaseRows !== 0 ||
    cleanupSummary.remainingPluginStateRows !== 0 ||
    cleanupSummary.remainingTaskRows !== 0 ||
    cleanupSummary.remainingTaskDeliveryRows !== 0
  ) {
    throw new Error("Synthetic Azure SQL demo records remain after cleanup");
  }
  return { status: "clean", ...state, ...cleanupSummary };
}

async function hold(
  database: AzureSqlDatabase,
  args: DemoArguments,
  credentials: CredentialValues,
): Promise<void> {
  const projectStore = new AzureSqlProjectRegistryStore(database);
  const pluginStore = new AzureSqlPluginStateStore(database);
  const stateScope = pluginScope(args);
  const mailboxBridge = createMailboxBridge(credentials, stateScope);
  const directPluginValue = { projectId: args.projectId, status: "direct-ready" };
  const mailboxPluginValue = { projectId: args.projectId, status: "mailbox-ready" };
  const readyPath = path.join(args.runtimeDir, READY_FILE);
  const releasePath = path.join(args.runtimeDir, RELEASE_SIGNAL_FILE);
  const cleanupPath = path.join(args.runtimeDir, CLEANUP_SIGNAL_FILE);
  const releasedPath = path.join(args.runtimeDir, RELEASED_FILE);
  const resultPath = path.join(args.runtimeDir, CLEANUP_RESULT_FILE);
  await database.checkHealth();
  const proactiveCleanup = await cleanupCurrentRun(database, args);
  await projectStore.withCheckoutLease(args.repoRoot, async (lease) => {
    const project = await projectStore.insertOrGet(
      {
        id: args.projectId,
        displayName: DEMO_DISPLAY_NAME,
        repoRoot: args.repoRoot,
        originUrl: `https://example.invalid/${args.projectId}.git`,
        source: "registered",
      },
      lease,
    );
    if (project.id !== args.projectId || project.repoRoot !== args.repoRoot) {
      throw new Error("Azure SQL returned an unexpected project identity");
    }
    if ((await projectStore.findById(args.projectId))?.repoRoot !== args.repoRoot) {
      throw new Error("Azure SQL point read did not return the inserted project");
    }
    if (!(await projectStore.list()).some((row) => row.id === args.projectId)) {
      throw new Error("Azure SQL list did not return the inserted project");
    }

    await pluginStore.register(stateScope, {
      key: DEMO_DIRECT_PLUGIN_KEY,
      valueJson: JSON.stringify(directPluginValue),
    });
    if (
      JSON.stringify(await pluginStore.lookup(stateScope, DEMO_DIRECT_PLUGIN_KEY)) !==
      JSON.stringify(directPluginValue)
    ) {
      throw new Error("Azure SQL direct point read did not return the registered plugin state");
    }

    // These synchronous calls use one persistent worker and its factory-owned Azure SQL pool.
    mailboxBridge.register({
      key: DEMO_MAILBOX_PLUGIN_KEY,
      valueJson: JSON.stringify(mailboxPluginValue),
    });
    if (
      JSON.stringify(mailboxBridge.lookup(DEMO_MAILBOX_PLUGIN_KEY)) !==
      JSON.stringify(mailboxPluginValue)
    ) {
      throw new Error("Azure SQL mailbox point read did not return the registered plugin state");
    }
    const mailboxBulkRead = mailboxBridge.lookupMany([
      DEMO_DIRECT_PLUGIN_KEY,
      DEMO_MAILBOX_PLUGIN_KEY,
      "missing",
    ]);
    if (
      !mailboxBulkRead[0]?.ok ||
      JSON.stringify(mailboxBulkRead[0].value) !== JSON.stringify(directPluginValue) ||
      !mailboxBulkRead[1]?.ok ||
      JSON.stringify(mailboxBulkRead[1].value) !== JSON.stringify(mailboxPluginValue) ||
      !mailboxBulkRead[2]?.ok ||
      mailboxBulkRead[2].value !== undefined
    ) {
      throw new Error("Azure SQL mailbox bulk read did not preserve plugin-state positions");
    }
    writeJson(readyPath, {
      status: "ready",
      health: "healthy",
      projectInserted: true,
      pointRead: true,
      listRead: true,
      directPluginStateRegistered: true,
      directPluginStatePointRead: true,
      mailboxPluginStateRegistered: true,
      mailboxPluginStatePointRead: true,
      mailboxPluginStateBulkRead: true,
      mailboxSequentialOperations: 3,
      leaseHeld: true,
      proactiveCleanup,
    });
    while (!fs.existsSync(releasePath) && !fs.existsSync(cleanupPath)) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 200);
      });
      lease.assertOwned();
    }
  });
  if (fs.existsSync(cleanupPath)) {
    const cleanupResult = await cleanupCurrentRun(database, args);
    if (mailboxBridge.lookup(DEMO_MAILBOX_PLUGIN_KEY) !== undefined) {
      throw new Error("Azure SQL mailbox observed plugin state after cleanup");
    }
    writeJson(resultPath, {
      status: "cleaned",
      leaseReleased: true,
      mailboxVerifiedCleanup: true,
      ...cleanupResult,
    });
    return;
  }
  if (
    JSON.stringify(mailboxBridge.lookup(DEMO_MAILBOX_PLUGIN_KEY)) !==
    JSON.stringify(mailboxPluginValue)
  ) {
    throw new Error("Azure SQL mailbox did not observe plugin-state persistence");
  }
  writeJson(releasedPath, {
    status: "released",
    leaseReleased: true,
    projectRetained: true,
    pluginStateRetained: true,
    mailboxVerifiedPersistence: true,
    cleanupPending: true,
  });
  while (!fs.existsSync(cleanupPath)) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 200);
    });
  }
  const cleanupResult = await cleanupCurrentRun(database, args);
  if (mailboxBridge.lookup(DEMO_MAILBOX_PLUGIN_KEY) !== undefined) {
    throw new Error("Azure SQL mailbox observed plugin state after cleanup");
  }
  writeJson(resultPath, {
    status: "cleaned",
    leaseReleased: true,
    mailboxVerifiedCleanup: true,
    ...cleanupResult,
  });
}

async function taskDemo(
  database: AzureSqlDatabase,
  args: DemoArguments,
): Promise<Record<string, unknown>> {
  const store = new AzureSqlTaskCohortStore(database);
  await deleteTaskDemoRowsThroughStore(store, args);

  const [simpleTaskId, cohortTaskId] = taskIds(args);
  const ownerKey = taskOwnerKey(args);
  const createdAt = Date.now();
  const simpleTask: TaskRecord = {
    taskId: simpleTaskId,
    runtime: "subagent",
    sourceId: `${args.projectId}:simple`,
    requesterSessionKey: ownerKey,
    ownerKey,
    scopeKind: "session",
    task: "Demonstrate the Azure SQL task API",
    status: "queued",
    deliveryStatus: "pending",
    notifyPolicy: "done_only",
    createdAt,
  };
  const simpleCreate = prepareTaskCohortOperation("commit-task-state", {
    expected: taskState(simpleTaskId, null, null),
    next: taskState(simpleTaskId, simpleTask, null),
  });
  const simpleResult = await store.commitTaskState(simpleCreate, { mode: "execute" });
  if (simpleResult.status !== "applied") {
    throw new Error(`Simple Azure SQL task create returned ${simpleResult.status}`);
  }
  const simpleRead = await store.listTasksByRuntimeSource({
    runtime: "subagent",
    sourceId: simpleTask.sourceId,
  });
  if (simpleRead.length !== 1 || simpleRead[0]?.taskId !== simpleTaskId) {
    throw new Error("Simple Azure SQL task filtered read did not return the created task");
  }

  const cohortTask: TaskRecord = {
    ...simpleTask,
    taskId: cohortTaskId,
    sourceId: `${args.projectId}:cohort`,
    task: "Demonstrate an atomic task and delivery-state cohort",
    createdAt: createdAt + 1,
  };
  const initialDelivery: TaskDeliveryState = {
    taskId: cohortTaskId,
    lastNotifiedEventAt: createdAt,
  };
  const cohortCreate = prepareTaskCohortOperation("commit-task-state", {
    expected: taskState(cohortTaskId, null, null),
    next: taskState(cohortTaskId, cohortTask, initialDelivery),
  });
  const cohortCreateResult = await store.commitTaskState(cohortCreate, { mode: "execute" });
  if (cohortCreateResult.status !== "applied") {
    throw new Error(`Azure SQL cohort create returned ${cohortCreateResult.status}`);
  }

  const runningTask: TaskRecord = {
    ...cohortTask,
    status: "running",
    startedAt: createdAt + 2,
    lastEventAt: createdAt + 2,
  };
  const advancedDelivery: TaskDeliveryState = {
    ...initialDelivery,
    lastNotifiedEventAt: createdAt + 2,
  };
  const cohortAdvance = prepareTaskCohortOperation("commit-task-state", {
    expected: taskState(cohortTaskId, cohortTask, initialDelivery),
    next: taskState(cohortTaskId, runningTask, advancedDelivery),
  });
  const advanceResult = await store.commitTaskState(cohortAdvance, { mode: "execute" });
  if (advanceResult.status !== "applied") {
    throw new Error(`Azure SQL cohort advance returned ${advanceResult.status}`);
  }
  const reconciliation = await store.commitTaskState(cohortAdvance, { mode: "reconcile" });
  if (reconciliation.status !== "already-applied") {
    throw new Error(`Azure SQL cohort reconciliation returned ${reconciliation.status}`);
  }

  const ownerTasks = await store.listTasksForOwnerKey(ownerKey);
  const snapshot = await store.loadSnapshot();
  const taskRows = snapshot.tasks.filter(
    (task) => task.taskId === simpleTaskId || task.taskId === cohortTaskId,
  );
  const deliveryRows = snapshot.deliveryStates.filter(
    (state) => state.taskId === simpleTaskId || state.taskId === cohortTaskId,
  );
  if (
    ownerTasks.filter((task) => task.taskId === simpleTaskId || task.taskId === cohortTaskId)
      .length !== 2 ||
    taskRows.length !== 2 ||
    deliveryRows.length !== 1 ||
    taskRows.find((task) => task.taskId === cohortTaskId)?.status !== "running" ||
    deliveryRows[0]?.lastNotifiedEventAt !== advancedDelivery.lastNotifiedEventAt
  ) {
    throw new Error("Azure SQL task cohort snapshot did not preserve the atomic next state");
  }

  return {
    status: "task-demo-ready",
    backend: "azuresql",
    migration: TASK_MIGRATION_ID,
    simpleApi: {
      create: simpleResult.status,
      filteredRead: true,
      taskId: simpleTaskId,
    },
    cohort: {
      create: cohortCreateResult.status,
      atomicAdvance: advanceResult.status,
      reconciliation: reconciliation.status,
      taskStatus: "running",
      deliveryStateAdvanced: true,
      lastNotifiedEventAt: advancedDelivery.lastNotifiedEventAt,
      taskId: cohortTaskId,
    },
    taskRows: taskRows.length,
    taskDeliveryRows: deliveryRows.length,
    cleanupPending: true,
  };
}

async function cleanup(database: AzureSqlDatabase, args: DemoArguments): Promise<void> {
  console.log(JSON.stringify(await cleanupCurrentRun(database, args)));
}

async function main(): Promise<void> {
  const args = parseArguments();
  fs.mkdirSync(args.runtimeDir, { recursive: true, mode: 0o700 });
  if (args.action === "write-sql") {
    writeSql(args);
    return;
  }
  const credentials = readCredentials(args.credentialFile);
  const database = createDatabase(credentials);
  try {
    if (args.action === "hold") {
      await hold(database, args, credentials);
      return;
    }
    if (args.action === "inspect") {
      console.log(JSON.stringify(await inspect(database, args)));
      return;
    }
    if (args.action === "task-demo") {
      console.log(JSON.stringify(await taskDemo(database, args)));
      return;
    }
    await cleanup(database, args);
  } finally {
    try {
      await closePluginStateSyncBridgeWorker();
    } finally {
      await database.close();
    }
  }
}

main().catch((error: unknown) => {
  const failureKind =
    error && typeof error === "object" && "kind" in error
      ? String(error.kind)
      : error instanceof Error
        ? error.name
        : "unknown";
  console.error(JSON.stringify({ status: "failed", failureKind }));
  process.exitCode = 1;
});
