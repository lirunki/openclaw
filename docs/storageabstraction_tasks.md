# Storage Abstraction: Task Registry Vertical

## Purpose

This is the living implementation and evidence notebook for moving OpenClaw's task registry from SQLite-only persistence to the approved SQLite/Azure SQL storage abstraction.

The authoritative project-wide decisions remain in the [storage abstraction notebook](/storageabstraction). This notebook owns the task-specific inventory, design refinements, implementation status, proof, and unresolved gates. Maintain both documents when this vertical changes a project-wide boundary.

Facts in this notebook are labeled as follows:

- **Approved:** authorized by the project-wide storage design.
- **Implemented:** present in the current branch source.
- **Observed:** verified from source inspection or a recorded proof run.
- **Proposed:** recommended but not yet approved or implemented.
- **Blocked:** cannot proceed without a design decision, approval, or prerequisite.

## Current status

**Status as of 2026-09-11:** Increments 1 and 2 are implemented for local review with SQLite still authoritative. The canonical asynchronous contract, self-validating operation IDs, no-table ambiguity reconciliation, SQLite cohort adapter, task mailbox protocol, compatibility facade, primary task/subagent/maintenance/history routing, and cron/task recovery cohort are present. Azure SQL is not activated for tasks.

**Observed:** Task CRUD, execution binding, completion admission/settlement/blocking, conditional subagent/task/flow replacement, and cron run recovery now execute as named cohort operations. Cron recovery compares the exact cron job, active receipt, and selected task evidence before atomically writing the job and receipt; the production cron service no longer imports task-registry SQLite helpers.

**Next increment:** define the complete Azure activation set for every companion row already represented by the cohort, then implement the Azure SQL schema, adapter, routing, and migration. Cron job and receipt rows used by recovery must become authoritative in the same selected backend transaction; moving tasks to Azure while ordinary cron persistence remains authoritative only in SQLite is not valid.

## Approved boundaries

The following project decisions apply unchanged:

- SQLite remains the default and supported local backend.
- Azure SQL is opt-in and authoritative only for stores explicitly migrated to it.
- Storage contracts are asynchronous, backend-neutral domain contracts.
- Do not expose `DatabaseSync`, SQLite statements, SQL text, Kysely backend types, or Azure driver types through the contract.
- Do not add a fake `node:sqlite` layer.
- Do not use hidden fallback, indefinite dual-write, or a shadow authoritative copy.
- Azure outages produce bounded retries and visible failures; they do not fall back to stale SQLite state.
- Backend selection is fixed at process startup.
- SQLite-to-Azure migration is an explicit stopped-writer operation with dry-run, execute, validation, and activation phases.
- Local workspaces and named file artifacts remain local.
- New configuration, material persistence semantics, or a durable saga/outbox redesign requires explicit approval.

## Current ownership and schema

### Canonical rows

**Implemented:** The task registry owns two tightly coupled tables in the global control-plane SQLite database:

- `task_runs`
- `task_delivery_state`

`task_delivery_state.task_id` references `task_runs.task_id` with `ON DELETE CASCADE`. Task creation and deletion preserve the task and its delivery state in one transaction.

The task record contains:

- task, runtime, source, and run identities;
- requester, owner, scope, child-session, agent, parent-task, and parent-flow identities;
- task, delivery, notification, and terminal states;
- creation, start, completion, activity, and cleanup timestamps in epoch milliseconds;
- tool activity counters;
- error, progress, terminal summary, terminal outcome, and bounded JSON detail.

The SQLite schema indexes run identity, status, runtime/status, cleanup time, activity time, owner, parent flow, child session, and cron runtime/source history.

Primary source owners:

- `src/tasks/task-registry.types.ts`
- `src/tasks/task-registry.store.ts`
- `src/tasks/task-registry.store.sqlite.ts`
- `src/tasks/task-registry-state.ts`
- `src/state/openclaw-state-schema.sql`

### Process mirror

**Observed:** Runtime reads are primarily served from process-local maps restored from a durable snapshot. Indexes cover run IDs, owner keys, parent flows, and related session keys.

Consequences for an asynchronous backend:

- persistence must complete before memory is published;
- failed writes must leave memory unchanged;
- the repository should return the canonical committed row;
- awaited writes introduce interleaving that synchronous SQLite callers do not currently encounter;
- external database mutations are not automatically visible to a running Gateway;
- a shared Azure database does not by itself authorize multiple active Gateways.

The current approved deployment scope remains one active Gateway. Any multi-Gateway task ownership or cache-coherence design is outside this vertical unless separately approved.

## Invariants to preserve

