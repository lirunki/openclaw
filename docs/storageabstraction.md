# Storage Abstraction: SQLite and Azure SQL

## Purpose

OpenClaw will support two durable operational-storage backends:

- **SQLite**, the existing default for local installations.
- **Azure SQL**, an optional backend selected during setup for deployments that need a managed remote database.

This project does **not** remove SQLite. It introduces a permanent storage abstraction so both backends implement the same OpenClaw persistence and lifecycle contracts.

Existing local files remain local artifacts. The Azure SQL backend stores operational state and references/metadata for those artifacts; it does not implicitly move workspaces, attachments, media, skill bundles, exports, or other named file artifacts to Azure.

## Target architecture

```text
OpenClaw domain services
          |
          v
Backend-neutral storage contracts
          |
    +-----+------+
    |            |
    v            v
 SQLite       Azure SQL
 backend      backend
 (default)    (optional)

Local filesystem remains the owner of workspaces and named artifacts.
```

The abstraction is a compatibility boundary, not a fake implementation of `node:sqlite`. Azure SQL is asynchronous and networked; it must not expose `DatabaseSync` or `StatementSync` as backend contracts.

During the plugin-state migration only, existing trusted synchronous keyed-store callers use an internal blocking worker bridge. The worker executes the canonical asynchronous Azure SQL operations and returns only after the operation succeeds or fails; it does not cache reads, queue deferred writes, or weaken durability. This compatibility path is not a new public SDK capability, must not gain new callers, and is removed after bundled and core plugin-state clients migrate to the asynchronous API.

## Goals

- Preserve SQLite as the default and fully supported local backend.
- Allow Azure SQL to be selected during onboarding or configuration.
- Preserve storage ownership, transaction, concurrency, retention, recovery, and lifecycle behavior across both backends.
- Provide an offline migration tool, initially from SQLite to Azure SQL and potentially in the reverse direction.
- Keep local workspaces and file artifacts local unless a separate product decision explicitly changes that ownership.
- Avoid indefinite dual-write or hidden fallback between backends.
- Test both backends against the same behavioral contract.
- Make backend health and capability failures visible to operators.

## Non-goals

- Replacing SQLite everywhere.
- Mounting Azure Files underneath SQLite for production state.
- Implementing Azure SQL as a transparent `node:sqlite` replacement.
- Using Azure Storage, Cosmos DB, or Kusto as the operational database.
- Silently moving local artifacts to cloud storage.
- Treating cached or stale data as authoritative for ownership, authorization, leases, or queue claims.

## Design checkpoints

This work changes persistent storage semantics and adds a public backend configuration surface. Before implementing the runtime migration, the project needs an accepted design record covering:

- Backend configuration and setup UX.
- Azure SQL tenancy and database layout.
- Authentication and secret ownership.
- Schema and migration versions.
- Transaction and isolation semantics.
- Offline migration and rollback.
- Local-file ownership.
- Search and memory capabilities.
- Outage and offline behavior.
- Backup, Doctor, and recovery behavior.

Any new configuration option requires explicit approval before implementation. Any material SQLite or persistent-store change requires the repository's persistence design checkpoint.

## Backend-neutral storage contracts

The abstraction should expose domain operations rather than SQL or database handles. Prefer separate repositories for separate ownership boundaries:

```text
SessionStore
DeliveryQueueStore
TaskRegistryStore
CronStore
ApprovalStore
PluginStateStore
WorkerPlacementStore
AuditStore
MemoryIndex
ArtifactMetadataStore
```

Contracts should model:

- Async reads and writes.
- Authoritative versus cacheable reads.
- Transaction-local reads.
- Conditional writes and concurrency conflicts.
- Idempotency.
- Owner and lifecycle validation.
- Lease and claim behavior.
- Retention and deletion.
- Restart and recovery behavior.
- Retryable, conflict, unavailable, and terminal errors.
- Backend capabilities such as text and vector search.

Contracts must not expose:

- `DatabaseSync` or `StatementSync`.
- SQLite SQL or `PRAGMA`.
- SQLite paths or sidecar files.
- Kysely types coupled to SQLite.
- Azure SQL connection pools or driver-specific objects.

A repository method should express the operation it owns. For example, a delivery queue repository should provide operations such as `reserveDeliveryAttempt`, `terminalizeDelivery`, and `pruneRetainedEntries`, not a generic `executeSql` method.

## Backend selection

Backend selection must be explicit and fixed at process startup. The runtime must not dynamically switch databases in hot paths.

The eventual configuration shape is subject to approval, but is conceptually similar to:

```json
{
  "storage": {
    "backend": "sqlite"
  }
}
```

or:

```json
{
  "storage": {
    "backend": "azuresql"
  }
}
```

### SQLite setup

SQLite remains the default:

- Uses the existing local state and per-agent database files.
- Requires no Azure credentials.
- Retains local operation.
- Retains existing WAL, integrity, backup, and migration behavior.

### Azure SQL setup

Azure SQL setup must:

- Validate the selected authentication method.
- Validate connectivity and permissions.
- Create or verify the required schema.
- Run a transaction and readback health check.
- Verify local artifact directories remain writable.
- Report missing search capabilities explicitly.
- Produce actionable errors when Azure SQL is unavailable.

## Current storage ownership to preserve

### Global control-plane state

The current owner is `src/state/openclaw-state-db.ts` and `src/state/openclaw-state-schema.sql`.

It stores shared state including:

- Configuration and health state.
- Agent registration and lifecycle.
- Approvals and audit records.
- Device pairing and authentication metadata.
- Plugin state.
- Cron, tasks, and delivery queues.
- Worker placement and recovery.
- Projects, worktrees, backups, and migrations.
- Meeting transcript metadata.

### Per-agent state

