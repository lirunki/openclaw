import { resolveExpiresAtMsFromDurationMs } from "@openclaw/normalization-core/number-coercion";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import mssql from "mssql";
import {
  MAX_PLUGIN_STATE_ENTRIES_PER_PLUGIN,
  PluginStateStoreError,
  type PluginStateEntry,
  type PluginStateOverflowPolicy,
  type PluginStateStoreErrorCode,
  type PluginStateStoreOperation,
} from "../../plugin-state/plugin-state-store.types.js";
import { runAzureSqlMigrations } from "./migrations.js";
import {
  AZURE_SQL_PLUGIN_STATE_MIGRATION,
  AZURE_SQL_PLUGIN_STATE_TABLE,
} from "./plugin-state-schema.js";
import type { AzureSqlDatabase, AzureSqlRequest, AzureSqlTransaction } from "./runtime.js";

const AZURE_SQL_NOW_MS =
  "DATEDIFF_BIG(MILLISECOND, CONVERT(datetime2, '1970-01-01'), SYSUTCDATETIME())";

type AzureSqlPluginStateRow = {
  entry_key: string;
  value_json: string;
  created_at_ms: number | string;
  expires_at_ms: number | string | null;
};

export type AzureSqlPluginStateRawEntry = {
  key: string;
  valueJson: string;
  createdAt: number;
  expiresAt: number | null;
};

export type AzureSqlPluginStateScope = {
  pluginId: string;
  namespace: string;
  maxEntries: number;
  overflowPolicy: PluginStateOverflowPolicy;
};

export type AzureSqlPluginStateRegisterInput = {
  key: string;
  valueJson: string;
  ttlMs?: number;
  createdAtMs?: number;
};

export type AzureSqlPluginStateImportInput = {
  key: string;
  valueJson: string;
  createdAtMs: number;
  expiresAtMs: number | null;
};

type AzureSqlPluginStateWriteInput =
  | AzureSqlPluginStateRegisterInput
  | AzureSqlPluginStateImportInput;

export type AzureSqlPluginStateCasResult = "applied" | "conflict";

export type AzureSqlPluginStateImportResult =
  | { status: "inserted" }
  | { status: "existing"; entry: AzureSqlPluginStateRawEntry };

function pluginStateError(params: {
  code: PluginStateStoreErrorCode;
  operation: PluginStateStoreOperation;
  message: string;
  cause?: unknown;
}): PluginStateStoreError {
  return new PluginStateStoreError(params.message, {
    code: params.code,
    operation: params.operation,
    cause: params.cause,
  });
}

function wrapPluginStateError(
  error: unknown,
  operation: PluginStateStoreOperation,
  fallbackCode: PluginStateStoreErrorCode,
  message: string,
): PluginStateStoreError {
  return error instanceof PluginStateStoreError
    ? error
    : pluginStateError({ code: fallbackCode, operation, message, cause: error });
}

function bindScope(request: AzureSqlRequest, scope: AzureSqlPluginStateScope): void {
  request.input("pluginId", mssql.NVarChar(256), scope.pluginId);
  request.input("namespace", mssql.NVarChar(128), scope.namespace);
}

function bindEntry(
  request: AzureSqlRequest,
  scope: AzureSqlPluginStateScope,
  input: AzureSqlPluginStateWriteInput,
): void {
  const ttlMs = "ttlMs" in input ? input.ttlMs : undefined;
  const hasAbsoluteExpiry = "expiresAtMs" in input;
  const expiresAtMs = hasAbsoluteExpiry ? input.expiresAtMs : undefined;
  if (
    ttlMs !== undefined &&
    resolveExpiresAtMsFromDurationMs(ttlMs, { nowMs: Date.now() }) === undefined
  ) {
    throw pluginStateError({
      code: "PLUGIN_STATE_INVALID_INPUT",
      operation: "register",
      message: "Plugin state ttlMs cannot produce a valid expiry timestamp.",
    });
  }
  if (
    expiresAtMs !== undefined &&
    expiresAtMs !== null &&
    (!Number.isSafeInteger(expiresAtMs) || expiresAtMs < 0)
  ) {
    throw pluginStateError({
      code: "PLUGIN_STATE_INVALID_INPUT",
      operation: "register",
      message: "Plugin state expiresAtMs must be null or a non-negative safe integer.",
    });
  }
  bindScope(request, scope);
  request.input("entryKey", mssql.NVarChar(512), input.key);
  request.input("valueJson", mssql.NVarChar(mssql.MAX), input.valueJson);
  request.input("ttlMs", mssql.BigInt(), ttlMs ?? null);
  request.input("createdAtMs", mssql.BigInt(), input.createdAtMs ?? null);
  request.input("expiresAtMs", mssql.BigInt(), expiresAtMs ?? null);
  request.input("hasAbsoluteExpiry", mssql.Bit(), hasAbsoluteExpiry);
}