### Persistence and publication

**Implemented:** Task mutations durably persist before changing the in-memory registry or notifying observers. Persistence failures leave the process mirror at the last durable state.

**Required:** The Azure implementation must preserve this order. It must not acknowledge a mutation before commit or publish speculative state that later rolls back.

### Restore behavior

**Implemented:** Restore failures fail closed and remain sticky until an explicit reload succeeds. The runtime does not silently reinterpret a failed restore as an empty registry.

**Required:** Azure startup, health, schema, decode, and restore failures must produce the same visible failure boundary.

### Conditional lifecycle mutation

**Observed:** Task lifecycle projection protects terminal precedence, cancellation, provisional subagent outcomes, exact run scope, and late-event handling in domain code.

**Proposed:** The backend contract must also protect awaited writes from stale overwrite. Mutations should carry expected prior state or an equivalent durable generation and use affected-row counts to classify success or conflict. Blind `MERGE` or unconditional upsert is not sufficient.

At minimum, the contract needs domain operations equivalent to:

- insert a task if its identity is absent;
- update only the expected current task state;
- write task and delivery state atomically;
- terminalize only while the current lifecycle permits it;
- bind execution identity only while the task remains eligible;
- delete only the expected retained row;
- return the canonical committed record.

Exact method names remain an implementation decision. The contract should not become a generic transaction or SQL escape hatch.

### Delivery state

**Implemented:** `task_delivery_state` is a hard companion to `task_runs`, not an optional later store. Creation, notification progress, and deletion must not leave orphan or contradictory delivery state.

**Required:** Both rows move under the same selected backend and transaction owner.

### Retention and maintenance

**Implemented:**

- ordinary terminal tasks default to seven-day retention;
- lost tasks are bounded to 24-hour retention;
- cron history additionally keeps the newest 2,000 terminal rows per store and source;
- maintenance uses runtime-specific liveness authorities for ACP, CLI, cron, and subagent tasks;
- offline maintenance does not claim live-process authority it does not possess;
- deletion also removes task-owned execution lifecycle metadata.

**Required:** Azure cleanup must preserve ordering, grouping, batch bounds, authority checks, and related-row deletion. It must not replace conditional maintenance with unconditional expiry deletion.

## Direct SQLite dependencies to remove

The injectable `TaskRegistryStore` is not yet the complete ownership boundary. The following direct SQLite paths must be abstracted or deliberately incorporated into a larger backend transaction owner before Azure activation.

### Cron history and execution binding

**Observed:** Cron history reads task rows directly from SQLite, and cron admission binds task execution identity through SQLite-specific helpers.

Relevant paths:

- `src/cron/task-run-history.ts`
- `src/cron/service/task-runs.ts`
- `src/tasks/task-registry.store.sqlite.ts`

### Maintenance and administrative reads

**Observed:** Task maintenance directly queries SQLite by runtime/source for bounded cron retention and recovery checks.

Relevant paths:

- `src/tasks/task-registry.maintenance.ts`
- `src/tasks/task-registry.store.sqlite.ts`

### ACP and Gateway admission paths

**Observed:** ACP and Gateway execution paths call SQLite-owned task execution binding or composite persistence helpers.

Relevant paths:

- `src/acp/control-plane/manager.background-task.ts`
- `src/gateway/agent-turn/agent-run-dispatch.ts`

### Audit lifecycle receipts

**Observed:** Execution receipt readers join `task_runs` with `execution_owner_lifecycle_bindings` in the same SQLite database. Moving only task rows would make task-stage audit receipts incomplete and prevent the binding transaction from revalidating the authoritative task row.

Relevant paths:

- `src/audit/execution-owner-lifecycle-binding-store.ts`
- `src/audit/execution-owner-lifecycle-receipts.ts`
- `src/tasks/task-registry.store.sqlite.ts`

## Cross-store transaction neighborhood

The following couplings are narrower than ordinary task CRUD but block an isolated backend switch because they protect crash consistency or owner fencing.

### Subagent completion admission

**Implemented:** Completion admission can atomically commit:

- a session delivery queue entry;
- the subagent registry row;
- the task row.

Relevant owner:

- `src/agents/subagents/completion/subagent-completion-admission.store.ts`

**Required:** Azure activation must not split this into unrelated SQLite and Azure commits. A crash must not leave delivery admitted without its task projection or a task claiming queued delivery without the queue item.

### Subagent replacement

**Implemented:** Restart recovery conditionally transfers:

- the subagent owner generation;
- the canonical task;
- when applicable, the mirrored Task Flow record.

The transaction compares exact source state before committing.

Relevant owner:

- `src/agents/subagents/registry/subagent-registry-replacement-store.ts`

**Required:** Azure activation must preserve the exact-source comparison, owner fencing, and all-or-nothing publication.

### Task Flow relationship

**Observed:** Ordinary task-to-mirrored-flow synchronization is not universally atomic. The normal task path commits the task and then synchronizes its mirrored flow with bounded retry behavior. There is no general database foreign key from `task_runs.parent_flow_id` to `flow_runs`.

The subagent replacement path is the important exception: task and mirrored flow participate in one conditional transfer transaction.

Relevant paths:

- `src/tasks/task-registry-mutation.ts`
- `src/tasks/task-flow-registry.ts`
- `src/agents/subagents/registry/subagent-registry-replacement-store.ts`

## Approved Increment 1 design

### Operation-oriented transaction cohort

**Approved:** Task storage is activated as a transaction cohort rather than an independently selectable `task_runs` table. Composite storage ports own complete domain operations; callers do not receive a generic transaction, database handle, SQL escape hatch, or cross-repository unit-of-work callback.

The cohort contracts cover:

- task creation and deletion with task delivery state;
- conditional task mutation and terminalization;
- task execution binding with task-owned lifecycle metadata;
- subagent completion admission, settlement, and blocking;
- conditional subagent owner replacement with the mirrored Task Flow row when applicable;
- cleanup of task-owned related state.

Each command carries prepared domain records plus the expected current state, owner, or generation needed for transaction-time revalidation. Each result returns canonical committed records or a typed conflict. SQLite and Azure adapters keep their transaction handles private.

Ordinary task-to-flow synchronization remains post-commit and retryable. Only the existing conditional subagent replacement operation includes the mirrored flow in the transaction cohort.

### Extracted contract boundary

**Implemented:** `src/storage/task-cohort-store.ts` defines the canonical asynchronous cohort without exposing SQL, Kysely, a database handle, or a generic transaction callback.

The extracted operations cover:

- snapshot and scoped owner/runtime-source reads;
- exact compare-replacement of a task with its delivery companion;
- conditional execution-owner binding with backend-owned eligibility policy;
- subagent completion admission, settlement, and blocking;
- subagent generation replacement with exact run changes, the canonical task activation, and an explicit mirrored Task Flow pair;
- backend shutdown.

Every mutation carries an operation ID. Task writes make the absent state explicit and cannot represent an orphan delivery row. Composite commands carry expected and next records; successful results carry the canonical committed records needed for publication. Operation IDs are self-validating correlations rather than durable receipts: each ID combines a random intent nonce with a hash of the versioned, canonically serialized command. A malformed ID or a hash that does not match the command is a typed conflict. Snapshot reads use deterministically ordered arrays rather than `Map` so the contract remains JSON-safe across the temporary mailbox.

### No-table commit-ambiguity reconciliation

**Approved:** Task operations do not add an operation-receipt table or persist operation IDs in existing cohort rows. The operation ID detects changed input and correlates an immediate reconciliation attempt; it does not prove that a transaction committed.

An initial execution may mutate only when the complete backend-owned cohort matches the command's exact expected state. After a mailbox timeout or another commit-ambiguous failure, the compatibility client retains the exact command and permits only reconciliation mode. The next task-cohort access reconciles that command before any other work. The backend then rereads every affected task, delivery, execution-binding, queue, subagent, and optional flow record in one authoritative snapshot:

- if the complete cohort matches the command's exact next state, return `already-applied` with the current canonical records;
- otherwise return a typed `outcome-unknown` without writing, including when the cohort has returned to the expected state;
- never automatically replay the mutating form after commit ambiguity.

Treating an expected-state match as permission to execute again would be unsafe after an ABA transition. After reconciliation, the compatibility process remains terminally fail-closed and requires a Gateway restart to reload all task, subagent, queue, and flow mirrors together. A fresh operation can be prepared only from that reloaded state. If later mutations have advanced the cohort, the original committed result is intentionally not reconstructed. This is weaker than durable exactly-once replay but preserves fail-closed behavior without new persistent state.

Accepted restart-receipt reconciliation carries structured receipt and session-target evidence rather than a callback. While the temporary synchronous facade exists, the main-process owner must prepare that evidence only while holding the exact live acceptance; the backend independently rereads the named session before mutation. A future direct asynchronous caller must provide an equivalent authority revalidation mechanism after awaited work rather than treating the receipt as authority by itself.

The contract is extracted but not activated. Existing SQLite functions still own runtime behavior until the SQLite cohort adapter and compatibility routing are implemented and proven.

### Temporary synchronous facade