The current owner is `src/state/openclaw-agent-db.ts` and `src/state/openclaw-agent-schema.sql`.

It stores agent-scoped:

- Sessions and session windows.
- Transcript events and projections.
- Conversations and delivery state.
- Participants and pending inputs.
- Auth profiles.
- Memory indexes and metadata.
- Runtime caches.
- Trajectory and ACP state.

### Dedicated feature stores

Each dedicated SQLite store must be classified independently:

- `extensions/workboard/src/sqlite-store.ts`
- `extensions/logbook/src/store.ts`
- `src/proxy-capture/store.sqlite.ts`
- `extensions/imessage/src/message-resource-db.ts`
- Other plugin-specific stores.

For each store, document whether it is:

- Operational state that must support both backends.
- Derived state that can be rebuilt.
- A local artifact index.
- A local-only feature that needs an explicit capability result.

## Implementation phases

### Phase 1: persistence inventory

Create a complete persistence matrix for every SQLite-backed store and table:

```text
current owner
canonical data
derived data
local artifact data
read API
write API
transaction boundary
concurrency mechanism
retention policy
migration owner
cache policy
Azure SQL mapping
```

The inventory must cover callers and lifecycle owners, not only files containing the word `sqlite`.

Primary surfaces include:

- `src/state/openclaw-state-db.ts`
- `src/state/openclaw-agent-db.ts`
- `src/infra/delivery-queue-sqlite.ts`
- `src/tasks/task-registry.store.sqlite.ts`
- `src/cron/store.ts`
- `src/config/sessions/session-transcript-index.ts`
- `extensions/memory-core/src/memory/manager-db.ts`

### Phase 2: SQLite behind the abstraction

Refactor domain callers to use backend-neutral repositories while retaining SQLite underneath.

This phase must preserve the existing default behavior. The initial SQLite adapter may wrap the current implementation, but SQLite-specific lifecycle and schema logic should remain inside that adapter.

The desired direction is:

```text
Domain service -> storage contract -> SQLite adapter
```

rather than:

```text
Domain service -> node:sqlite/Kysely/SQLite tables
```

The SQLite adapter should expose async contract methods where the shared abstraction is async, even if its internal implementation remains synchronous.

### Phase 3: Azure SQL runtime

Select and directly verify an appropriate Microsoft-supported Node Azure SQL driver and query layer before adding the dependency.

The runtime must provide:

- Connection pooling.
- Async queries and transactions.
- Managed identity or approved credential authentication.
- Query timeouts and cancellation.
- Deadlock and transient-error classification.
- Safe retry boundaries.
- Migration locking.
- Health checks.
- Correlation IDs and diagnostics.
- Graceful shutdown.

Do not retry ambiguous non-idempotent commits without an idempotency contract. Do not hide Azure SQL outages through stale fallback reads.

### Phase 4: Azure SQL schema and migrations

Create Azure SQL physical schemas for the logical global and agent storage contracts.

Use a dedicated migration table rather than SQLite's `PRAGMA user_version`. Track logical contract versions separately from physical backend versions:

```text
logical contract: version N
SQLite physical schema: version X
Azure SQL physical schema: version Y
```

Translate semantics explicitly:

- SQLite `STRICT` tables to explicit SQL Server types and constraints.
- JSON text to suitable `nvarchar(max)` columns with validation where appropriate.
- SQLite blobs to `varbinary(max)`.
- `last_insert_rowid()` to `OUTPUT INSERTED`.
- SQLite conflict syntax to explicit Azure SQL conflict handling.
- Partial indexes to equivalent filtered indexes where valid.
- SQLite triggers only to SQL Server triggers where the invariant requires them.
- SQLite schema inspection to SQL Server catalog queries.

Schema migration must use a single-flight database lock so multiple Gateway instances cannot migrate concurrently.

### Phase 5: first Azure SQL vertical slice

Start with a bounded store, preferably the project registry or plugin-state store.

The slice must include:

1. Backend-neutral contract.
2. SQLite implementation.
3. Azure SQL implementation.
4. Azure SQL schema and migration.
5. Contract tests for both backends.
6. Setup/health validation.
7. Error and retry behavior.
8. Offline migration support for that store.

The task registry is a strong second slice because it exercises JSON payloads, indexes, status transitions, ownership, and transactions.

### Phase 6: operational stores

Migrate support in this order unless evidence changes the priority:

1. Project registry.
2. Plugin state.
3. Task registry.
4. Task-flow registry.
5. Cron.
6. Delivery queue.
7. Approvals.
8. Audit and execution identity.
9. Worker placement and leases.
10. Sessions and conversations.
11. Transcripts.
12. Memory.

For each store:

1. Define the contract.
2. Keep SQLite contract tests passing.
3. Implement Azure SQL.
4. Add schema/migrations.
5. Add concurrency and failure tests.
6. Add offline import/export.
7. Verify operator-visible behavior.

### Phase 7: queues, leases, and lifecycle state

These paths require dedicated concurrency proof.

The Azure SQL implementation must preserve conditional mutation semantics for:

- Delivery claims.
- Task transitions.
- Maintenance leases.
- Worker turn claims.
- Placement generations.
- Owner epochs.
- Agent deletion fences.
- Approval changes.

Affected-row counts from conditional updates should determine whether the operation still owns authority. A cached prior read must never authorize a privileged mutation.

### Phase 8: sessions and transcripts

Preserve the distinction between:

- Canonical session nodes.
- Session windows and generations.
- Canonical transcript events.
- Derived active-event projections.
- Search indexes.
- Watermarks.

Refactor `src/config/sessions/session-transcript-index.ts` to use a storage/index contract rather than SQLite tables. Preserve rebuild behavior, retryable projection-unavailable states, bounded work, deletion semantics, and canonical transcript ownership.

### Phase 9: memory and search

