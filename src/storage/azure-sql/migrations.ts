import { createHash } from "node:crypto";
import mssql from "mssql";
import type { AzureSqlProjectDatabase } from "./project-registry-store.js";
import type { AzureSqlTransaction } from "./runtime.js";

const MIGRATION_SCHEMA = "openclaw_global";
const MIGRATION_TABLE = `[${MIGRATION_SCHEMA}].[storage_migrations]`;
const MIGRATION_LOCK_RESOURCE = "openclaw.storage.migrations";

const MIGRATION_TABLE_SQL = `
IF SCHEMA_ID(N'${MIGRATION_SCHEMA}') IS NULL
BEGIN
  EXEC(N'CREATE SCHEMA [${MIGRATION_SCHEMA}]');
END;
IF OBJECT_ID(N'${MIGRATION_TABLE}', N'U') IS NULL
BEGIN
  CREATE TABLE ${MIGRATION_TABLE} (
    migration_id nvarchar(128) NOT NULL PRIMARY KEY,
    version int NOT NULL,
    checksum_sha256 char(64) NOT NULL,
    applied_at_ms bigint NOT NULL
  );
END;
`;

const ACQUIRE_MIGRATION_LOCK_SQL = `
DECLARE @result int;
EXEC @result = sp_getapplock
  @Resource = N'${MIGRATION_LOCK_RESOURCE}',
  @LockMode = N'Exclusive',
  @LockOwner = N'Transaction',
  @LockTimeout = 30000;
IF @result < 0
BEGIN
  THROW 51000, 'Could not acquire OpenClaw storage migration lock', 1;
END;
`;

export type AzureSqlMigration = {
  id: string;
  version: number;
  sql: string;
};

export type AzureSqlMigrationResult = {
  applied: string[];
  alreadyApplied: string[];
};

type AppliedMigrationRow = {
  migration_id: string;
  version: number;
  checksum_sha256: string;
};

function migrationChecksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

function validateMigrations(migrations: readonly AzureSqlMigration[]): AzureSqlMigration[] {
  const ordered = [...migrations].toSorted((left, right) => left.version - right.version);
  const ids = new Set<string>();
  let previousVersion = 0;
  for (const migration of ordered) {
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(migration.id)) {
      throw new Error(`Invalid Azure SQL migration id: ${migration.id}`);
    }
    if (ids.has(migration.id)) {
      throw new Error(`Duplicate Azure SQL migration id: ${migration.id}`);
    }
    if (!Number.isSafeInteger(migration.version) || migration.version <= previousVersion) {
      throw new Error(`Azure SQL migration versions must be increasing: ${migration.id}`);
    }
    if (!migration.sql.trim()) {
      throw new Error(`Azure SQL migration ${migration.id} has empty SQL`);
    }
    ids.add(migration.id);
    previousVersion = migration.version;
  }
  return ordered;
}

async function readAppliedMigrations(
  transaction: AzureSqlTransaction,
): Promise<Map<string, AppliedMigrationRow>> {
  const result = await transaction.query<AppliedMigrationRow>(
    `SELECT migration_id, version, checksum_sha256 FROM ${MIGRATION_TABLE}`,
  );
  return new Map(result.rows.map((row) => [row.migration_id, row]));
}

export async function runAzureSqlMigrations(
  database: AzureSqlProjectDatabase,
  migrations: readonly AzureSqlMigration[],
  now: () => number = Date.now,
): Promise<AzureSqlMigrationResult> {
  const ordered = validateMigrations(migrations);
  return await database.transaction(async (transaction) => {
    // The application lock has no schema dependency, so it must serialize the first bootstrap DDL too.
    await transaction.query(ACQUIRE_MIGRATION_LOCK_SQL);
    await transaction.query(MIGRATION_TABLE_SQL);
    const applied = await readAppliedMigrations(transaction);
    const knownIds = new Set(ordered.map((migration) => migration.id));
    const unknownApplied = [...applied.keys()].filter((id) => !knownIds.has(id)).toSorted();
    if (unknownApplied.length > 0) {
      throw new Error(
        `Azure SQL schema contains migrations newer than this build: ${unknownApplied.join(", ")}`,
      );
    }
    const result: AzureSqlMigrationResult = { applied: [], alreadyApplied: [] };
    for (const migration of ordered) {
      const checksum = migrationChecksum(migration.sql);
      const existing = applied.get(migration.id);
      if (existing) {
        if (existing.version !== migration.version || existing.checksum_sha256 !== checksum) {
          throw new Error(`Azure SQL migration drift detected for ${migration.id}`);
        }
        result.alreadyApplied.push(migration.id);
        continue;
      }
      await transaction.query(migration.sql);
      await transaction.query(
        `
        INSERT INTO ${MIGRATION_TABLE}
          (migration_id, version, checksum_sha256, applied_at_ms)
        VALUES (@migrationId, @version, @checksum, @appliedAtMs)
        `,
        (request) => {
          request.input("migrationId", mssql.NVarChar(128), migration.id);
          request.input("version", mssql.Int(), migration.version);
          request.input("checksum", mssql.Char(64), checksum);
          request.input("appliedAtMs", mssql.BigInt(), now());
        },
      );
      result.applied.push(migration.id);
    }
    return result;
  });
}