**Approved:** The canonical storage operations are asynchronous, while existing synchronous task mutation APIs temporarily invoke them through a single-flight worker mailbox.

The mailbox design is deliberately narrow:

- one lazily created worker thread;
- one `MessageChannel` and one small `SharedArrayBuffer` completion signal;
- one request and response in flight because the synchronous caller blocks the main thread;
- one closed, statically handled union of approved domain operations;
- one complete domain transaction per request;
- one long-lived Azure SQL pool owned and reused by the worker;
- bounded command and response payloads;
- sequence validation and typed error restoration;
- no cache, authoritative task state, retry queue, callbacks, generic RPC, or transaction object in the worker protocol.

The main process prepares a command, sends it to the worker, waits with a bounded `Atomics.wait`, synchronously receives the matching response with `receiveMessageOnPort`, and publishes returned records only after a successful commit. Timeout or malformed response poisons that worker generation, leaves process memory unchanged, returns a visible failure, and causes bounded worker replacement before another operation. Any follow-up for that command is reconciliation-only; worker replacement does not authorize replaying its mutation.

The mailbox transport is shared by named compatibility consumers, while operation protocols, validation, errors, and transaction semantics remain domain-owned. Plugin state is the first consumer and task lifecycle is the second. This supersedes the earlier plugin-state-only restriction without making the mailbox a default path for other synchronous stores.

Every mutation still needs a self-validating operation ID and exact postcondition reconciliation because a timeout can be commit-ambiguous. Operation IDs are not persisted and are not evidence of commit. Interactive credential output may use inherited stderr, but credentials and secret values must never enter operation payloads, response payloads, hashes, or logs. Worker initialization receives only the process-stable runtime configuration needed to resolve the selected backend.

### Compatibility lifetime

**Approved:** Synchronous mutation APIs are temporary. They must not become plugin SDK surface or gain unrelated callers. Remove the mailbox after production task mutation callers use the asynchronous domain API. Synchronous APIs may remain only for pure operations and explicitly cached reads from initialized process state.

Azure task activation requires performance evidence for worker startup, pool reuse, transaction latency, total main-thread blocked time, timeout behavior, and high-frequency task activity. Functional correctness alone is not sufficient.

## Proposed implementation sequence

### Increment 1: extract the contract with SQLite unchanged

**Approved:**

1. Implement the shared bounded single-flight mailbox transport, lifecycle, timeout, and protocol-envelope rules.
2. Port the existing plugin-state synchronous compatibility surface from one subprocess per operation to the shared worker, preserving behavior while reusing its Azure SQL pool.
3. Prove pool reuse, timeout poisoning, worker replacement, typed errors, and shutdown before adding task commands.
4. Define narrow asynchronous, operation-oriented task-cohort contracts rather than snapshot replacement or SQL primitives.
5. Implement those operations with the current SQLite owner.
6. Preserve the existing synchronous task mutation surface through the temporary compatibility client.
7. Add self-validating operation IDs, exact expected/next-state checks, and a non-mutating reconciliation mode for commit ambiguity and eventual Azure execution.
8. Route cron history, maintenance, execution binding, and administrative reads through backend-neutral contracts.
9. Remove production direct imports of task-registry SQLite helpers outside the SQLite adapter and approved composite operation adapters.
10. Keep SQLite authoritative and preserve all user-visible behavior.

**Exit gate:** SQLite contract tests and task lifecycle suites pass without Azure activation; mailbox protocol and lifecycle tests pass against a deterministic async fixture; and no production path can silently bypass the selected task-cohort owner.

### Increment 2: resolve composite transaction ownership

**Implemented for the SQLite reference backend:** the narrowly coupled task transaction neighborhood is represented by named cohort operations under one selected backend transaction boundary. This includes the portions of the following stores required by task operations:

- task rows and delivery state;
- task-owned execution lifecycle bindings and receipt reads;
- subagent completion and replacement state;
- session delivery queue admission used by subagent completion;
- mirrored Task Flow state used by conditional subagent replacement;
- the cron job, active run receipt, and selected task evidence used by run recovery.

This does not necessarily require completing every feature of the broader audit, delivery, subagent, Task Flow, or cron stores in the same change. It does require every cross-owner operation to use one authoritative backend and one atomic transaction. The Azure activation set must therefore include authoritative routing for each companion row touched by these operations; it cannot leave ordinary writes for those rows in SQLite while cohort mutations target Azure SQL.

**Blocked alternative:** redesign the composite operations as durable sagas or outboxes. This materially changes persistent-store, recovery, and projection semantics and requires explicit approval before implementation.

