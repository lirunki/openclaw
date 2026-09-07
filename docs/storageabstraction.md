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

The abstraction is a compatibility boundary, not a fake implementation of `node:sqlite`. Azure SQL is asynchronous and networked; it must not pretend to provide synchronous `DatabaseSync` or `StatementSync` semantics.

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

## Current-main validation evidence

This section records the focused validation run executed on the current-main port (uncommitted on top of `origin/main` SHA `61d957a9cb64bd8c70cc125e644778b3fb034c49`). It does not supersede the per-phase evidence above; it summarizes the consolidated current-main proof for the ported first slice and its supporting wiring.

**Focused test totals across 22 files (263 total):**

```text
storage        21
config          4
project        24
migration       4
configure      70
Gateway projects 30
session create 23
protocol       21
server-close   66
------------------
total         263
```

**Native check-changed:** all 32 lanes passed.

**Static checks:** typecheck, lint, deadcode, import-cycle, and build all passed on the current-main port.

**Config baseline (current main):**

```text
core    = 2435
channel = 3710
plugin  = 4052
```

**Remaining boundary:** the only outstanding live boundary is the Azure SQL project registry live proof; all other stores remain SQLite-only on current main. No Azure provisioning, production migration, or rollout has been performed for the current-main port.

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
- live Azure SQL proof and known gaps;
- implementation follow-ups and rollback notes.

Notebook entries must distinguish **approved**, **implemented**, **observed**, **blocked**, and **proposed** facts. Never present an unverified Azure SQL behavior, driver contract, timing claim, or migration result as completed proof.

Supporting documents may be created at the repository root using this naming pattern:

```text
storageabstraction_<topic>.md
```

Use supporting files only when the detail would make this notebook unwieldy. Link each supporting file from this document and keep this file as the authoritative index.

The implementation may proceed autonomously through discovery, design refinement, coding, local tests, and documentation updates. This work is **code-and-local-tests only**: do not provision Azure resources, connect to a real Azure SQL service, modify an operator's deployment, perform a production migration, activate a backend, or roll anything out. Azure-specific integration proof must use local test doubles, contract fixtures, or a clearly isolated local harness; it must not be presented as live Azure proof. Explicit approval remains required for any newly discovered material persistence/configuration/security decision, dependency change, paid or production Azure resource use, destructive migration, or production backend activation. When such a gate is reached, record the blocker and proposed options in this notebook rather than silently choosing.

## Execution status

**Status:** Phase 0 decisions approved; dependency preflight complete; implementation is starting with the first vertical slice.

**Next action:** implement the backend-neutral project registry contract and preserve the SQLite path behind it before adding the Azure SQL runtime dependency. Scope is limited to code and local tests; no Azure resource provisioning or rollout is authorized.

## Preflight evidence: Azure SQL dependency and first slice

**Status:** observed/recommended; no live Azure proof.

The repository currently has `kysely` and `sqlite-vec`, but no root `mssql` or `tedious` dependency. `@azure/identity` exists in an extension dependency surface, but it is not yet a core storage dependency. The candidate published packages and upstream source were inspected by the implementation session:

- `mssql` provides the application-facing pool, request, transaction, timeout, and cancellation APIs.
- Tedious provides the Azure SQL connection layer and token-credential authentication contract.
- `@azure/identity` provides the Entra credential contract, including local developer credentials and managed identity.

The recommended stack is `mssql` over Tedious with `@azure/identity`, subject to a local integration/type smoke test for token-credential forwarding before dependency landing. No authenticated Azure SQL connection, live transaction, or token-refresh test has been run or is authorized in this code-only task.

The first vertical slice is the **project registry** because it has a bounded table and clear owner, but still exercises duplicate detection, transactions, project identity, and the existing shared-state lifecycle lease. The current owner is `src/projects/project-registry.ts`. The initial adapter work must preserve SQLite behavior and keep project checkout lifecycle semantics unchanged.

### Implementation progress: project registry contract

**Status:** implemented locally, validation pending.

Added:

- `src/storage/project-registry-store.ts` — backend-neutral stored-record, lease, mutation-result, and repository contracts.
- `src/storage/sqlite/project-registry-store.ts` — SQLite adapter owning project-table DDL, Kysely queries, duplicate detection, ID allocation, checkout-reference removal, and transactional lease assertions.
- `src/projects/project-registry.ts` — project service now consumes the SQLite repository adapter instead of importing SQLite/Kysely directly.

The service read/removal APIs are now asynchronous so the eventual Azure SQL implementation can use network I/O without a synchronous compatibility shim. Production callers and project tests were updated to await those operations. The project checkout lifecycle lease remains the authority boundary; the SQLite adapter invokes its transaction assertion before project mutations.