function normalizeInteger(value: number | string | null): number | null {
  if (value === null) {
    return null;
  }
  const normalized = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(normalized) ? normalized : null;
}

function rowToRaw(row: AzureSqlPluginStateRow): AzureSqlPluginStateRawEntry {
  const createdAt = normalizeInteger(row.created_at_ms);
  const expiresAt = normalizeInteger(row.expires_at_ms);
  if (createdAt === null || (row.expires_at_ms !== null && expiresAt === null)) {
    throw pluginStateError({
      code: "PLUGIN_STATE_CORRUPT",
      operation: "lookup",
      message: "Plugin state entry contains an invalid timestamp.",
    });
  }
  return {
    key: row.entry_key,
    valueJson: row.value_json,
    createdAt,
    expiresAt,
  };
}

function parseRaw<T>(raw: AzureSqlPluginStateRawEntry, operation: PluginStateStoreOperation): T {
  try {
    // SAFETY: JSON decoding is the runtime boundary for the caller-owned namespace type.
    return JSON.parse(raw.valueJson) as T;
  } catch (error) {
    throw pluginStateError({
      code: "PLUGIN_STATE_CORRUPT",
      operation,
      message: "Plugin state entry contains corrupt JSON.",
      cause: error,
    });
  }
}

function rawToEntry<T>(raw: AzureSqlPluginStateRawEntry): PluginStateEntry<T> {
  return {
    key: raw.key,
    value: parseRaw<T>(raw, "entries"),
    createdAt: raw.createdAt,
    ...(raw.expiresAt === null ? {} : { expiresAt: raw.expiresAt }),
  };
}

async function selectRaw(
  queryable: AzureSqlDatabase | AzureSqlTransaction,
  scope: AzureSqlPluginStateScope,
  key: string,
  lock = false,
): Promise<AzureSqlPluginStateRawEntry | undefined> {
  const result = await queryable.query<AzureSqlPluginStateRow>(
    `SELECT entry_key, value_json, created_at_ms, expires_at_ms
     FROM ${AZURE_SQL_PLUGIN_STATE_TABLE}${lock ? " WITH (UPDLOCK, HOLDLOCK)" : ""}
     WHERE plugin_id = @pluginId AND namespace = @namespace
       AND entry_key_hash = HASHBYTES('SHA2_256', CONVERT(varbinary(max), @entryKey))
       AND entry_key = @entryKey
       AND (expires_at_ms IS NULL OR expires_at_ms > ${AZURE_SQL_NOW_MS})`,
    (request) => {
      bindScope(request, scope);
      request.input("entryKey", mssql.NVarChar(512), key);
    },
  );
  return result.rows[0] ? rowToRaw(result.rows[0]) : undefined;
}

async function deleteExpiredScope(
  transaction: AzureSqlTransaction,
  scope: AzureSqlPluginStateScope,
): Promise<void> {
  await transaction.query(
    `DELETE FROM ${AZURE_SQL_PLUGIN_STATE_TABLE}
     WHERE plugin_id = @pluginId AND namespace = @namespace
       AND expires_at_ms IS NOT NULL AND expires_at_ms <= ${AZURE_SQL_NOW_MS}`,
    (request) => bindScope(request, scope),
  );
}

async function countLive(
  transaction: AzureSqlTransaction,
  scope: AzureSqlPluginStateScope,
  namespaceOnly: boolean,
): Promise<number> {
  const result = await transaction.query<{ entry_count: number | string }>(
    `SELECT COUNT_BIG(*) AS entry_count
     FROM ${AZURE_SQL_PLUGIN_STATE_TABLE} WITH (UPDLOCK, HOLDLOCK)
     WHERE plugin_id = @pluginId
       ${namespaceOnly ? "AND namespace = @namespace" : ""}
       AND (expires_at_ms IS NULL OR expires_at_ms > ${AZURE_SQL_NOW_MS})`,
    (request) => bindScope(request, scope),
  );
  return normalizeInteger(result.rows[0]?.entry_count ?? 0) ?? 0;
}