Treat memory as a capability-backed subsystem rather than a direct SQLite schema port.

Define operations such as:

```text
upsertMemoryChunks
searchText
searchVector
deleteMemorySource
rebuildMemoryIndex
```

SQLite may continue using FTS and `sqlite-vec`. Azure SQL should use an explicitly selected text/vector capability. The backend must report unavailable optional search features clearly rather than silently returning empty results.

### Phase 10: local artifacts and dedicated stores

Separate operational metadata from local artifact content.

For workboard, logbook, and proxy capture:

- Keep attachments, frames, payload blobs, workspace files, and bundles local.
- Store ownership, hashes, sizes, paths, lifecycle state, and references through the selected storage backend.
- Write and verify local artifacts before publishing committed metadata references.
- Clean up or quarantine unreferenced artifacts after failed publication.

### Phase 11: offline migration

Provide an explicit offline migration tool, initially:

```text
SQLite -> Azure SQL
```

Optionally support:

```text
Azure SQL -> SQLite
```

The migration must:

1. Require the Gateway and all writers to be stopped.
2. Verify source integrity and schema compatibility.
3. Create a consistent source snapshot.
4. Create or migrate the target schema.
5. Copy canonical records.
6. Preserve IDs, timestamps, ownership, and lifecycle state.
7. Validate foreign keys, uniqueness, counts, and checksums.
8. Rebuild derived projections and search indexes.
9. Leave the source unchanged.
10. Produce a migration report.
11. Support retry after failure.

The migration tool must detect unsupported data or feature-capability differences instead of silently dropping records.

Normal runtime should not dual-write. During migration, one backend is authoritative and all writers are stopped.

### Phase 12: backend-aware Doctor and backup

SQLite mode should retain:

- WAL-aware snapshots.
- File integrity checks.
- Local backups.
- SQLite schema preflight.

Azure SQL mode should provide:

- Connectivity and permission checks.
- Schema/migration status.
- Database identity reporting.
- Transaction/readback health checks.
- Backend-specific backup guidance.
- Local artifact consistency checks.

Status and Doctor should distinguish:

```text
Storage backend: SQLite or Azure SQL
Storage health: healthy, degraded, or unavailable
Local artifact storage: healthy or degraded
```

### Phase 13: native clients and tooling

`apps/shared/OpenClawKit/Sources/OpenClawNativeState/OpenClawNativeStateSQLite.swift` currently opens selected shared SQLite tables directly.

In Azure SQL mode, native clients must not assume a local SQLite file exists. Prefer a narrow Gateway/API surface or a Gateway-maintained local cache over embedding broad Azure SQL credentials in the native app.

Update CLI, Doctor, status, backup, reset, session inspection, and migration tooling to use the selected backend rather than assuming a `.sqlite` path.

### Phase 14: performance and caching

The storage abstraction should provide:

- Authoritative reads for queues, leases, approvals, ownership, pending inputs, and lifecycle state.
- Transaction-local caching.
- Bounded process-local caching for safe metadata.
- Commit-time cache update/invalidation.
- No hidden fallback between backends.

Measure Azure SQL round trips, transaction duration, connection-pool wait time, deadlocks, retry rate, cache hit rate, and query plans before introducing a distributed cache.

### Phase 15: production hardening

Validate both modes under:

- Connection loss.
- Azure SQL failover or transient unavailability.
- Deadlocks and lock timeouts.
- Process restart during a transaction.
- Stale worker claims.
- Partial migration failure.
- Local artifact publication failure.
- Search capability unavailability.
- Schema mismatch.
- Credential expiration.

## Migration and compatibility policy

SQLite and Azure SQL are both supported backends. Neither is a hidden fallback for the other.

- Runtime reads and writes use the selected backend only.
- Offline migration is the supported way to switch existing installations.
- A migration must have one authoritative source.
- Source data must remain unchanged until verification succeeds.
- Backend-specific limitations must be reported explicitly.
- A successful migration must be verifiable before the backend is switched.

## Test strategy

Every backend contract test should run against both implementations.

### Unit tests

- Serialization and row mapping.
- Error classification.
- Version checks.
- Cache invalidation.
- Capability reporting.

### Repository contract tests

- Bootstrap.
- Reads and writes.
- Transactions.
- Idempotency.
- Retention and deletion.
- Read-only operations.
- Restart behavior.
- Search behavior where supported.

### Concurrency tests

- Queue claims.
- Task transitions.
- Lease renewal and expiry.
- Deletion fences.
- Concurrent session updates.
- Duplicate retries.
- Stale generation rejection.

### Migration tests

- Empty target.
- Current SQLite source.
- Older supported source schema.
- Corrupt source.
- Duplicate migration execution.
- Partial failure and retry.
- Unsupported feature capability.
- Row-count and checksum validation.

Azure SQL tests must use isolated test resources and must never target an operator's production database.

## Milestones

### M1 — Storage contract and persistence matrix

No runtime behavior change.

### M2 — SQLite behind the abstraction

Preserve the existing default path and behavior.

### M3 — Azure SQL runtime and schema bootstrap

Prove authentication, connections, transactions, migrations, health, and shutdown.

### M4 — First Azure SQL vertical slice

Complete one store end to end with both-backend contract tests.

### M5 — Tasks, cron, and delivery

Prove transactional operational behavior.

### M6 — Approvals, audit, leases, and workers

Prove lifecycle and authority invariants.

### M7 — Sessions, conversations, and transcripts

Migrate the largest core surfaces.

### M8 — Memory and search capabilities

Implement and benchmark backend-specific search.

### M9 — Dedicated plugin stores and local artifact split

Cover workboard, logbook, proxy capture, and other supported stores.

### M10 — Setup and backend selection

Add the approved configuration and onboarding flow.

### M11 — Offline migration tooling

