# Azure SQL storage-abstraction demo

This demo exercises the production `AzureSqlDatabase`,
`AzureSqlProjectRegistryStore`, `AzureSqlPluginStateStore`, and
`AzureSqlPluginStateSyncBridge` against an operator-approved isolated Azure SQL
database.

It proves:

- encrypted connectivity and health;
- project-registry migrations v1/v2 and plugin-state migration v1;
- backend-owned checkout leasing;
- project insert, point read, and list on the live lease-holding connection;
- direct asynchronous plugin-state registration and point reads;
- synchronous plugin-state registration, point reads, and positional bulk reads
  through one persistent shared mailbox worker and its reusable Azure SQL pool;
- cross-connection visibility between the direct store and mailbox worker;
- project and plugin-state persistence after lease release, re-read through the
  mailbox and verified with the generated external SQL checks;
- removal and verified cleanup of both synthetic namespaces.

The current implementation includes two Azure SQL vertical slices: the project
registry with its checkout lease, and plugin state. Sessions, transcripts, cron,
memory, and other stores still use SQLite.

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
the project and both plugin-state rows remain while the lease row is gone. The
generated file contains only synthetic IDs and no credentials.

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
identifiers, so concurrent demo runs cannot delete each other's evidence. After
lease release, the already-authenticated holder stays alive for final cleanup,
so the demo does not depend on another Azure SQL login. If the demo is
interrupted, it prefers cleanup from that live helper and falls back to a
standalone cleanup attempt.

For unattended validation only:

```bash
DEMO_AUTO_ADVANCE=1 ./_DEMO_/run-demo.sh
```

`sql-queries.sql` is a placeholder template. During a run, use the generated
`demo-queries.sql` path printed by the script because it already contains that
run's synthetic project ID, plugin ID, and repository root.