async function assertCanInsert(
  transaction: AzureSqlTransaction,
  scope: AzureSqlPluginStateScope,
): Promise<void> {
  if (scope.overflowPolicy !== "reject-new") {
    return;
  }
  await acquirePluginLock(transaction, scope.pluginId);
  if ((await countLive(transaction, scope, true)) >= scope.maxEntries) {
    throw pluginStateError({
      code: "PLUGIN_STATE_LIMIT_EXCEEDED",
      operation: "register",
      message: `Plugin state namespace ${scope.namespace} for ${scope.pluginId} reached its ${scope.maxEntries}-row limit.`,
    });
  }
  if ((await countLive(transaction, scope, false)) >= MAX_PLUGIN_STATE_ENTRIES_PER_PLUGIN) {
    throw pluginStateError({
      code: "PLUGIN_STATE_LIMIT_EXCEEDED",
      operation: "register",
      message: `Plugin state for ${scope.pluginId} reached the ${MAX_PLUGIN_STATE_ENTRIES_PER_PLUGIN} live row limit.`,
    });
  }
}

async function deleteOldest(
  transaction: AzureSqlTransaction,
  scope: AzureSqlPluginStateScope,
  protectedKey: string,
  limit: number,
): Promise<number> {
  if (limit <= 0) {
    return 0;
  }
  const result = await transaction.query(
    `DELETE FROM ${AZURE_SQL_PLUGIN_STATE_TABLE}
     WHERE plugin_id = @pluginId AND namespace = @namespace
       AND entry_key_hash IN (
         SELECT TOP (@limit) entry_key_hash
         FROM ${AZURE_SQL_PLUGIN_STATE_TABLE} WITH (UPDLOCK, HOLDLOCK)
         WHERE plugin_id = @pluginId AND namespace = @namespace
           AND entry_key <> @entryKey
           AND (expires_at_ms IS NULL OR expires_at_ms > ${AZURE_SQL_NOW_MS})
         ORDER BY created_at_ms ASC, entry_key ASC
       )`,
    (request) => {
      bindScope(request, scope);
      request.input("entryKey", mssql.NVarChar(512), protectedKey);
      request.input("limit", mssql.Int(), limit);
    },
  );
  return result.rowsAffected.reduce((sum, value) => sum + value, 0);
}

async function acquirePluginLock(
  transaction: AzureSqlTransaction,
  pluginId: string,
): Promise<void> {
  await transaction.query(
    `DECLARE @lockResult int;
     EXEC @lockResult = sp_getapplock
       @Resource = @lockResource,
       @LockMode = N'Exclusive',
       @LockOwner = N'Transaction',
       @LockTimeout = 30000;
     IF @lockResult < 0
       THROW 51000, 'Could not acquire plugin-state capacity lock', 1;`,
    (request) =>
      request.input("lockResource", mssql.NVarChar(255), `openclaw.plugin-state:${pluginId}`),
  );
}

async function enforceLimits(
  transaction: AzureSqlTransaction,
  scope: AzureSqlPluginStateScope,
  protectedKey: string,
  enforcePluginLimit = true,
): Promise<void> {
  await acquirePluginLock(transaction, scope.pluginId);
  let namespaceCount = await countLive(transaction, scope, true);
  if (namespaceCount > scope.maxEntries) {
    if (scope.overflowPolicy === "reject-new") {
      throw pluginStateError({
        code: "PLUGIN_STATE_LIMIT_EXCEEDED",
        operation: "register",
        message: `Plugin state namespace ${scope.namespace} for ${scope.pluginId} exceeds its ${scope.maxEntries}-row limit.`,
      });
    }
    await deleteOldest(transaction, scope, protectedKey, namespaceCount - scope.maxEntries);
    namespaceCount = await countLive(transaction, scope, true);
    if (namespaceCount > scope.maxEntries) {
      throw pluginStateError({
        code: "PLUGIN_STATE_LIMIT_EXCEEDED",
        operation: "register",
        message: `Plugin state namespace ${scope.namespace} for ${scope.pluginId} exceeds its ${scope.maxEntries}-row limit.`,
      });
    }
  }

  if (!enforcePluginLimit) {
    return;
  }
  let pluginCount = await countLive(transaction, scope, false);
  if (pluginCount > MAX_PLUGIN_STATE_ENTRIES_PER_PLUGIN) {
    await deleteOldest(
      transaction,
      scope,
      protectedKey,
      pluginCount - MAX_PLUGIN_STATE_ENTRIES_PER_PLUGIN,
    );
    pluginCount = await countLive(transaction, scope, false);
    if (pluginCount > MAX_PLUGIN_STATE_ENTRIES_PER_PLUGIN) {
      throw pluginStateError({
        code: "PLUGIN_STATE_LIMIT_EXCEEDED",
        operation: "register",
        message: `Plugin state for ${scope.pluginId} exceeds the ${MAX_PLUGIN_STATE_ENTRIES_PER_PLUGIN} live row limit.`,
      });
    }
  }
}

