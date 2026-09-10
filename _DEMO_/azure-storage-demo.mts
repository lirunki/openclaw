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
import { AzureSqlDatabase } from "../src/storage/azure-sql/runtime.js";

type DemoArguments = {
  action: "hold" | "inspect" | "cleanup" | "write-sql";
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
  remainingProjectRows: number;
  remainingLeaseRows: number;
  remainingPluginStateRows: number;
};

const DEMO_DISPLAY_NAME = "OpenClaw Azure SQL Storage Demo";
const DEMO_PLUGIN_NAMESPACE = "storage-demo";
const DEMO_DIRECT_PLUGIN_KEY = "current-project-direct";
const DEMO_MAILBOX_PLUGIN_KEY = "current-project-mailbox";
const DEMO_PASSWORD_ENV = "OPENCLAW_AZURE_SQL_DEMO_PASSWORD";
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
  if (action !== "hold" && action !== "inspect" && action !== "cleanup" && action !== "write-sql") {
    throw new Error("Expected action: hold, inspect, cleanup, or write-sql");
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

async function inspectSyntheticNamespace(
  database: AzureSqlDatabase,
  args: DemoArguments,
): Promise<{
  currentProjectRows: number;
  currentLeaseRows: number;
  currentPluginStateRows: number;
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
  return {
    currentProjectRows: Number(currentProjects.rows[0]?.count),
    currentLeaseRows: Number(currentLeases.rows[0]?.count),
    currentPluginStateRows: Number(currentPluginState.rows[0]?.count),
  };
}

function writeSql(args: DemoArguments): void {
  const content = `-- Generated by _DEMO_/run-demo.sh. Contains no credentials.\n\nDECLARE @project_id nvarchar(64) = ${sqlString(args.projectId)};\nDECLARE @repo_root nvarchar(2048) = ${sqlString(args.repoRoot)};\nDECLARE @plugin_id nvarchar(256) = ${sqlString(args.pluginId)};\nDECLARE @plugin_namespace nvarchar(128) = ${sqlString(DEMO_PLUGIN_NAMESPACE)};\n\n-- 1. Project-registry and plugin-state migrations must be present.\nSELECT migration_id, version, applied_at_ms\nFROM openclaw_global.storage_migrations\nWHERE migration_id IN (N'global.projects.v1', N'global.projects.v2', N'global.plugin-state.v1')\nORDER BY version;\n\n-- 2. During the first pause: one project, one active checkout lease, and two plugin-state rows.\n--    One plugin-state row used the async store directly; the other used the synchronous mailbox.\n--    After releasing the lease: the project and plugin state remain; the lease count becomes zero.\n--    After final cleanup: all three counts become zero.\nSELECT COUNT_BIG(*) AS demo_project_rows\nFROM openclaw_global.projects\nWHERE id = @project_id OR repo_root = @repo_root;\n\nSELECT COUNT_BIG(*) AS demo_lease_rows\nFROM openclaw_global.project_checkout_leases\nWHERE lease_key = @repo_root;\n\nSELECT COUNT_BIG(*) AS demo_plugin_state_rows\nFROM openclaw_global.plugin_state_entries\nWHERE plugin_id = @plugin_id AND namespace = @plugin_namespace;\n\n-- 3. Inspect the canonical project and plugin-state rows.\nSELECT id, display_name, repo_root, source,\n       DATALENGTH(repo_root_hash) AS repo_root_hash_bytes\nFROM openclaw_global.projects\nWHERE id = @project_id OR repo_root = @repo_root;\n\nSELECT plugin_id, namespace, entry_key, value_json, created_at_ms, expires_at_ms,\n       DATALENGTH(entry_key_hash) AS entry_key_hash_bytes\nFROM openclaw_global.plugin_state_entries\nWHERE plugin_id = @plugin_id AND namespace = @plugin_namespace;\n\n-- 4. Inspect the binary-collated identity columns for both verticals.\nSELECT OBJECT_SCHEMA_NAME(c.object_id) AS schema_name, OBJECT_NAME(c.object_id) AS table_name,\n       c.name AS column_name, t.name AS sql_type, c.max_length, c.collation_name\nFROM sys.columns AS c\nJOIN sys.types AS t ON t.user_type_id = c.user_type_id\nWHERE (c.object_id = OBJECT_ID(N'openclaw_global.projects')\n       AND c.name IN (N'id', N'repo_root', N'repo_root_hash', N'origin_url_hash'))\n   OR (c.object_id = OBJECT_ID(N'openclaw_global.plugin_state_entries')\n       AND c.name IN (N'plugin_id', N'namespace', N'entry_key', N'entry_key_hash'))\nORDER BY table_name, c.column_id;\n`;
  fs.writeFileSync(path.join(args.runtimeDir, "demo-queries.sql"), content, { mode: 0o600 });
}

async function inspect(
  database: AzureSqlDatabase,
  args: DemoArguments,
): Promise<Record<string, unknown>> {
  await database.checkHealth();
  const migrations = await database.query<{ migration_id: string }>(
    `SELECT migration_id FROM [openclaw_global].[storage_migrations]\n     WHERE migration_id IN (N'global.projects.v1', N'global.projects.v2', N'global.plugin-state.v1')`,
  );
  const counts = await inspectSyntheticNamespace(database, args);
  return {
    backend: "azuresql",
    health: "healthy",
    storageMigrationsPresent: new Set(migrations.rows.map((row) => row.migration_id)).size === 3,
    projectRows: counts.currentProjectRows,
    leaseRows: counts.currentLeaseRows,
    pluginStateRows: counts.currentPluginStateRows,
  };
}

async function cleanupCurrentRun(
  database: AzureSqlDatabase,
  args: DemoArguments,
): Promise<Record<string, unknown>> {
  const projectStore = new AzureSqlProjectRegistryStore(database);
  const pluginStore = new AzureSqlPluginStateStore(database);
  // The storage contracts create their owned schemas before exact-run fallback cleanup.
  const before = await inspect(database, args).catch(async () => {
    await pluginStore.entries(pluginScope(args));
    await projectStore.list();
    return await inspect(database, args);
  });
  await projectStore.remove(args.projectId).catch(() => false);
  await pluginStore.clear(pluginScope(args));
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
    remainingProjectRows: Number(state.projectRows),
    remainingLeaseRows: Number(state.leaseRows),
    remainingPluginStateRows: Number(state.pluginStateRows),
  };
  if (
    cleanupSummary.remainingProjectRows !== 0 ||
    cleanupSummary.remainingLeaseRows !== 0 ||
    cleanupSummary.remainingPluginStateRows !== 0
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