Provide verified SQLite-to-Azure SQL migration.

### M12 — Production hardening and documentation

Complete outage behavior, caching, backups, Doctor, status, and operator guidance.

## First work item

The first safe implementation step is to produce:

1. The persistence matrix.
2. The backend-neutral contract proposal.
3. The Azure SQL driver/dependency preflight.
4. The setup and migration design.
5. The first vertical-slice choice.

After that design is accepted, implement the project registry or plugin-state store end to end while keeping SQLite as the default and regression reference backend.

# Detailed execution runbook

The following sections turn each phase into an executable work package. Each package should produce a reviewable change, a named owner, tests, and an explicit exit gate. A phase may be split across multiple pull requests, but the exit gate must be satisfied before the next phase changes a dependent surface.

## Phase 0 execution: approve the design before persistence changes

### Design artifacts

Create a design record with these sections:

1. **Problem and user outcome** — why an operator chooses Azure SQL, what remains local, and what happens when Azure SQL is unavailable.
2. **Backend contract** — repository interfaces, consistency modes, transaction guarantees, error taxonomy, and capability reporting.
3. **Ownership map** — global state, per-agent state, feature-local state, derived projections, and local artifacts.
4. **Azure topology** — database layout, agent/tenant partitioning, regions, network path, identity, and connection limits.
5. **Schema plan** — logical contract versions, SQLite physical versions, Azure SQL migration versions, indexes, constraints, and retention.
6. **Migration plan** — stopped-writer requirement, snapshot method, copy order, validation, retry, rollback, and unsupported data.
7. **Security plan** — managed identity, least-privilege roles, secret handling, encryption, redaction, and local artifact permissions.
8. **Operational plan** — health checks, metrics, tracing, alerts, backups, outage behavior, and setup/Doctor UX.
9. **Alternatives rejected** — mounted Azure Files, Cosmos DB, Azure Storage primitives, fake `node:sqlite`, and indefinite dual-write.

### Decision gates

Do not implement a new storage schema, backend configuration key, Azure SQL dependency, or migration command until the design record is accepted. The acceptance must explicitly cover persistent representation, transaction boundaries, retention, concurrency, recovery, and downgrade behavior.

### Dependency preflight

Before selecting a driver:

- Inspect the candidate package source and types.
- Verify Node version support and ESM behavior.
- Verify connection pooling, transactions, cancellation, parameter binding, and managed identity support.
- Verify transient error and deadlock codes from the driver contract.
- Build a minimal live Azure SQL probe in an isolated resource.
- Record the exact package, version, license, and ownership decision.

Do not make timing, retry, or error claims from memory or a wrapper. Cite the inspected upstream contract in the design record.

### Exit gate

Phase 0 is complete only when the design record is accepted, the driver choice has direct evidence, open product decisions are listed, and the first vertical slice has a named owner and success criteria.

## Phase 1 execution: build the persistence inventory

### Inventory method

Start with the canonical schemas and then trace callers:

```bash
rg -n "CREATE TABLE|CREATE VIRTUAL TABLE" src/state extensions packages
rg -l "node:sqlite|DatabaseSync|openNodeSqliteDatabase|kysely" src extensions packages
rg -l "openclaw-state-db|openclaw-agent-db|plugin-state|delivery-queue|task-registry|cron" src extensions packages
```

Read each owning module completely enough to identify its entry points, callers, write paths, cleanup paths, tests, and migration code. Use `docs/reference/database-schemas.md` as the persistence-contract reference.

### Inventory record

For every table or dedicated store, record:

```text
logical owner
backend scope: global | agent | feature-local
canonical or derived
primary identity
foreign-key/ownership relationships
read operations
write operations
transaction boundary
concurrency/lease rule
retention and deletion
local artifact references
cache policy
SQLite implementation
Azure SQL target
migration order
contract tests
operator-visible failure
```

Use a stable table identifier rather than a filename so the inventory survives source refactors.

### Classification rules

- **Canonical** data must be migrated losslessly.
- **Derived** data must have a rebuild procedure and readiness signal.
- **Cache** data may be dropped only when no shipped contract requires it.
- **Local artifact** content stays under its filesystem owner; only metadata is migrated.
- **Coordination** data requires concurrency proof before backend parity is claimed.
- **Optional capability** data must report unavailable rather than silently produce an empty result.

### Evidence and completion

Capture one source path, one writer, one reader, one callee, one test, and one lifecycle/cleanup path for every critical store. Flag unresolved ownership instead of guessing.

Exit when every SQLite table and dedicated store has a target classification, owner, migration disposition, test owner, and explicit decision for local files.

## Phase 2 execution: put SQLite behind contracts

### Contract shape

Define narrow async repository contracts in a core storage area. Keep domain types separate from row types. Use closed result types for not-found, conflict, unavailable, and invalid-state outcomes.

A write method should return the committed domain result when possible so callers do not need an act-then-read round trip. Conditional mutations should return a typed conflict or `not-authoritative` result rather than a Boolean with ambiguous meaning.

### SQLite adapter

Wrap existing SQLite owners first. Do not rewrite schema or change retention in this phase. The adapter may call existing functions such as `runSqliteImmediateTransactionSync`, but no caller outside the adapter should import SQLite types.

Add an explicit adapter boundary for:

- connection/open lifecycle;
- read-only operations;
- write transactions;
- post-commit publication;
- integrity/health checks;
- schema version reporting.

### Refactor order

1. Add contract types and contract tests.
2. Adapt one low-risk SQLite store.
3. Move its callers to the contract.
4. Add a guard against new direct SQLite imports in the migrated surface.
5. Repeat for the next store.
6. Only then introduce the Azure SQL implementation.

### Testing