async function writeEntry(
  transaction: AzureSqlTransaction,
  scope: AzureSqlPluginStateScope,
  input: AzureSqlPluginStateWriteInput,
): Promise<void> {
  await transaction.query(
    `DECLARE @now bigint = ${AZURE_SQL_NOW_MS};
     DECLARE @createdAt bigint = @createdAtMs;
     IF @createdAt IS NULL
     BEGIN
       SELECT @createdAt = CASE
         WHEN MAX(created_at_ms) IS NULL OR MAX(created_at_ms) < @now THEN @now
         ELSE MAX(created_at_ms) + 1
       END
       FROM ${AZURE_SQL_PLUGIN_STATE_TABLE} WITH (UPDLOCK, HOLDLOCK)
       WHERE plugin_id = @pluginId AND namespace = @namespace;
     END;
     DECLARE @expiresAt bigint = CASE
       WHEN @hasAbsoluteExpiry = 1 THEN @expiresAtMs
       WHEN @ttlMs IS NULL THEN NULL
       ELSE @now + @ttlMs
     END;
     IF EXISTS (
       SELECT 1 FROM ${AZURE_SQL_PLUGIN_STATE_TABLE} WITH (UPDLOCK, HOLDLOCK)
       WHERE plugin_id = @pluginId AND namespace = @namespace
         AND entry_key_hash = HASHBYTES('SHA2_256', CONVERT(varbinary(max), @entryKey))
         AND entry_key = @entryKey
     )
       UPDATE ${AZURE_SQL_PLUGIN_STATE_TABLE}
       SET value_json = @valueJson, created_at_ms = @createdAt, expires_at_ms = @expiresAt
       WHERE plugin_id = @pluginId AND namespace = @namespace
         AND entry_key_hash = HASHBYTES('SHA2_256', CONVERT(varbinary(max), @entryKey))
         AND entry_key = @entryKey;
     ELSE
       INSERT INTO ${AZURE_SQL_PLUGIN_STATE_TABLE}
         (plugin_id, namespace, entry_key, entry_key_hash, value_json, created_at_ms, expires_at_ms)
       VALUES
         (@pluginId, @namespace, @entryKey,
          HASHBYTES('SHA2_256', CONVERT(varbinary(max), @entryKey)),
          @valueJson, @createdAt, @expiresAt);`,
    (request) => bindEntry(request, scope, input),
  );
}

function sameRaw(
  left: AzureSqlPluginStateRawEntry | undefined,
  right: AzureSqlPluginStateRawEntry | undefined,
): boolean {
  return (
    left === right ||
    (left !== undefined &&
      right !== undefined &&
      left.key === right.key &&
      left.valueJson === right.valueJson &&
      left.createdAt === right.createdAt &&
      left.expiresAt === right.expiresAt)
  );
}

export class AzureSqlPluginStateStore {
  private schemaReady: Promise<void> | undefined;

  constructor(private readonly database: AzureSqlDatabase) {}

  private async ensureSchema(): Promise<void> {
    this.schemaReady ??= runAzureSqlMigrations(this.database, [
      AZURE_SQL_PLUGIN_STATE_MIGRATION,
    ]).then(() => undefined);
    try {
      await this.schemaReady;
    } catch (error) {
      this.schemaReady = undefined;
      throw error;
    }
  }

  private async write<T>(operation: () => Promise<T>): Promise<T> {
    await this.ensureSchema();
    return await operation();
  }

  async register(
    scope: AzureSqlPluginStateScope,
    input: AzureSqlPluginStateRegisterInput,
  ): Promise<void> {
    try {
      await this.write(async () => {
        await this.database.transaction(async (transaction) => {
          await acquirePluginLock(transaction, scope.pluginId);
          await deleteExpiredScope(transaction, scope);
          const current = await selectRaw(transaction, scope, input.key, true);
          if (!current) {
            await assertCanInsert(transaction, scope);
          }
          await writeEntry(transaction, scope, input);
          await enforceLimits(transaction, scope, input.key);
        });
      });
    } catch (error) {
      throw wrapPluginStateError(
        error,
        "register",
        "PLUGIN_STATE_WRITE_FAILED",
        "Failed to register plugin state entry.",
      );
    }
  }