The full Azure SQL backend is not yet complete. The repository dependency install/test harness was initially incomplete (`tsx/esm` was unavailable), but the workspace dependencies were subsequently installed locally. No Azure resource or live service was accessed.

### Implementation progress: Azure SQL runtime foundation

**Status:** implemented locally, live proof intentionally not run.

Added:

- `src/storage/azure-sql/runtime.ts` — Linux-neutral async pool, query, transaction, shutdown, token-credential configuration, and redacted failure classification.
- `src/storage/azure-sql/runtime.test.ts` — local fake-pool tests for encrypted token configuration, connection reuse, commit, rollback, authentication classification, and secret redaction.
- Root dependencies `mssql`, `@azure/identity`, and `@types/mssql` at the preflighted versions.

The runtime uses constructor-injected pool creation so all local tests avoid network access. The production factory uses the `mssql` Tedious adapter and `DefaultAzureCredential`; no credential endpoint or Azure SQL server was contacted. The runtime tests cover pool reuse, health probing, commit, rollback, authentication classification, cancellation/error handling, and secret redaction; 5 tests currently pass.

### Implementation progress: Azure SQL project adapter and backend config shape

**Status:** adapter and validation contracts implemented locally; runtime selection is explicit and migration ownership is implemented, while setup propagation remains pending.

Added:

- `src/storage/azure-sql/project-registry-store.ts` — Azure SQL project repository using parameterized queries, transactional duplicate detection, `UPDLOCK/HOLDLOCK` reads for insert/delete races, `OUTPUT INSERTED` identity return, and explicit logical table/index DDL.
- `src/storage/azure-sql/project-registry-store.test.ts` — local fake-database contract tests for schema initialization, duplicate registration, transactional removal, and lease callbacks.
- `src/config/zod-schema.storage.ts` — approved `sqlite`/`azuresql` selection shape with required Azure endpoint settings.
- `src/config/types.openclaw.ts` and `src/config/zod-schema.root-shape.ts` — typed/root schema exposure for the storage configuration.
- `src/config/zod-schema.storage.test.ts` — local config validation tests.
- `src/storage/storage-backend.ts` — backend kind resolution with SQLite as the default and explicit Azure configuration validation.

Added:

- `src/storage/project-registry-store-factory.ts` — explicit SQLite/Azure SQL repository selection, SQLite-default behavior, process-stable Azure database pooling, and controlled pool shutdown.

Project registry callers now resolve through the backend factory. Existing calls without `storage.backend` continue to select SQLite. Azure selection requires explicit endpoint configuration; a configured unresolved SecretRef is rejected rather than ignored. Current setup/runtime callers do not yet pass Azure configuration, so no existing user path can accidentally switch backends. Credential-reference resolution is provided through an injected runtime SecretRef resolver; a configured credential without that resolver fails closed. Project checkout lease ownership now belongs to the selected project-store adapter, so an eventual Azure-enabled path will not cast an Azure transaction into the SQLite lease implementation. The first versioned migration owner is now present:

- `src/storage/azure-sql/migrations.ts` — transaction-scoped `sp_getapplock` migration lock, migration table bootstrap, ordered migration application, SHA-256 drift detection, and idempotent retry.

`AzureSqlProjectRegistryStore` now initializes its table through migration `global.projects.v1` rather than unversioned first-use DDL. The migration also owns the Azure project checkout-lease table. SQLite and Azure adapters both implement `withCheckoutLease`, preserving the lease owner boundary without making the Azure path depend on SQLite transactions. `src/storage/azure-sql/credentials.ts` adapts injected SecretRef resolution to the Azure token-credential contract, with local refresh and empty-token tests. Local migration and project-adapter tests pass: 4 tests passed together. No Azure service was contacted.

The focused SQLite project-registry suite passes after the factory integration: 24 tests passed. The Azure adapter suite passes locally: 2 tests passed. The runtime/config suite passes locally: 6 runtime tests and 3 config tests passed. On the current-main port these earlier local-install gaps are closed: the gateway project sibling suite and the full configure-wizard suite now run on a complete current-main install with no missing markdown dependencies and no wizard timeout, so the prior validation gap no longer applies. No Azure resource or live service was accessed for the current-main validation.

**Platform requirement:** the Azure SQL implementation must be supported on Linux as a first-class target, not only Windows. The adapter must avoid Windows-only path, process, credential, TLS, or filesystem assumptions. Local tests should run on Linux and cover platform-neutral behavior; any platform-specific driver behavior must be isolated and documented.

## Current implementation status

