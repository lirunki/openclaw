import type { AzureSqlMigration } from "./migrations.js";

const PLUGIN_STATE_SCHEMA = "openclaw_global";
const PLUGIN_STATE_TABLE = `[${PLUGIN_STATE_SCHEMA}].[plugin_state_entries]`;
const IDENTITY_COLLATION = "Latin1_General_100_BIN2";

const PLUGIN_STATE_SCHEMA_V3_SQL = `
IF SCHEMA_ID(N'${PLUGIN_STATE_SCHEMA}') IS NULL
BEGIN
  EXEC(N'CREATE SCHEMA [${PLUGIN_STATE_SCHEMA}]');
END;
IF OBJECT_ID(N'${PLUGIN_STATE_TABLE}', N'U') IS NULL
BEGIN
  CREATE TABLE ${PLUGIN_STATE_TABLE} (
    plugin_id nvarchar(256) COLLATE ${IDENTITY_COLLATION} NOT NULL,
    namespace nvarchar(128) COLLATE ${IDENTITY_COLLATION} NOT NULL,
    entry_key nvarchar(512) COLLATE ${IDENTITY_COLLATION} NOT NULL,
    entry_key_hash binary(32) NOT NULL,
    value_json nvarchar(max) NOT NULL,
    created_at_ms bigint NOT NULL,
    expires_at_ms bigint NULL,
    CONSTRAINT PK_openclaw_plugin_state_entries
      PRIMARY KEY (plugin_id, namespace, entry_key_hash)
  );
  CREATE INDEX IX_openclaw_plugin_state_entries_listing
    ON ${PLUGIN_STATE_TABLE}(plugin_id, namespace, created_at_ms)
    INCLUDE (entry_key);
  CREATE INDEX IX_openclaw_plugin_state_entries_plugin_capacity
    ON ${PLUGIN_STATE_TABLE}(plugin_id, created_at_ms, namespace)
    INCLUDE (entry_key, entry_key_hash);
  CREATE INDEX IX_openclaw_plugin_state_entries_expiry
    ON ${PLUGIN_STATE_TABLE}(expires_at_ms)
    WHERE expires_at_ms IS NOT NULL;
END;
`;

export const AZURE_SQL_PLUGIN_STATE_MIGRATION: AzureSqlMigration = {
  id: "global.plugin-state.v1",
  version: 3,
  sql: PLUGIN_STATE_SCHEMA_V3_SQL,
};

export { PLUGIN_STATE_TABLE as AZURE_SQL_PLUGIN_STATE_TABLE };