  async registerIfAbsent(
    scope: AzureSqlPluginStateScope,
    input: AzureSqlPluginStateRegisterInput,
  ): Promise<boolean> {
    try {
      return await this.write(
        async () =>
          await this.database.transaction(async (transaction) => {
            await acquirePluginLock(transaction, scope.pluginId);
            await deleteExpiredScope(transaction, scope);
            if (await selectRaw(transaction, scope, input.key, true)) {
              return false;
            }
            await assertCanInsert(transaction, scope);
            await writeEntry(transaction, scope, input);
            await enforceLimits(transaction, scope, input.key);
            return true;
          }),
      );
    } catch (error) {
      throw wrapPluginStateError(
        error,
        "register",
        "PLUGIN_STATE_WRITE_FAILED",
        "Failed to register plugin state entry.",
      );
    }
  }

  async update(
    scope: AzureSqlPluginStateScope,
    key: string,
    updateValueJson: (current: unknown) => { valueJson: string; ttlMs?: number } | undefined,
  ): Promise<boolean> {
    try {
      return await this.write(
        async () =>
          await this.database.transaction(async (transaction) => {
            await acquirePluginLock(transaction, scope.pluginId);
            await deleteExpiredScope(transaction, scope);
            const current = await selectRaw(transaction, scope, key, true);
            const next = updateValueJson(current ? parseRaw(current, "lookup") : undefined);
            if (!next) {
              return false;
            }
            if (!current) {
              await assertCanInsert(transaction, scope);
            }
            await writeEntry(transaction, scope, { key, ...next });
            await enforceLimits(transaction, scope, key);
            return true;
          }),
      );
    } catch (error) {
      throw wrapPluginStateError(
        error,
        "register",
        "PLUGIN_STATE_WRITE_FAILED",
        "Failed to update plugin state entry.",
      );
    }
  }

  async deleteIf(
    scope: AzureSqlPluginStateScope,
    key: string,
    predicate: (current: unknown) => boolean,
  ): Promise<boolean> {
    try {
      return await this.write(
        async () =>
          await this.database.transaction(async (transaction) => {
            const current = await selectRaw(transaction, scope, key, true);
            if (!current || !predicate(parseRaw(current, "lookup"))) {
              return false;
            }
            await transaction.query(
              `DELETE FROM ${AZURE_SQL_PLUGIN_STATE_TABLE}
             WHERE plugin_id = @pluginId AND namespace = @namespace
               AND entry_key_hash = HASHBYTES('SHA2_256', CONVERT(varbinary(max), @entryKey))
               AND entry_key = @entryKey`,
              (request) => {
                bindScope(request, scope);
                request.input("entryKey", mssql.NVarChar(512), key);
              },
            );
            return true;
          }),
      );
    } catch (error) {
      throw wrapPluginStateError(
        error,
        "delete",
        "PLUGIN_STATE_WRITE_FAILED",
        "Failed to delete plugin state entry.",
      );
    }
  }

  async lookupRaw(
    scope: AzureSqlPluginStateScope,
    key: string,
  ): Promise<AzureSqlPluginStateRawEntry | undefined> {
    try {
      await this.ensureSchema();
      return await selectRaw(this.database, scope, key);
    } catch (error) {
      throw wrapPluginStateError(
        error,
        "lookup",
        "PLUGIN_STATE_READ_FAILED",
        "Failed to read plugin state entry.",
      );
    }
  }

  async lookup(scope: AzureSqlPluginStateScope, key: string): Promise<unknown> {
    const raw = await this.lookupRaw(scope, key);
    return raw ? parseRaw(raw, "lookup") : undefined;
  }

  async lookupMany(
    scope: AzureSqlPluginStateScope,
    keys: readonly string[],
  ): Promise<Array<Result<unknown, PluginStateStoreError>>> {
    try {
      await this.ensureSchema();
      if (keys.length === 0) {
        return [];
      }
      const result = await this.database.query<AzureSqlPluginStateRow>(
        `SELECT state.entry_key, state.value_json, state.created_at_ms, state.expires_at_ms
         FROM ${AZURE_SQL_PLUGIN_STATE_TABLE} state
         INNER JOIN OPENJSON(@keys)
           WITH (entry_key nvarchar(512) '$') requested
           ON state.entry_key_hash = HASHBYTES('SHA2_256', CONVERT(varbinary(max), requested.entry_key))
          AND state.entry_key = requested.entry_key COLLATE Latin1_General_100_BIN2
         WHERE state.plugin_id = @pluginId AND state.namespace = @namespace
           AND (state.expires_at_ms IS NULL OR state.expires_at_ms > ${AZURE_SQL_NOW_MS})`,
        (request) => {
          bindScope(request, scope);
          request.input("keys", mssql.NVarChar(mssql.MAX), JSON.stringify(keys));
        },
      );
      const byKey = new Map(result.rows.map((row) => [row.entry_key, rowToRaw(row)]));
      return keys.map((key) => {
        const raw = byKey.get(key);
        if (!raw) {
          return ok(undefined);
        }
        try {
          return ok(parseRaw(raw, "lookup"));
        } catch (error) {
          return err(
            wrapPluginStateError(
              error,
              "lookup",
              "PLUGIN_STATE_CORRUPT",
              "Plugin state entry contains corrupt JSON.",
            ),
          );
        }
      });
    } catch (error) {
      throw wrapPluginStateError(
        error,
        "lookup",
        "PLUGIN_STATE_READ_FAILED",
        "Failed to read plugin state entries.",
      );
    }
  }