**Current-main port:** the storage abstraction first slice and its supporting setup/config, SecretRef, migration, and lifecycle cleanup wiring are ported to current `origin/main` (SHA `61d957a9cb64bd8c70cc125e644778b3fb034c49`) and validated there. The port is implemented and validated but currently uncommitted on top of that SHA.

- **Project registry:** implemented and validated on current main.
- **Azure SQL runtime:** locally tested and previously live-proven through the recorded isolated Azure SQL POC against `claw1`.
- **Azure SQL project adapter:** first vertical slice implemented and validated; setup/config, SecretRef resolution, migration, and lifecycle cleanup are wired. Azure SQL adapters for the remaining operational stores remain pending.

**Completed locally:**

- Backend-neutral project registry contract.
- SQLite project adapter with preserved lifecycle semantics.
- Azure SQL runtime foundation using `mssql`/Tedious and Entra credentials.
- Linux-neutral pool/query/transaction/health/error handling.
- Azure SQL project repository with parameterized SQL and transactional lease ownership.
- Azure SQL migration runner with migration locking and checksum drift detection.
- Explicit SQLite/Azure project-store factory.
- SecretRef-to-token-credential injection boundary.
- Storage config schema and interactive configure wizard section.
- First-slice project registry dry-run/execute migration helper.
- Local unit/contract tests for all of the above.

**Still in progress:**

- Propagating backend selection to every storage owner.
- General offline migration command and complete global/agent copy order.
- Backend-aware Doctor, backup, status, and outage reporting.
- Azure SQL adapters for remaining operational stores.
- Session/transcript and memory/search backend contracts.
- Full local contract/concurrency/performance/security sweep.

No Azure provisioning, production migration, or rollout has been performed.

### Azure SQL live connectivity attempt

**Status:** network verified; interactive user authentication blocked by tenant Conditional Access.

For `luistest1.database.windows.net:1433`, database `claw1`:

- DNS resolved to the Azure SQL Australia East gateway.
- TCP port 1433 was reachable from WSL/Linux.
- A direct TDS login probe reached Azure SQL and returned `ELOGIN` with the server policy that Entra-only authentication is enabled.
- Device-code authentication reached Microsoft sign-in, but the tenant refused token issuance because the requesting WSL/Linux device context was not recognized as a Microsoft-managed/compliant device.

This is not an Azure SQL network or driver failure. It is a Conditional Access device-compliance gate on interactive user authentication. The Linux production path should use workload identity or managed identity. A local Linux end-to-end test requires either an approved workload identity/service principal, a short-lived token obtained through an approved managed-device broker flow, or an explicitly temporary SQL principal.

A temporary contained SQL principal was subsequently used from the local Linux runtime without persisting or logging its password. Direct `mssql` authentication and `SELECT 1` succeeded, proving Linux-to-Azure SQL authentication and query execution. After the experiment principal received the approved temporary DDL/schema permissions, the real `AzureSqlDatabase` plus `AzureSqlProjectRegistryStore` successfully applied migration `global.projects.v1` in `claw1`.

A standalone OpenClaw storage POC then exercised the real Azure SQL adapter end to end against `claw1`: health check, migration verification, backend checkout lease, project insert, point read, list visibility, delete, and post-delete cleanup verification all passed. The synthetic POC row was deleted before the connection closed. Observed result:

```json
{
  "status": "passed",
  "backend": "azuresql",
  "database": "claw1",
  "created": true,
  "read": true,
  "listed": true,
  "removed": true,
  "cleanupVerified": true
}
```

The password was read from the operator-owned local credential file for the process only and was not copied into OpenClaw configuration, logs, or notebook evidence.

### Interactive hybrid Gateway POC

**Status:** running locally.

An isolated Gateway is running on `ws://127.0.0.1:28792` with explicit Azure SQL storage configuration. The password is resolved through an OpenClaw file SecretRef copied into the isolated state credential directory with mode `0600`; it is not stored inline in `openclaw.json`. The Gateway reached ready state, and a real `projects.list` Gateway RPC succeeded after querying the Azure SQL project repository.

A separate OpenClaw TUI window is connected to the Gateway for interactive questions. The first turn exposed an isolated-build packaging defect: `docs/reference/templates/AGENTS.md` had been omitted from the copied build inputs, so workspace bootstrap failed visibly with `Missing workspace template`. The canonical packaged template directory was copied into the isolated runtime; failed template loads are not retained in the runtime cache, so a newly opened TUI can retry without restarting the Gateway.

This remains a **hybrid first-slice POC**:

- Azure SQL owns the project registry and its checkout-lease/migration tables.
- Chat sessions, transcripts, memory, cron, audit, and other stores still use the isolated local SQLite databases.
- The TUI therefore proves normal Gateway/agent interaction alongside the Azure-backed project slice; it does not prove that chat content is persisted in Azure SQL yet.