Run the existing store tests plus contract tests against SQLite. Add tests proving transaction rollback, post-commit publication, stale-owner rejection, deletion cleanup, and read-only behavior. Tests must fail if a caller bypasses the repository.

Exit when the first vertical slice has no domain-level SQLite imports, the SQLite path is behavior-neutral, and the contract suite passes.

## Phase 3 execution: build the Azure SQL runtime

### Runtime components

Implement separate modules for:

- pool construction and shutdown;
- credential/authentication resolution;
- query execution and parameter binding;
- transaction scope;
- cancellation and timeout;
- transient/deadlock classification;
- migration lock;
- health probe;
- redacted diagnostics.

Use constructor-injected runtime dependencies so tests can replace the pool and clock without broad module mocks.

### Connection policy

Configure pool size, acquire timeout, idle timeout, request timeout, and connection retry according to measured Azure SQL behavior and deployment limits. Keep these values backend-owned; do not scatter them through repositories.

Each request must carry a correlation identifier and an operation label. Logs must contain database/backend identity and duration, never credentials, tokens, raw SQL parameters containing secrets, or full sensitive JSON.

### Transaction policy

Expose explicit async transaction scopes. The scope must guarantee:

- one connection for the transaction;
- rollback on thrown errors;
- no use after commit/rollback;
- no retry inside an open transaction;
- post-commit callbacks run only after a successful commit;
- ambiguous commit errors are surfaced for reconciliation.

Repositories must perform owner/version predicates in the final mutation, even if they read the row earlier.

### Tests and live proof

Unit-test error classification and transaction cleanup. Integration-test pooling, rollback, cancellation, deadlock handling, and connection loss. Run a live isolated Azure SQL probe for authentication, schema access, commit/readback, timeout, and shutdown. Never print connection strings or access tokens.

Exit when the runtime can be used by one repository without importing SQLite or exposing driver types above the backend adapter.

## Phase 4 execution: implement Azure SQL schema and migrations

### Logical/physical mapping

Create a mapping for every logical table:

```text
logical table
Azure table
key columns
JSON columns and validation
indexes
foreign keys
filtered indexes
retention jobs
derived projections
migration dependencies
```

Use explicit SQL Server types. Decide timestamp representation once and use it consistently. Preserve opaque IDs as strings unless a contract explicitly requires numeric identity.

### Migration runner

The runner must:

1. Acquire a database-scoped migration lock.
2. Read current backend migration state.
3. Validate the expected previous version.
4. Apply one migration in a transaction where possible.
5. Record completion only after commit.
6. Release the lock in a `finally` path.
7. Produce a redacted migration report.

Non-transactional Azure DDL must have a compensating/recovery plan and a durable step marker. Never mark a migration complete before all required objects and validation checks exist.

### Schema verification

Verify tables, columns, nullability, indexes, keys, constraints, and required capabilities through Azure SQL catalog queries. Validate the logical contract separately from backend-specific physical details.

Add a target-release preflight that can inspect an explicit Azure SQL target without touching the operator's default backend.

### Tests

Test empty bootstrap, repeated migration, concurrent migration, interrupted migration, incompatible version, extra column/index, missing object, and schema repair refusal. Include downgrade/read-only compatibility decisions in the design record rather than assuming Azure SQL can reverse migrations automatically.

Exit when a fresh Azure SQL database can bootstrap, a second process cannot race migration, and the schema verifier detects intentional and unintentional drift.

## Phase 5 execution: first Azure SQL vertical slice

Choose the project registry or plugin-state store after confirming it has bounded ownership and no hidden cross-store transaction dependency. The task registry is the next candidate, not the first unless the inventory proves it is sufficiently isolated.

### Implementation sequence

1. Freeze the logical contract and row mapping.
2. Add the Azure schema migration.
3. Implement repository reads with parameterized queries.
4. Implement writes with explicit transactions and conflict predicates.
5. Add setup/health integration.
6. Add SQLite and Azure SQL contract tests.
7. Add an offline import/export fixture for this store.
8. Run a real Azure SQL smoke test.
9. Compare outputs and error behavior between backends.

### Acceptance criteria

- SQLite remains the default and unchanged for existing users.
- Azure SQL setup can create and verify the store.
- Create/read/update/delete behavior is equivalent.
- JSON and timestamps round-trip without loss.
- Concurrent conflicting writes produce a typed conflict.
- Health and unavailable errors tell the operator what to try next.
- No production code in the migrated surface imports `node:sqlite`.

Exit only after contract tests, live Azure proof, migration proof, and operator-visible error proof are complete.

## Phase 6 execution: migrate operational stores

Migrate one ownership neighborhood at a time. Do not combine unrelated stores merely because they share the same database.

### Store-specific work

- **Plugin state:** preserve namespace/key uniqueness, TTL, size limits, bulk-delete bounds, and expiry pruning.
- **Task registry:** preserve status transitions, terminal outcomes, owner bindings, delivery state, and cleanup.
- **Task flows:** preserve parent/child flow identity and terminal reconciliation.
- **Cron:** preserve canonical JSON, runtime authorities, quarantine, configured partitions, and run receipts.
- **Approvals:** preserve deletion fencing and exact mutation authority.
- **Audit:** preserve FIFO ordering, owner provenance, redaction, and no-authority behavior.
- **Worker placement:** preserve generation, owner epoch, environment, session identity, and restart fencing.
- **Sessions/conversations:** migrate only after the dedicated session phase is ready.

For each store, identify every transaction that currently spans tables. Either preserve it in one Azure SQL transaction or redesign the owner boundary explicitly; never split it accidentally because the tables are now repositories.

### Store exit gate

The store is complete only when its SQLite and Azure implementations pass the same contract suite, its migration is verified, its concurrency behavior is tested, its Doctor/status behavior is covered, and its direct SQLite callers are removed from the domain layer.