  async consume(scope: AzureSqlPluginStateScope, key: string): Promise<unknown> {
    try {
      return await this.write(
        async () =>
          await this.database.transaction(async (transaction) => {
            const current = await selectRaw(transaction, scope, key, true);
            if (!current) {
              return undefined;
            }
            await transaction.query(
              `DELETE FROM ${AZURE_SQL_PLUGIN_STATE_TABLE}
             WHERE plugin_id = @pluginId AND namespace = @namespace
               AND entry_key_hash = HASHBYTES('SHA2_256', CONVERT(varbinary(max), @entryKey))
               AND entry_key = @entryKey`,
              (request) => {
                bindScope(request, scope);
                request.input("entryKey", mssql.NVarChar(512), key);
              },
            );
            return parseRaw(current, "consume");
          }),
      );
    } catch (error) {
      throw wrapPluginStateError(
        error,
        "consume",
        "PLUGIN_STATE_WRITE_FAILED",
        "Failed to consume plugin state entry.",
      );
    }
  }

  async delete(scope: AzureSqlPluginStateScope, key: string): Promise<boolean> {
    try {
      return await this.write(async () => {
        const result = await this.database.query(
          `DELETE FROM ${AZURE_SQL_PLUGIN_STATE_TABLE}
           WHERE plugin_id = @pluginId AND namespace = @namespace
             AND entry_key_hash = HASHBYTES('SHA2_256', CONVERT(varbinary(max), @entryKey))
             AND entry_key = @entryKey`,
          (request) => {
            bindScope(request, scope);
            request.input("entryKey", mssql.NVarChar(512), key);
          },
        );
        return result.rowsAffected.reduce((sum, value) => sum + value, 0) > 0;
      });
    } catch (error) {
      throw wrapPluginStateError(
        error,
        "delete",
        "PLUGIN_STATE_WRITE_FAILED",
        "Failed to delete plugin state entry.",
      );
    }
  }

  async entries(scope: AzureSqlPluginStateScope): Promise<PluginStateEntry<unknown>[]> {
    try {
      await this.ensureSchema();
      const result = await this.database.query<AzureSqlPluginStateRow>(
        `SELECT entry_key, value_json, created_at_ms, expires_at_ms
         FROM ${AZURE_SQL_PLUGIN_STATE_TABLE}
         WHERE plugin_id = @pluginId AND namespace = @namespace
           AND (expires_at_ms IS NULL OR expires_at_ms > ${AZURE_SQL_NOW_MS})
         ORDER BY created_at_ms ASC, entry_key ASC`,
        (request) => bindScope(request, scope),
      );
      return result.rows.map((row) => rawToEntry(rowToRaw(row)));
    } catch (error) {
      throw wrapPluginStateError(
        error,
        "entries",
        "PLUGIN_STATE_READ_FAILED",
        "Failed to list plugin state entries.",
      );
    }
  }

  async entriesInKeyRange(
    scope: AzureSqlPluginStateScope,
    range: {
      keyStartInclusive: string;
      keyEndExclusive: string;
      limit: number;
      order?: "asc" | "desc";
    },
  ): Promise<AzureSqlPluginStateRawEntry[]> {
    try {
      await this.ensureSchema();
      const direction = range.order === "desc" ? "DESC" : "ASC";
      const result = await this.database.query<AzureSqlPluginStateRow>(
        `SELECT TOP (@limit) entry_key, value_json, created_at_ms, expires_at_ms
         FROM ${AZURE_SQL_PLUGIN_STATE_TABLE}
         WHERE plugin_id = @pluginId AND namespace = @namespace
           AND entry_key >= @keyStart AND entry_key < @keyEnd
           AND (expires_at_ms IS NULL OR expires_at_ms > ${AZURE_SQL_NOW_MS})
         ORDER BY entry_key ${direction}`,
        (request) => {
          bindScope(request, scope);
          request.input("keyStart", mssql.NVarChar(512), range.keyStartInclusive);
          request.input("keyEnd", mssql.NVarChar(512), range.keyEndExclusive);
          request.input("limit", mssql.Int(), range.limit);
        },
      );
      return result.rows.map(rowToRaw);
    } catch (error) {
      throw wrapPluginStateError(
        error,
        "entries",
        "PLUGIN_STATE_READ_FAILED",
        "Failed to list plugin state entries by key range.",
      );
    }
  }