**Rejected:** shadow mirroring or hidden SQLite/Azure dual-write. It violates the approved canonical-store and visible-failure policy.

### Increment 3: implement and activate the Azure adapter

**Proposed:**

1. Add task-specific Azure SQL migrations, tables, indexes, and constraints.
2. Implement repository operations with Kysely-backed Azure helpers and explicit transactions.
3. Add typed conflict, unavailable, retryable, and decode failure behavior.
4. Add process-stable factory selection and trusted-runtime configuration routing.
5. Close task-owned Azure resources during Gateway shutdown.
6. Route Doctor, status, backup, and operator inspection through the selected backend.
7. Keep SQLite as the default and contract reference.

Azure activation remains blocked until the Increment 2 companion rows have Azure SQL schema coverage and all of their ordinary writers route to the same selected backend.

### Increment 4: add offline migration

**Proposed source coverage:**

- legacy task sidecar rows from `tasks/runs.sqlite`;
- current `task_runs` rows in shared `openclaw.sqlite`;
- current `task_delivery_state` rows;
- any coupled rows required by the approved Azure activation boundary.

The migration must:

- require stopped writers;
- support dry-run, execute, validation, and explicit activation;
- preserve task IDs, exact timestamps, statuses, JSON payloads, delivery state, and owner identities;
- skip or visibly report invalid and orphan rows according to the existing contract;
- reconcile identical rows idempotently;
- retain the source on unresolved conflict;
- never overwrite a newer terminal or ownership state;
- validate counts and content before activation;
- leave shared `openclaw.sqlite` intact because other stores still own rows there;
- prevent SQLite-only task readers from exposing stale rows after Azure activation.

The existing Doctor sidecar migration currently targets shared SQLite. It must become backend-aware before Azure task mode can be selected.

## Test and proof plan

### Contract tests

Both adapters must pass the same behavioral cases for:

- empty restore and ordered snapshot load;
- task creation with delivery state;
- exact-next duplicate reconciliation without durable operation receipts;
- expected-state update conflicts;
- terminal precedence and late events;
- cancellation and provisional subagent outcomes;
- run-scope and owner-scope lookup;
- task/delivery atomicity;
- conditional execution binding;
- retention, cleanup, and exact deletion;
- malformed persisted rows and restore failure;
- unavailable backend and bounded retry classification.

### Concurrency and failure injection

Required cases include:

- two updates prepared from the same prior task;
- cancellation racing terminal completion;
- delivery admission racing duplicate completion;
- stale subagent replacement generation;
- failure between related-row writes;
- commit ambiguity and connection loss, including exact-next reconciliation and fail-closed expected-state ABA handling;
- maintenance racing a fresh lifecycle update;
- observer failure after a successful durable commit;
- process restart after commit but before in-memory publication.

### Migration proof

Required cases include:

- legacy sidecar only;
- shared SQLite only;
- identical destination rows;
- conflicting or newer destination rows;
- orphan delivery rows;
- interrupted migration and retry;
- dry-run with no writes;
- validation mismatch preventing activation;
- exact preservation of timestamps, nullable fields, JSON, terminal outcomes, and tool activity.

### Live Azure proof

No live Azure task-registry proof has been run.

A future live proof requires an explicitly isolated, operator-approved database and sanitized evidence for:

1. migrations;
2. restore;
3. create/read/update;
4. task plus delivery atomicity;
5. conflict handling;
6. execution binding;
7. subagent composite transaction behavior included in scope;
8. maintenance and retention;
9. offline import and validation;
10. pool shutdown and cleanup.

Do not claim live support from mocks or driver-level unit tests.

## Acceptance criteria

The task vertical is complete only when:

- SQLite and Azure implement the same approved logical contract;
- every production task read and write routes through the selected backend owner;
- no direct SQLite task helper bypasses backend selection;
- task and delivery state remain atomic;
- subagent admission and replacement retain their crash-consistency and fencing guarantees;
- task execution identity and audit receipts remain complete;
- persistence still precedes memory publication and observer notification;
- stale asynchronous writes produce typed conflicts rather than overwrites;
- retention and maintenance preserve runtime authority rules;
- stopped-writer migration is repeatable and validated;
- Doctor, status, backup, and shutdown are backend-aware for the migrated surface;
- focused SQLite, Azure contract, migration, concurrency, and failure tests pass;
- sanitized live Azure proof covers the activated transaction boundary;
- SQLite remains the default and there is no hidden fallback or dual-write.

## Decision log

### 2026-09-10 — Investigation completed

**Observed:** `TaskRegistryStore` provides a partial adapter seam, but direct SQLite readers and composite transactions prevent an isolated `task_runs` backend switch.