## Phase 7 execution: prove queues, leases, and lifecycle state

### Conditional mutation pattern

Every claim or privileged mutation must include the authoritative predicates in the mutation:

```sql
UPDATE ...
SET ...
WHERE id = @id
  AND owner_id = @ownerId
  AND generation = @generation
  AND status = @expectedStatus;
```

Treat one affected row as success and zero rows as a typed stale/conflict outcome. Never rely on a cached read or a copied bearer token as authority.

### Failure injection

Inject failures:

- before the read;
- after the read;
- before the mutation;
- after the mutation but before commit response;
- after commit and before publication;
- during lease renewal;
- during process restart;
- during connection loss;
- during migration.

Re-run each scenario in the original execution order. Verify no duplicate delivery, stale claim, unauthorized mutation, or silent non-outcome occurs.

### Proof

Use two or more real workers against an isolated Azure SQL database. Assert every action ends in a visible result or recorded intentional non-outcome. Include recovery after Gateway restart and expired lease cleanup.

Exit only when stale authority fails closed and the repaired path is covered at the repository boundary, not just through mocks.

## Phase 8 execution: migrate sessions and transcripts

### Canonical data first

Migrate canonical session nodes, windows, conversations, and transcript events before derived projections. Preserve IDs, parent relationships, generation reasons, creator/source metadata, ownership, and deletion behavior.

Derived tables must be marked unavailable until rebuilt and verified. Do not expose partially rebuilt indexes as complete.

### Async conversion

Convert session callers in dependency order:

1. low-level repository methods;
2. session accessor and lifecycle services;
3. Gateway handlers;
4. transcript projection/rebuild workers;
5. read-only CLI and status paths.

Collapse unnecessary read-after-write calls by returning committed results from repository operations.

### Projection migration

Refactor `src/config/sessions/session-transcript-index.ts` around a projection contract with:

- append watermark;
- active-event rebuild;
- FTS/index readiness;
- deletion cleanup;
- retryable unavailable state;
- bounded rebuild work.

### Tests

Cover create, reset, rollover, fork, rewind, compaction, delete, concurrent append, projection rebuild, stale watermark, and restart. Compare SQLite and Azure SQL logical results, not physical query plans.

Exit only when a migrated session can be used through the real Gateway flow and the transcript projection reports readiness truthfully.

## Phase 9 execution: memory and search

### Capability contract

Keep memory source state, chunk metadata, text search, vector search, and reindex coordination as separate capabilities. Return typed unavailable results when a backend lacks an optional capability.

The contract must specify:

- ranking and tie behavior;
- filtering by agent/source;
- embedding dimensions;
- deletion visibility;
- index readiness;
- rebuild consistency;
- maximum result count and payload size.

### Azure implementation

First benchmark Azure SQL-native text/vector search against representative OpenClaw memory data. If it cannot meet the contract, document the unsupported capability rather than silently changing recall semantics.

Do not port `sqlite-vec` virtual-table SQL directly. Implement the logical search operation using the selected Azure SQL capability.

### Migration and rebuild

Migrate canonical memory source/chunk metadata first. Rebuild derived text/vector indexes from canonical rows. Record index generation and readiness. A failed rebuild must leave the previous generation usable or explicitly report search unavailable.

### Tests

Use golden search fixtures for exact text, tokenization, filters, vector ranking, deletion, empty index, rebuild interruption, and large batches. Run latency and recall benchmarks for both backends and document any accepted difference.

## Phase 10 execution: local artifacts and dedicated stores

### Metadata/artifact split

For every file-backed feature, define:

```text
artifact identity
owner
relative/local path
content hash
size
MIME type
created/updated time
publication state
```

The selected storage backend owns metadata and lifecycle. The local filesystem owns bytes and permissions.

### Publication protocol

1. Validate destination containment.
2. Write to a temporary local path.
3. Flush/close and verify size/hash.
4. Rename into the final local artifact path.
5. Commit metadata/reference in the selected backend.
6. On metadata failure, remove or quarantine the unreferenced artifact.
7. On restart, reconcile staged and unreferenced artifacts without inventing references.

Never commit a database reference before the artifact is complete.

### Plugin work

For workboard, logbook, proxy capture, and other dedicated stores, retain local payloads while moving operational metadata behind the abstraction. If a feature cannot support Azure SQL yet, expose an explicit backend capability and setup/Doctor finding; do not silently use an unrelated local SQLite sidecar in Azure mode.

### Tests

Test crash points before and after artifact publication, hash mismatch, missing artifact, duplicate publication, cleanup, path traversal, and backend transaction failure. Verify that local files remain local in both modes.

## Phase 11 execution: offline migration

### Command design

The migration command must require an explicit source and target, for example:

```text
openclaw storage migrate --from sqlite --to azuresql --state-dir <dir>
```

Do not infer the target from ambient credentials or silently mutate the default installation. Support a dry-run/plan mode that performs discovery and validation without writing the target.

### Workflow

1. Confirm the Gateway is stopped and no writers hold the source.
2. Resolve and validate the source backend.
3. Create a WAL-aware SQLite snapshot when SQLite is the source.
4. Verify source schema and integrity.
5. Acquire target migration lock.
6. Create/upgrade target schema.
7. Copy global canonical data in dependency order.
8. Copy agent registrations and canonical agent data.
9. Copy local artifact metadata only; verify paths/hashes.
10. Rebuild derived projections and search indexes.
11. Validate row counts, keys, foreign keys, checksums, and logical invariants.
12. Write a redacted migration report.
13. Leave source untouched until the operator switches the backend.

### Retry and rollback

Each copy stage must be idempotent or use a migration-run identity and staging namespace. A failed run must be resumable or cleanly discardable. Do not delete source data as part of migration.