  async countLiveEntries(pluginId: string): Promise<number> {
    try {
      await this.ensureSchema();
      const result = await this.database.query<{ entry_count: number | string }>(
        `SELECT COUNT_BIG(*) AS entry_count
         FROM ${AZURE_SQL_PLUGIN_STATE_TABLE}
         WHERE plugin_id = @pluginId
           AND (expires_at_ms IS NULL OR expires_at_ms > ${AZURE_SQL_NOW_MS})`,
        (request) => request.input("pluginId", mssql.NVarChar(256), pluginId),
      );
      return normalizeInteger(result.rows[0]?.entry_count ?? 0) ?? 0;
    } catch (error) {
      throw wrapPluginStateError(
        error,
        "entries",
        "PLUGIN_STATE_READ_FAILED",
        "Failed to count plugin state entries.",
      );
    }
  }

  async sweepExpired(): Promise<number> {
    try {
      return await this.write(async () => {
        const result = await this.database.query(
          `WITH expired AS (
             SELECT TOP (1024) *
             FROM ${AZURE_SQL_PLUGIN_STATE_TABLE}
             WHERE expires_at_ms IS NOT NULL AND expires_at_ms <= ${AZURE_SQL_NOW_MS}
             ORDER BY expires_at_ms ASC
           )
           DELETE FROM expired`,
        );
        return result.rowsAffected.reduce((sum, value) => sum + value, 0);
      });
    } catch (error) {
      throw wrapPluginStateError(
        error,
        "sweep",
        "PLUGIN_STATE_WRITE_FAILED",
        "Failed to sweep expired plugin state entries.",
      );
    }
  }

  async importIfAbsent(
    scope: AzureSqlPluginStateScope,
    input: AzureSqlPluginStateImportInput,
  ): Promise<AzureSqlPluginStateImportResult> {
    try {
      return await this.write(
        async () =>
          await this.database.transaction(async (transaction) => {
            await acquirePluginLock(transaction, scope.pluginId);
            await deleteExpiredScope(transaction, scope);
            const current = await selectRaw(transaction, scope, input.key, true);
            if (current) {
              return { status: "existing", entry: current };
            }
            await assertCanInsert(transaction, scope);
            await writeEntry(transaction, scope, input);
            await enforceLimits(transaction, scope, input.key);
            return { status: "inserted" };
          }),
      );
    } catch (error) {
      throw wrapPluginStateError(
        error,
        "register",
        "PLUGIN_STATE_WRITE_FAILED",
        "Failed to import plugin state entry.",
      );
    }
  }

  async importBatch(
    scope: AzureSqlPluginStateScope,
    entries: readonly AzureSqlPluginStateRegisterInput[],
  ): Promise<void> {
    for (const entry of entries) {
      await this.register(scope, entry);
    }
  }

  async clear(scope: AzureSqlPluginStateScope): Promise<void> {
    try {
      await this.write(async () => {
        await this.database.query(
          `DELETE FROM ${AZURE_SQL_PLUGIN_STATE_TABLE}
           WHERE plugin_id = @pluginId AND namespace = @namespace`,
          (request) => bindScope(request, scope),
        );
      });
    } catch (error) {
      throw wrapPluginStateError(
        error,
        "clear",
        "PLUGIN_STATE_WRITE_FAILED",
        "Failed to clear plugin state entries.",
      );
    }
  }

  async appendSequencedJournalEntry(params: {
    cursorScope: AzureSqlPluginStateScope;
    journalScope: AzureSqlPluginStateScope;
    expectedCursor: AzureSqlPluginStateRawEntry | undefined;
    cursor: AzureSqlPluginStateRegisterInput;
    journal: AzureSqlPluginStateRegisterInput;
  }): Promise<AzureSqlPluginStateCasResult> {
    try {
      return await this.write(
        async () =>
          await this.database.transaction(async (transaction) => {
            await acquirePluginLock(transaction, params.cursorScope.pluginId);
            await deleteExpiredScope(transaction, params.cursorScope);
            await deleteExpiredScope(transaction, params.journalScope);
            const current = await selectRaw(
              transaction,
              params.cursorScope,
              params.cursor.key,
              true,
            );
            if (!sameRaw(current, params.expectedCursor)) {
              return "conflict";
            }
            if (await selectRaw(transaction, params.journalScope, params.journal.key, true)) {
              throw pluginStateError({
                code: "PLUGIN_STATE_WRITE_FAILED",
                operation: "register",
                message: "Plugin state journal sequence already exists.",
              });
            }
            if (!current) {
              await assertCanInsert(transaction, params.cursorScope);
            }
            await assertCanInsert(transaction, params.journalScope);
            await writeEntry(transaction, params.cursorScope, params.cursor);
            await enforceLimits(transaction, params.cursorScope, params.cursor.key, false);
            await writeEntry(transaction, params.journalScope, params.journal);
            await enforceLimits(transaction, params.journalScope, params.journal.key);
            return "applied";
          }),
      );
    } catch (error) {
      throw wrapPluginStateError(
        error,
        "register",
        "PLUGIN_STATE_WRITE_FAILED",
        "Failed to register sequenced plugin state journal entry.",
      );
    }
  }