**Rejected:** Treating a shadow Azure copy as the first increment. This conflicts with the approved prohibition on hidden dual-write and does not prove authoritative failure behavior.

### 2026-09-10 — Increment 1 transaction and API design approved

**Approved:** Use operation-oriented composite storage ports selected as one task-lifecycle transaction cohort. Keep backend transaction handles private and preserve ordinary post-commit Task Flow synchronization separately from conditional subagent replacement.

**Approved:** Keep existing synchronous task mutations temporarily through a single-flight worker mailbox. The worker owns the canonical asynchronous operation implementation and reusable Azure SQL pools; each request is one complete domain operation.

**Approved:** Share the mailbox transport across explicitly named compatibility surfaces while keeping operation protocols domain-owned. Port plugin state first, then add task lifecycle as the second consumer. New stores remain async by default.

**Observed:** A 100-request local probe on Node v22.23.2 for Windows successfully completed the `postMessage` → worker response → `Atomics.notify` → synchronous `receiveMessageOnPort` sequence for every request.

**Rejected:** A process per SQL or domain operation because process and pool creation are not sustainable for task lifecycle traffic.

**Rejected:** Eventual queued persistence because returning before durable commit would weaken persist-before-publish and could lose accepted mutations on process failure.

**Rejected:** A general persistent-worker RPC framework. The approved mailbox is fixed, single-flight, limited to explicitly named compatibility surfaces, and has an explicit removal condition.

### 2026-09-10 — No-table ambiguity reconciliation approved

**Approved:** Do not add an operation-receipt table and do not store operation IDs in existing task-cohort rows. Use a random intent nonce plus a canonical command hash for self-validating correlation.

**Approved:** After a commit-ambiguous failure, permit only a non-mutating reconciliation read. Return `already-applied` only when the complete cohort exactly matches the prepared next state; otherwise return `outcome-unknown`, even if current state matches the prepared expected state. Recovery reloads canonical state and creates a fresh operation.

**Accepted tradeoff:** The backend cannot recover an original result after later mutations and does not provide durable exactly-once replay. It preserves safety by refusing automatic mutation after ambiguity.

**Rejected:** Persisting a durable operation receipt, adding last-operation columns to hot task rows, or treating an expected-state match after timeout as permission to execute again.

## Evidence log

### Cron/task recovery cohort — 2026-09-11

- **Owner boundary:** one cron job row, its exact active run receipt, and the deterministically selected task recovery record.
- **Files changed:** task cohort contract/validation/operation helpers, SQLite adapter, mailbox protocol/handler/facade, cron recovery planner, cron task recovery selector, receipt read helpers, and focused tests.
- **Logical contract affected:** cron recovery now inspects a JSON-safe selected-backend snapshot, prepares the domain outcome in the main process, and atomically compare-commits the exact job/receipt/task cohort through the shared mailbox. Deferred notifications remain main-process values and are published only after an applied commit.
- **SQLite proof:** 13 adapter tests passed, including a selected-task advancement race that leaves the cron job untouched. Seventy-seven cron recovery, lifecycle, and task-run tests passed, including transaction rollback when the worker-owned database rejects the cron job update. Focused owner-hardening proof passed for retained terminal task evidence after receipt-finalization rollback and durable task recovery before a post-commit process crash; the crash assertion now reflects Windows' exit-code representation of self-`SIGKILL` without weakening the Unix signal assertion.
- **Concurrency/failure proof:** expected-state mismatches are typed conflicts and replan from a fresh snapshot with a bound of three attempts. Reconciliation is read-only and requires the complete next job, terminal receipt, and unchanged selected task evidence; task advancement cannot be overwritten. An `already-applied` execute result suppresses duplicate deferred notifications.
- **Architecture proof:** production cron service code no longer imports task-registry SQLite helpers. SQLite row and receipt primitives are private to the SQLite cohort adapter for this operation; no database handle or callback crosses the contract or mailbox. Core production typechecking and the build passed; core test typechecking ran for 900 seconds without diagnostics and timed out.
- **Azure SQL proof:** none. The Azure adapter, schema, and companion-store routing do not exist yet.
- **Known gaps:** Azure activation must move the cohort's companion cron, receipt, subagent, queue, flow, and lifecycle-binding rows and all ordinary writers to one selected backend. Offline migration, Doctor/backup/status integration, performance proof, and live Azure proof remain pending.
- **Rollback or recovery:** restore the former cron-owned SQLite recovery transaction and remove the two cron recovery cohort methods; no schema or persistent data format changed.