### Operator-selected model configuration

**Status:** running; interactive turn confirmation pending operator input.

The isolated Gateway and TUI were stopped, then restarted after applying the operator-provided endpoint, API key, and model from a local credential file. The source credential file was parsed without printing values. The API key was copied into the isolated state credential directory with mode `0600` and referenced through an OpenClaw file SecretRef; it was not written inline to `openclaw.json`. The endpoint uses HTTPS. Redacted config inspection confirms the selected primary provider is the configured POC provider without publishing the endpoint or model identifier.

The hybrid Gateway is ready again on port `28792`. The operator requested a headless end-to-end proof rather than a TUI flow, so the interactive client was stopped and the proof was run through the one-shot Gateway agent command.

The first provider request exposed that the supplied endpoint was a service root rather than a `/v1` base. A redacted direct protocol probe proved the compatible shape: bearer authentication, `/v1/chat/completions`, and `max_completion_tokens`. The isolated configuration was corrected without publishing the endpoint or model identifier.

The final end-to-end turn passed:

- CLI submitted a synthetic message to the live Gateway.
- Gateway admitted the turn and invoked the configured provider/model.
- The provider returned the exact expected synthetic response.
- CLI exited `0` with status `ok` and no error.
- The Azure-backed `projects.list` RPC still succeeded after the turn.
- Local agent SQLite contains one matching session row and ten transcript events, confirming the documented hybrid persistence boundary.

As before, chat/session persistence remains SQLite while the project registry remains Azure SQL. API keys and database passwords were resolved from isolated mode-`0600` credential files and were not written inline or included in proof output.

The operator independently completed the Gateway-level Azure SQL persistence check: created a temporary committed Git checkout, registered it through `projects.register`, observed it through `projects.list`, confirmed the row in `openclaw_global.projects`, and reported success. The provided cleanup path removes the registry row through `projects.remove` and deletes the temporary checkout.

## Live SQLite smoke evidence

**Status:** observed locally.

The current source was copied into an isolated WSL Linux filesystem checkout, built there, and started in a separate Windows Terminal window with:

```text
storage.backend = sqlite
gateway.mode = local
bind = loopback
port = 28791
state directory = ~/.cache/openclaw-storage-live-state
```

The operator's normal Gateway and state directory were not touched. Observed evidence:

- Gateway bound `127.0.0.1:28791` and `[::1]:28791`.
- Gateway startup reached `[gateway] ready`.
- `GET http://127.0.0.1:28791/health` returned `{"ok":true,"status":"live"}`.
- `openclaw config get storage.backend` returned `sqlite`.
- The isolated state database exists at `state/openclaw.sqlite` under the isolated state directory.
- Direct read-only metadata inspection returned `{"role":"global","schema_version":15}`.

The successful launch required an isolated Linux-filesystem build because fs-safe build locking cannot publish correctly on this checkout's WSL-mounted Windows filesystem. It also required a complete workspace install and a runtime-oriented build sequence to stay within local memory limits. Control UI asset generation failed during startup, but the Gateway HTTP server and storage backend reached ready state; this does not affect the SQLite persistence proof.

`src/storage/project-registry-store-factory.test.ts` now proves SQLite-default selection, explicit Azure selection without connecting, and fail-closed unresolved credentials. The selected backend is propagated through the project-registry options used by the project Gateway methods when an explicit `storage` configuration is present. SQLite remains the default when it is omitted. Broader setup/runtime propagation remains a controlled next step because other stores still use their current SQLite owners.

### Setup-time selection implementation

Added the `storage` configure section to the interactive configuration surface:

- `src/commands/configure.shared.ts` exposes `storage` as a selectable section.
- `src/commands/configure.wizard.ts` prompts for SQLite or Azure SQL and, for Azure SQL, the server and database endpoint.
- The wizard writes the backend selection through the existing config transaction; it does not collect raw passwords.
- `src/commands/configure.commands.test.ts` passes with the expanded section list.

The wizard does not contact Azure SQL in this local-only implementation. Connection/permission probing remains a runtime/Doctor operation and must be explicitly invoked by the operator.

### Offline migration implementation: first slice

Added `src/storage/migrations/project-registry.ts`, which provides a stopped-writer-gated dry-run/execute migration for the canonical project registry contract. It preserves stable project IDs, skips already existing canonical roots, acquires the target backend's checkout lease before writes, and leaves the source untouched. Local migration tests cover dry-run/no-write behavior, existing rows, source-stop gating, stable IDs, and target writes: 2 tests passed.
