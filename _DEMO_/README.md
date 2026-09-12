# Azure SQL storage-abstraction demo

This demo exercises the production `AzureSqlDatabase`,
`AzureSqlProjectRegistryStore`, `AzureSqlPluginStateStore`,
`AzureSqlPluginStateSyncBridge`, and the direct asynchronous
`AzureSqlTaskCohortStore` against an operator-approved isolated Azure SQL
database.

It proves:

- encrypted connectivity and health;
- project-registry migrations v1/v2, plugin-state migration v1, and task-cohort migration v1;
- backend-owned checkout leasing;
- project insert, point read, and list on the live lease-holding connection;
- direct asynchronous plugin-state registration and point reads;
- synchronous plugin-state registration, point reads, and positional bulk reads
  through one persistent shared mailbox worker and its reusable Azure SQL pool;
- cross-connection visibility between the direct store and mailbox worker;
- project and plugin-state persistence after lease release, re-read through the
  mailbox and verified with the generated external SQL checks;
- the simple task API path: create a task without a delivery companion, then read it by runtime/source and owner key;
- the cohort path: atomically create and advance a task with its delivery-state companion, then reconcile the same exact command as already applied;
- external inspection of two task rows and exactly one delivery-state row;
- removal and verified cleanup of every synthetic namespace.

Project registry and plugin state are selectable Azure SQL vertical slices. The
Azure task adapter and physical cohort schema are demonstrated directly, but
production task selection intentionally remains disabled until all ordinary
writers for its companion stores can select the same backend atomically.
Sessions, transcripts, memory, and other stores still use SQLite.

## Run

From the repository root:

```bash
./_DEMO_/run-demo.sh
```

Press **Space** at each prompt. While paused, run the generated SQL file whose
path the script prints. During the first pause, the script relies on the live
lease-holder's verified operations and asks you to confirm the active project,
lease, and two plugin-state rows externally with SQL instead of opening another
fresh Azure SQL login. One plugin-state row is written directly and one through
the synchronous mailbox. After lease release, re-run that SQL file to confirm
the project and both plugin-state rows remain while the lease row is gone.

The appended task portion then:

1. creates and reads a simple task without a delivery companion;
2. creates a second task and delivery-state row in one atomic operation;
3. advances both cohort rows in one compare-and-replace transaction;
4. replays the command in reconciliation mode and proves `already-applied`;
5. pauses for external SQL inspection with expected counts of two tasks and one
   delivery-state row; and
6. removes the task rows through the cohort contract and verifies zero remain.

The generated file contains only synthetic IDs and no credentials.

If the demo runs without an interactive TTY, each pause auto-advances instead of
failing on `/dev/tty`.

By default the script reads
`$XDG_CONFIG_HOME/openclaw/azure-storage-demo.credentials` (or
`$HOME/.config/openclaw/azure-storage-demo.credentials` when
`XDG_CONFIG_HOME` is unset), formatted as:

```text
connection_string: <Azure SQL connection string>
dbuser: <isolated test database user>
dbpassword: <password>
```

To override the default credential path:

```bash
AZURE_DEMO_CREDENTIAL_FILE="$HOME/.config/openclaw/azure-storage-demo.credentials" \
  ./_DEMO_/run-demo.sh
```

The script copies the credential into a mode-`0600` temporary directory, never
prints its values, and removes the temporary copy at exit. For the mailbox path,
the generated runtime config contains only an environment-backed `SecretRef`;
the temporary password value is resolved inside the worker and is never written
to generated SQL or output. Before inserting the current synthetic records, it
removes only rows matching that run's randomized
identifiers, so concurrent demo runs cannot delete each other's evidence. Task
IDs are derived from the same per-run random project ID and cleanup targets only
those exact IDs. After lease release, the already-authenticated holder stays
alive for project/plugin cleanup. The appended task section opens its own direct
adapter connection. If the demo is interrupted, it prefers cleanup from the
live helper when available and otherwise performs a standalone exact-run
cleanup.

For unattended validation only:

```bash
DEMO_AUTO_ADVANCE=1 ./_DEMO_/run-demo.sh
```

`sql-queries.sql` is a placeholder template. During a run, use the generated
`demo-queries.sql` path printed by the script because it already contains that
run's synthetic project ID, plugin ID, and repository root.
