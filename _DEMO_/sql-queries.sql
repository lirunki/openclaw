-- OpenClaw Azure SQL storage-abstraction demo query template.
--
-- _DEMO_/run-demo.sh generates a ready-to-run copy with the current synthetic
-- identifiers in its temporary runtime directory and prints that path.
-- If running this template manually, replace all three placeholders.

DECLARE @project_id nvarchar(64) = N'<DEMO_PROJECT_ID>';
DECLARE @repo_root nvarchar(2048) = N'<DEMO_REPO_ROOT>';
DECLARE @plugin_id nvarchar(256) = N'<DEMO_PLUGIN_ID>';
DECLARE @plugin_namespace nvarchar(128) = N'storage-demo';

-- Project-registry and plugin-state migrations should be present.
SELECT migration_id, version, applied_at_ms
FROM openclaw_global.storage_migrations
WHERE migration_id IN (N'global.projects.v1', N'global.projects.v2', N'global.plugin-state.v1')
ORDER BY version;

-- During the active-lease pause: 1 project, 1 lease, 2 plugin-state rows.
-- After lease release:           1 project, 0 leases, 2 plugin-state rows.
-- One plugin-state row is written directly and one through the synchronous mailbox.
-- After final cleanup:           0 projects, 0 leases, 0 plugin-state rows.
SELECT COUNT_BIG(*) AS demo_project_rows
FROM openclaw_global.projects
WHERE id = @project_id OR repo_root = @repo_root;

SELECT COUNT_BIG(*) AS demo_lease_rows
FROM openclaw_global.project_checkout_leases
WHERE lease_key = @repo_root;

SELECT COUNT_BIG(*) AS demo_plugin_state_rows
FROM openclaw_global.plugin_state_entries
WHERE plugin_id = @plugin_id AND namespace = @plugin_namespace;

SELECT id, display_name, repo_root, source,
       DATALENGTH(repo_root_hash) AS repo_root_hash_bytes
FROM openclaw_global.projects
WHERE id = @project_id OR repo_root = @repo_root;

SELECT plugin_id, namespace, entry_key, value_json, created_at_ms, expires_at_ms,
       DATALENGTH(entry_key_hash) AS entry_key_hash_bytes
FROM openclaw_global.plugin_state_entries
WHERE plugin_id = @plugin_id AND namespace = @plugin_namespace;

SELECT OBJECT_SCHEMA_NAME(c.object_id) AS schema_name, OBJECT_NAME(c.object_id) AS table_name,
       c.name AS column_name, t.name AS sql_type, c.max_length, c.collation_name
FROM sys.columns AS c
JOIN sys.types AS t ON t.user_type_id = c.user_type_id
WHERE (c.object_id = OBJECT_ID(N'openclaw_global.projects')
       AND c.name IN (N'id', N'repo_root', N'repo_root_hash', N'origin_url_hash'))
   OR (c.object_id = OBJECT_ID(N'openclaw_global.plugin_state_entries')
       AND c.name IN (N'plugin_id', N'namespace', N'entry_key', N'entry_key_hash'))
ORDER BY table_name, c.column_id;