### SQLite task cohort and compatibility routing — 2026-09-11

- **Owner boundary:** task/delivery state, task execution binding, subagent completion admission/settlement/blocking, conditional subagent replacement, and the task-owned portions of queue and mirrored-flow transactions.
- **Files changed:** task cohort contract/validation/operation helpers, SQLite adapter, mailbox protocol/handler/facade, task registry runtime routing, subagent composite owners, task reads used by cron history/maintenance/Doctor, and focused tests.
- **Logical contract affected:** synchronous callers now invoke canonical asynchronous cohort operations through the shared single-flight worker. Commands carry exact expected/next state and self-validating IDs; reconciliation never mutates.
- **SQLite proof:** the adapter passed 12 owner-boundary tests covering task/delivery atomicity, exact-next reconciliation, fail-closed expected-state handling, operation-ID integrity, completion admission/settlement, stale-projection rejection, blocked follow-up rollback, replacement, execution binding, and uncorrelated-command rejection.
- **Mailbox proof:** healthy execute/reconcile behavior, retained-command reconciliation, terminal fail-closed restart behavior, and a real worker commit followed by an intentionally oversized/lost response passed. Oversized post-commit responses are classified as outcome unknown rather than ordinary remote errors.
- **Lifecycle proof:** task registry/store/maintenance suites passed 237 tests. Four subagent completion/replacement/restart-acceptance files passed after moving failure-injection triggers from connection-local TEMP triggers to database-visible triggers required by the worker-owned connection. ACP task execution binding and cron-history coverage passed; one cron durable-fence test failed once because process start identity was unavailable and passed unchanged on focused rerun.
- **Type/build/static proof:** core `tsgo`, production build, formatting, Oxlint, assertion safety, database-first legacy-store guard, dead-export analysis, import-cycle check, docs links, and diff checks passed. Core test typechecking ran for 600 seconds without diagnostics and timed out.
- **Azure SQL proof:** none; tasks remain SQLite-authoritative and the task handler intentionally creates only the SQLite adapter.
- **Known gaps at this checkpoint:** the cron-owned shared transaction was still pending and was subsequently moved by the cron/task recovery cohort increment above. Azure schema/store, backend routing, offline migration, Doctor/backup/status activation, performance proof, and live Azure proof remain pending.
- **Rollback or recovery:** restore the previous direct SQLite task/composite owners and remove the task mailbox domain and adapter; no schema or persistent data format changed.

### No-table ambiguity design — 2026-09-10

- **Owner boundary:** task-cohort command validation and commit-ambiguity recovery only.
- **Files changed:** this task vertical notebook.
- **Logical contract affected:** planned task operations use self-validating correlation IDs and non-mutating exact-postcondition reconciliation instead of durable operation receipts.
- **SQLite/Azure proof:** none; neither adapter implements this decision yet.
- **Concurrency/failure proof:** the design fails closed on ABA by refusing mutation in reconciliation mode unless it is only reporting an exact complete next-state match.
- **Operator-visible proof:** an unprovable ambiguous outcome remains visible as `outcome-unknown`; it is not hidden by retry.
- **Known gaps:** revise the extracted result contract, implement canonical operation hashing and reconciliation mode, then prove both adapters against the same failure cases.
- **Rollback or recovery:** documentation-only decision; no schema or persistent state changed.

### Task-cohort contract extraction — 2026-09-10

- **Owner boundary:** canonical asynchronous task transaction-cohort contract only; no backend was activated.
- **Files changed:** `src/storage/task-cohort-store.ts`, the exported execution-owner binding value type, and storage notebooks.
- **Logical contract affected:** no runtime behavior. The extracted boundary names exact task/delivery compare-replacement, execution binding, subagent completion admission/settlement/blocking, and conditional subagent/task/flow replacement operations.
- **SQLite proof:** existing SQLite behavior is unchanged; adapter implementation remains pending.
- **Azure SQL proof:** not applicable; no Azure task adapter or schema exists.
- **Migration proof:** unaffected.
- **Concurrency/failure proof:** command types require operation IDs, expected state or owner identity, non-orphan task/delivery states, and typed conflicts; successful composite results return committed records for post-commit publication.
- **Operator-visible proof:** none; this is a type-contract extraction.
- **Focused tests:** no new runtime tests were added because the extraction has no executable behavior; under the test-audit authoring gate, tests that only restated TypeScript shapes would not provide independent proof.
- **Type/build/docs proof:** core `tsgo`, focused Oxlint, dead-export analysis, formatting, docs links, assertion safety, import cycles, and diff checks passed. Core test typechecking produced no diagnostic before the 240-second command timeout; the stale artifact lock left by that timed-out runner was removed only after its recorded owner and related compiler processes were verified stopped, then core `tsgo` passed again. The path-scoped changed gate passed its first ten checks and stopped at the unrelated overdue `sdk-untrusted-context-identifier-aliases` compatibility record.
- **Known gaps:** SQLite cohort implementation, task mailbox codec/handler/facade, direct SQLite caller removal, no-table ambiguity reconciliation, composite authority proof, and all Azure task work.
- **Rollback or recovery:** remove the unused contract module and return the execution-owner binding type to module-private scope; no persistent state changes.