Rollback means switching the configured backend back to the verified source, not trying to reverse an incomplete remote transaction automatically. If Azure SQL has been used after cutover, a reverse migration requires a new stopped-writer migration.

### Validation

The report must identify copied, skipped, rebuilt, unsupported, and failed records. A migration that completes with skipped canonical state is a failure, not a warning.

## Phase 12 execution: Doctor and backup

### Backend-neutral commands

Doctor and backup commands should resolve the selected backend through the storage runtime. Backend-specific checks remain inside backend adapters.

### SQLite checks

Retain WAL-aware snapshot, integrity, schema, quarantine, and file-permission checks.

### Azure SQL checks

Add:

- authentication and permission validation;
- server/database identity;
- migration version and drift;
- transaction/readback probe;
- connection-pool health;
- required index/constraint checks;
- search capability status;
- local artifact-reference checks.

### Operator output

Every degraded result must say what to try next. Distinguish unavailable Azure SQL from corrupt local artifacts and from a schema that needs migration. Never report a database as healthy merely because a connection opened.

### Tests

Test healthy, unavailable, unauthorized, schema-drifted, migration-locked, partially migrated, and local-artifact-mismatch states. Verify Doctor never mutates persistent state unless the command explicitly requests a repair operation.

## Phase 13 execution: native clients and tooling

### Native boundary

Replace direct native SQLite access with a backend-independent API where native code needs shared state. Define the API’s authentication, authorization, offline, and cache behavior before implementation.

The preferred path is a narrow Gateway-owned API or a Gateway-maintained local cache. Do not put broad Azure SQL credentials into native applications.

### CLI/tooling

Audit every path assumption and replace it with backend-aware storage discovery:

```bash
rg -n "openclaw\.sqlite|openclaw-agent\.sqlite|node:sqlite|\.sqlite" src apps extensions packages
```

Update setup, status, Doctor, backup, reset, session inspection, database preflight, test fixtures, and migration commands. A local SQLite path may still be shown in SQLite mode, but Azure mode should show backend identity and migration status instead.

### Tests

Run real parser tests for setup options, backend selection round trips, non-interactive setup, status output, Doctor findings, and migration command validation. Native tests must cover backend capability negotiation and unavailable Gateway behavior.

## Phase 14 execution: performance and caching

### Baseline first

Measure SQLite before introducing Azure SQL optimizations:

- operations per user action;
- round trips;
- transaction duration;
- rows and bytes returned;
- query frequency;
- projection/rebuild cost;
- cacheable versus authoritative reads.

### Azure measurements

Measure:

- connection-pool wait;
- request latency percentiles;
- transaction latency;
- deadlocks and lock waits;
- transient retries;
- query-plan regressions;
- database CPU/DTU/vCore use;
- network egress and payload size.

### Cache rules

- No cache for claims, leases, approvals, ownership, pending inputs, or final lifecycle decisions.
- Transaction-local cache for repeated reads in one operation.
- Bounded process-local cache for immutable or explicitly versioned metadata.
- Update/invalidate only after commit.
- Distributed invalidation is optional and advisory; a missed event must affect freshness, not correctness.

### Load tests

Use representative concurrent workers and session traffic. Test cold and warm pools, cache cold/warm, Azure SQL transient errors, and migration/rebuild contention. Set acceptance thresholds before optimization and record any backend-specific tradeoff.

## Phase 15 execution: production hardening

### Security

Verify:

- managed identity or approved secret reference;
- least-privilege database roles;
- encrypted transport;
- no credentials in config backups or logs;
- redacted query diagnostics;
- tenant/agent predicates on every agent-scoped query;
- artifact path containment and local permissions;
- migration reports contain no secrets.

### Failure drills

Run controlled tests for:

- Azure SQL outage during read;
- outage during transaction;
- ambiguous commit response;
- deadlock;
- expired credential;
- migration lock holder crash;
- Gateway restart during migration;
- stale worker claim;
- local artifact write failure;
- unavailable search capability;
- backend switch before migration verification.

Every drill must have an observed operator outcome, recovery action, and cleanup check.

### Rollout

Use staged enablement:

1. Internal Azure SQL smoke environment.
2. Contract and migration test environments.
3. Maintainer-controlled real deployment.
4. Opt-in operator preview.
5. Stable setup path after rollback and recovery proof.

SQLite remains the safe default throughout rollout. Do not make Azure SQL the default until there is explicit product approval and real operational evidence.

### Release gate

Before each release that changes either backend:

- Both backend contract suites pass.
- Exact migration tests pass.
- Azure live proof is green for the changed path.
- Offline migration proof is green when migration code changed.
- Setup, Doctor, backup, and status paths are checked.
- Performance and connection-pool regressions are reviewed.
- Security review covers credentials, tenancy, and artifact metadata.
- Rollback procedure is documented and exercised.

## Execution tracking and evidence

Every phase should produce a short evidence record containing:

```text
phase and change set
owner boundary
files changed
logical contract affected
SQLite proof
Azure SQL proof
migration proof
concurrency/failure proof
operator-visible proof
known gaps
rollback or recovery action
```

A phase is not complete because its code compiles. It is complete when its contract, migration behavior, failure behavior, tests, and operator outcome are demonstrated for the affected surface.

# Approved Phase 0 decisions

The project owner approved the following decisions for implementation planning:

```text
Backend:
  SQLite remains the default and supported local backend.
  Azure SQL is an opt-in backend selected during setup/configuration.

Azure topology:
  Use one Azure SQL database per OpenClaw deployment/environment.
  Keep global and agent-owned data as separate logical schemas.
  Include explicit agent ownership keys for agent-scoped rows.

Authentication:
  Use Microsoft Entra/managed identity as the production-first model.
  Support SecretRef-backed credentials for non-Azure hosts.
  Never store raw Azure SQL passwords in OpenClaw configuration.

Abstraction:
  Use async, backend-neutral domain repositories.
  Do not implement a fake node:sqlite compatibility layer.
  SQLite and Azure SQL both implement the same logical contracts.

Schema:
  Use backend-native physical schemas implementing the logical contract.
  Preserve epoch-millisecond timestamps as bigint initially.
  Keep JSON only where the logical record is intentionally JSON-canonical.

Search:
  Implement Azure SQL full-text search first.
  Treat vector search as a capability requiring live proof.
  Never silently return empty results when an advertised capability is unavailable.

Migration:
  Provide explicit stopped-writer offline migration.
  Support dry-run, execute, validation, and explicit backend activation.
  Do not use indefinite dual-write.

Outage behavior:
  Azure SQL is authoritative when Azure SQL mode is selected.
  Use bounded retries for transient failures, then return a visible failure.
  Never fall back to a stale SQLite database.

Testing:
  Keep a fast SQLite contract-test lane.
  Add an isolated live Azure SQL contract-test lane.
  Never use an operator's production database for tests.
```

## Approved execution authority and working agreement

The storage abstraction document is now the project notebook for this work. Maintain it as implementation proceeds and record:

- decisions and their rationale;
- design changes and rejected alternatives;
- phase status and completion evidence;
- source paths and owner boundaries;
- migrations and compatibility notes;
- test commands and results;
- sanitized Azure SQL proof and known gaps;
- implementation follow-ups and rollback notes.

Notebook entries must distinguish **approved**, **implemented**, **observed**, **blocked**, and **proposed** facts. Never present an unverified Azure SQL behavior, driver contract, timing claim, or migration result as completed proof.

Supporting documents may be created at the repository root using this naming pattern:

```text
storageabstraction_<topic>.md
```

Use supporting files only when the detail would make this notebook unwieldy. Link each supporting file from this document and keep this file as the authoritative index.

The implementation may proceed autonomously through discovery, design refinement, coding, local tests, and documentation updates. This work is **code-and-local-tests only**: do not provision Azure resources, connect to a real Azure SQL service, modify an operator's deployment, perform a production migration, activate a backend, or roll anything out. Azure-specific integration proof must use local test doubles, contract fixtures, or a clearly isolated local harness; it must not be presented as live Azure proof. Explicit approval remains required for any newly discovered material persistence/configuration/security decision, dependency change, paid or production Azure resource use, destructive migration, or production backend activation. When such a gate is reached, record the blocker and proposed options in this notebook rather than silently choosing.

## Execution status

**Status:** Phase 0 decisions are approved. The project-registry vertical slice is implemented for local review, with SQLite remaining the default backend.

Implemented surfaces:

- `src/storage/project-registry-store.ts` defines the backend-neutral project contract.
- `src/storage/sqlite/project-registry-store.ts` preserves the existing SQLite behavior.
- `src/storage/azure-sql/runtime.ts` owns pooled Azure SQL queries and transactions.
- `src/storage/azure-sql/migrations.ts` owns locked, checksummed Azure SQL migrations.
- `src/storage/azure-sql/project-registry-store.ts` implements project rows and checkout leases.
- `src/storage/project-registry-store-factory.ts` selects and retains the process-stable backend owner.
- `src/storage/migrations/project-registry.ts` provides the stopped-writer first-slice copy contract.

The Azure SQL schema uses explicit binary collation and fixed-size hashes for long path and URL lookup keys. Lease expiry is computed by Azure SQL; process-local lease deadlines are conservative and cannot outlive the database lease. Secret-backed authentication is resolved at the runtime boundary, and SQL passwords must be configured through `SecretRef`.

Local tests cover configuration validation, credential resolution, pool and transaction behavior, migration locking and drift, SQLite compatibility, Azure project operations, checkout leases, first-slice migration conflicts, Gateway project flows, worktree authorization, setup preservation, and shutdown cleanup.

## Dependency preflight

The selected stack is:

- `mssql` for application-facing pools, requests, transactions, timeout, and cancellation.
- Tedious as the Azure SQL transport used by `mssql`.
- `@azure/identity` for Entra token credentials.

The implementation keeps driver types inside the Azure SQL backend. No Azure resource provisioning, production migration, backend activation, or rollout is authorized by this design record. Live integration proof must use an explicitly isolated test resource and be recorded in sanitized form.

## Current boundaries

This remains a first vertical slice:

- Only the project registry and its checkout lease are implemented for Azure SQL.
- Sessions, transcripts, memory, cron, audit, task, delivery, and other stores remain with their existing SQLite owners.
- Backend-aware Doctor, backup, status, and the complete offline migration command remain pending.
- Backend selection must not imply that stores outside the migrated slice have moved.
- SQLite remains the supported default and regression reference.

The next implementation step is to complete review and local validation of this slice, then choose the next bounded store according to the phase order above. Each later store must retain its current transaction, authority, retention, recovery, and operator-visible failure contracts.

## Sanitized live Azure SQL proof

**Status:** observed against an operator-approved isolated test database.

The current Azure SQL runtime and project-registry adapter completed this real backend flow:

1. Open an encrypted SQL-authenticated connection from the Linux runtime.
2. Run the health query.
3. Verify project migrations v1 and v2 are applied.
4. Acquire the backend-owned checkout lease.
5. Insert a synthetic project through the repository contract.
6. Read it by ID and through the ordered list operation.
7. Remove it through the repository contract.
8. Verify both the synthetic project and checkout lease are absent.
9. Close the connection pool.

Every step passed. The synthetic identifiers and records were removed. The connection target, username, and password were read only by the test process and were not written to configuration, logs, or this document. This proves the Azure SQL project-registry vertical slice; it does not extend Azure SQL coverage to stores listed under [Current boundaries](#current-boundaries).