  async compareAndSet(
    scope: AzureSqlPluginStateScope,
    expected: AzureSqlPluginStateRawEntry | undefined,
    next: AzureSqlPluginStateRegisterInput,
  ): Promise<AzureSqlPluginStateCasResult> {
    try {
      return await this.write(
        async () =>
          await this.database.transaction(async (transaction) => {
            await acquirePluginLock(transaction, scope.pluginId);
            await deleteExpiredScope(transaction, scope);
            const current = await selectRaw(transaction, scope, next.key, true);
            if (!sameRaw(current, expected)) {
              return "conflict";
            }
            if (!current) {
              await assertCanInsert(transaction, scope);
            }
            await writeEntry(transaction, scope, next);
            await enforceLimits(transaction, scope, next.key);
            return "applied";
          }),
      );
    } catch (error) {
      throw wrapPluginStateError(
        error,
        "register",
        "PLUGIN_STATE_WRITE_FAILED",
        "Failed to update plugin state entry.",
      );
    }
  }

  async deleteEntriesIfUnchanged(
    scope: AzureSqlPluginStateScope,
    expectedEntries: readonly AzureSqlPluginStateRawEntry[],
    assertRepairAuthority: () => void,
  ): Promise<{ deleted: number; changed: number }> {
    try {
      return await this.write(
        async () =>
          await this.database.transaction(async (transaction) => {
            await acquirePluginLock(transaction, scope.pluginId);
            assertRepairAuthority();
            let deleted = 0;
            let changed = 0;
            for (const expected of expectedEntries) {
              const current = await selectRaw(transaction, scope, expected.key, true);
              assertRepairAuthority();
              if (!sameRaw(current, expected)) {
                changed += 1;
                continue;
              }
              const result = await transaction.query(
                `DELETE FROM ${AZURE_SQL_PLUGIN_STATE_TABLE}
                 WHERE plugin_id = @pluginId AND namespace = @namespace
                   AND entry_key_hash = HASHBYTES('SHA2_256', CONVERT(varbinary(max), @entryKey))
                   AND entry_key = @entryKey`,
                (request) => {
                  bindScope(request, scope);
                  request.input("entryKey", mssql.NVarChar(512), expected.key);
                },
              );
              deleted += result.rowsAffected.reduce((sum, value) => sum + value, 0);
              assertRepairAuthority();
            }
            assertRepairAuthority();
            return { deleted, changed };
          }),
      );
    } catch (error) {
      throw wrapPluginStateError(
        error,
        "delete",
        "PLUGIN_STATE_WRITE_FAILED",
        "Failed to delete plugin state entries during Doctor repair.",
      );
    }
  }

  async deleteIfUnchanged(
    scope: AzureSqlPluginStateScope,
    expected: AzureSqlPluginStateRawEntry,
  ): Promise<AzureSqlPluginStateCasResult> {
    try {
      return await this.write(
        async () =>
          await this.database.transaction(async (transaction) => {
            const current = await selectRaw(transaction, scope, expected.key, true);
            if (!sameRaw(current, expected)) {
              return "conflict";
            }
            await transaction.query(
              `DELETE FROM ${AZURE_SQL_PLUGIN_STATE_TABLE}
             WHERE plugin_id = @pluginId AND namespace = @namespace
               AND entry_key_hash = HASHBYTES('SHA2_256', CONVERT(varbinary(max), @entryKey))
               AND entry_key = @entryKey`,
              (request) => {
                bindScope(request, scope);
                request.input("entryKey", mssql.NVarChar(512), expected.key);
              },
            );
            return "applied";
          }),
      );
    } catch (error) {
      throw wrapPluginStateError(
        error,
        "delete",
        "PLUGIN_STATE_WRITE_FAILED",
        "Failed to delete plugin state entry.",
      );
    }
  }
}