### Shared mailbox and plugin-state port — 2026-09-10

- **Owner boundary:** internal synchronous storage compatibility transport and the existing plugin-state compatibility facade.
- **Files changed:** shared mailbox protocol/client/worker, plugin-state worker handler/facade/tests, runtime worker entrypoint, and storage notebooks.
- **Logical contract affected:** plugin-state synchronous calls still block until the canonical async operation commits or fails; transport ownership changed from one subprocess per operation to one reusable worker generation.
- **SQLite proof:** unaffected by this subincrement.
- **Azure SQL proof:** adapter/factory tests passed; no live Azure SQL operation was executed.
- **Migration proof:** unaffected by this subincrement.
- **Concurrency/failure proof:** real worker tests passed for sequential worker reuse, structured remote errors, timeout poisoning, replacement fencing, bounded payloads, fail-closed unknown domains, and recovery with a new generation. Handler tests passed for factory-store reuse, connection-identity rotation, and latest SecretRef context.
- **Operator-visible proof:** ambiguous write timeout text retains `commit outcome is unknown`; Gateway shutdown continues to close the plugin-state Azure runtime. `_DEMO_/run-demo.sh` now includes direct async plugin-state access plus synchronous register/read/cleanup checks through one persistent mailbox worker. A sanitized unattended live run passed against the operator-approved isolated Azure SQL database: the active stage observed one project, one lease, and two plugin-state rows; the mailbox re-read persistence after lease release; cleanup removed one project and both plugin-state rows and the mailbox confirmed absence.
- **Focused tests:** 18 mailbox/plugin/factory/routing unit tests passed; Gateway shutdown passed 65 tests with one platform skip. After review and test-audit fixes, the 12 retained mailbox/plugin tests passed again.
- **Type/build/docs proof:** core `tsgo` passed. The unified build produced the new worker entrypoint but later stopped in declaration generation because a dependency `package.json` under `node_modules` changed while the compiler snapshot was reading it; this is an environment/toolchain input race, not a source compile failure. Focused formatting and diff checks passed at this checkpoint.
- **Known gaps:** task routing, full changed checks, complete build proof, performance measurement with Azure SQL, and live Azure proof.
- **Rollback or recovery:** restore the plugin-state subprocess entrypoint/facade and remove the shared worker files; no persistent data or schema changed.

### Investigation evidence — 2026-09-10

- **Owner boundary:** task registry, delivery state, task-owned lifecycle metadata, and narrow subagent/flow/delivery composite transactions.
- **Files changed:** this notebook and its link from the project notebook only.
- **Logical contract affected:** none; investigation and documentation only.
- **SQLite proof:** current source and focused tests were inspected; no tests were changed or run for this documentation-only investigation.
- **Azure SQL proof:** none.
- **Migration proof:** existing task/flow sidecar migration source was inspected; no Azure migration was executed.
- **Concurrency/failure proof:** existing persist-before-publish, sticky restore failure, exact replacement, retention, and lifecycle tests were inventoried; no new proof was run.
- **Operator-visible proof:** none.
- **Known gaps:** implementation of the approved operation contracts and mailbox, direct SQLite caller removal, Azure schema, backend-aware migration, Doctor/status/backup, performance proof, and live Azure proof.
- **Rollback or recovery:** documentation-only change; remove the notebook link and file if the vertical is abandoned.

## Maintenance protocol

Update this notebook during the vertical, not only at completion.

For every meaningful change:

1. update **Current status**;
2. label new statements as approved, implemented, observed, proposed, or blocked;
3. record design decisions and rejected alternatives in **Decision log**;
4. add a dated **Evidence log** entry with files, tests, proof gaps, and recovery behavior;
5. update the source ownership and transaction neighborhood when boundaries move;
6. keep migration and rollback notes current;
7. update the [storage abstraction notebook](/storageabstraction) when a finding changes the project-wide index, phase status, approved architecture, or current boundaries.

Never record credentials, private connection details, personal paths, internal model identifiers, or unsanitized live proof.
