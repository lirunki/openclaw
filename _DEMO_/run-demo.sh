#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
SOURCE_CREDENTIAL_FILE="${AZURE_DEMO_CREDENTIAL_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/openclaw/azure-storage-demo.credentials}"
RUNTIME_DIR=""
CREDENTIAL_FILE=""
HOLDER_PID=""
CLEANUP_COMPLETE=0

color() {
  local code="$1"
  shift
  printf '\033[%sm%s\033[0m\n' "$code" "$*"
}

heading() {
  printf '\n'
  color '1;36' "=== $* ==="
}

pause_for_space() {
  local message="$1"
  if [[ "${DEMO_AUTO_ADVANCE:-0}" == "1" ]]; then
    color '2' "$message [auto]"
    return
  fi
  local tty_fd
  if ! { exec {tty_fd}</dev/tty; } 2>/dev/null; then
    color '2' "$message [no tty: auto]"
    return
  fi
  printf '\n\033[1;33m%s\033[0m' "$message"
  local key
  while IFS= read -r -s -n 1 key <&"$tty_fd"; do
    if [[ "$key" == " " ]]; then
      printf '\n'
      exec {tty_fd}<&-
      return
    fi
  done
  exec {tty_fd}<&-
}

runner() {
  node --import ./scripts/tsx.mjs "$SCRIPT_DIR/azure-storage-demo.mts" "$@" \
    --credential-file "$CREDENTIAL_FILE" \
    --plugin-id "$DEMO_PLUGIN_ID" \
    --project-id "$DEMO_PROJECT_ID" \
    --repo-root "$DEMO_REPO_ROOT" \
    --runtime-dir "$RUNTIME_DIR"
}

wait_for_process_exit() {
  local pid="$1"
  local loops="${2:-100}"
  for _ in $(seq 1 "$loops"); do
    if ! kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

wait_for_ready_file() {
  local pid="$1"
  local file_path="$2"
  local log_path="$3"
  local exited_message="$4"
  local timeout_message="$5"
  for _ in $(seq 1 600); do
    if [[ -f "$file_path" ]]; then
      return 0
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      color '1;31' "$exited_message"
      if [[ -f "$log_path" ]]; then
        cat "$log_path"
      fi
      return 1
    fi
    sleep 0.1
  done
  color '1;31' "$timeout_message"
  return 1
}

stop_holder() {
  local request_cleanup="${1:-0}"
  if [[ -z "$HOLDER_PID" ]]; then
    return 1
  fi
  if ! kill -0 "$HOLDER_PID" 2>/dev/null; then
    wait "$HOLDER_PID" 2>/dev/null || true
    HOLDER_PID=""
    return 1
  fi
  if [[ "$request_cleanup" == "1" && -n "$RUNTIME_DIR" ]]; then
    touch "$RUNTIME_DIR/cleanup"
  fi
  if [[ -n "$RUNTIME_DIR" ]]; then
    touch "$RUNTIME_DIR/release"
  fi
  if ! wait_for_process_exit "$HOLDER_PID"; then
    kill "$HOLDER_PID" 2>/dev/null || true
  fi
  wait "$HOLDER_PID" 2>/dev/null || return 1
  HOLDER_PID=""
  return 0
}

print_manual_cleanup_hint() {
  if [[ -z "$RUNTIME_DIR" ]]; then
    return
  fi
  color '1;33' "Manual synthetic cleanup may be required for:"
  printf '  project id: %s\n' "$DEMO_PROJECT_ID"
  printf '  plugin id:  %s\n' "$DEMO_PLUGIN_ID"
  printf '  repo root:  %s\n' "$DEMO_REPO_ROOT"
  printf '%s\n' "Retry cleanup with the same IDs and your external credential file before using this database again."
}

cleanup() {
  local exit_code=$?
  local cleanup_failed=0
  trap - EXIT INT TERM

  if [[ "$CLEANUP_COMPLETE" != "1" && -n "$HOLDER_PID" ]]; then
    if stop_holder 1; then
      CLEANUP_COMPLETE=1
    else
      [[ -f "$RUNTIME_DIR/holder.log" ]] && cat "$RUNTIME_DIR/holder.log"
    fi
  fi

  if [[ "$CLEANUP_COMPLETE" != "1" && -n "$RUNTIME_DIR" && -n "$CREDENTIAL_FILE" && -f "$CREDENTIAL_FILE" ]]; then
    if runner cleanup >"$RUNTIME_DIR/fallback-cleanup.log" 2>&1; then
      CLEANUP_COMPLETE=1
    else
      cleanup_failed=1
      cat "$RUNTIME_DIR/fallback-cleanup.log"
    fi
  fi

  if [[ "$cleanup_failed" -ne 0 ]]; then
    print_manual_cleanup_hint
    if [[ "$exit_code" -eq 0 ]]; then
      exit_code=1
    fi
  fi

  if [[ -n "$RUNTIME_DIR" ]]; then
    rm -rf -- "$RUNTIME_DIR"
  fi
  if [[ "$exit_code" -ne 0 ]]; then
    color '1;31' "Demo stopped with an error. Synthetic cleanup was attempted."
  fi
  exit "$exit_code"
}
trap cleanup EXIT INT TERM

cd "$REPO_ROOT"

heading "OpenClaw Azure SQL storage-abstraction demo"
printf '%s\n' \
  "This demo uses the production AzureSqlDatabase, AzureSqlProjectRegistryStore," \
  "AzureSqlPluginStateStore, and the shared synchronous mailbox. It creates one" \
  "synthetic project, one short-lived checkout lease, and two plugin-state entries" \
  "in the operator-approved isolated Azure SQL test database, then removes them." \
  "No connection string, username, or password is printed."

if [[ ! -f "$SOURCE_CREDENTIAL_FILE" ]]; then
  color '1;31' "Credential file not found: $SOURCE_CREDENTIAL_FILE"
  printf '%s\n' "Set AZURE_DEMO_CREDENTIAL_FILE or create the documented user-config credential file."
  exit 1
fi
if [[ ! -f "$REPO_ROOT/node_modules/mssql/package.json" ]]; then
  color '1;31' "Dependencies are missing. Run: pnpm install"
  exit 1
fi

pause_for_space "Press SPACE to confirm this is an isolated test database and begin."

RUNTIME_DIR="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-azure-storage-demo.XXXXXX")"
chmod 700 "$RUNTIME_DIR"
CREDENTIAL_FILE="$RUNTIME_DIR/credentials"
install -m 600 "$SOURCE_CREDENTIAL_FILE" "$CREDENTIAL_FILE"

DEMO_NONCE="$(node -e 'process.stdout.write(crypto.randomUUID())')"
DEMO_PROJECT_ID="azure-demo-${DEMO_NONCE:0:24}"
DEMO_PLUGIN_ID="azure-demo-plugin-${DEMO_NONCE:0:24}"
DEMO_REPO_ROOT="/openclaw-storage-demo/$DEMO_NONCE"
export DEMO_PROJECT_ID DEMO_PLUGIN_ID DEMO_REPO_ROOT

runner write-sql

heading "Stage 1: create project and plugin state while holding the Azure SQL lease"
rm -f "$RUNTIME_DIR/ready.json" "$RUNTIME_DIR/release" "$RUNTIME_DIR/cleanup" "$RUNTIME_DIR/released.json" "$RUNTIME_DIR/cleanup-result.json"
runner hold >"$RUNTIME_DIR/holder.log" 2>&1 &
HOLDER_PID=$!

wait_for_ready_file \
  "$HOLDER_PID" \
  "$RUNTIME_DIR/ready.json" \
  "$RUNTIME_DIR/holder.log" \
  "The Azure SQL holder exited before becoming ready." \
  "Timed out waiting for the Azure SQL lease and project insert."
cat "$RUNTIME_DIR/ready.json"

heading "Inspect while the lease is active"
printf '%s\n' \
  "The lease holder inserted the project and one plugin-state row directly. It used" \
  "three synchronous calls through one persistent mailbox worker/pool to insert and" \
  "read the second row and bulk-read both. Confirm all four rows externally now."
printf '\nRun this generated SQL file in Azure Portal, SSMS, or Azure Data Studio now:\n  %s\n' \
  "$RUNTIME_DIR/demo-queries.sql"
printf 'Expected: demo_project_rows=1, demo_lease_rows=1, demo_plugin_state_rows=2.\n'
pause_for_space "Press SPACE after inspecting the active project and lease."

heading "Stage 2: release the lease but retain the project"
touch "$RUNTIME_DIR/release"
wait_for_ready_file \
  "$HOLDER_PID" \
  "$RUNTIME_DIR/released.json" \
  "$RUNTIME_DIR/holder.log" \
  "The Azure SQL holder exited before recording the released project state." \
  "Timed out waiting for the lease release confirmation."
cat "$RUNTIME_DIR/released.json"

heading "Verify persistence after lease release"
printf '%s\n' \
  "The checkout lease is now released, but the holder stays alive so it can perform" \
  "final cleanup without depending on another Azure SQL login. The mailbox also" \
  "re-read its row after lease release. Re-run SQL: project=1, lease=0, plugin state=2."
printf '\nSQL file:\n  %s\n' "$RUNTIME_DIR/demo-queries.sql"
pause_for_space "Press SPACE to remove the synthetic project and plugin state, then verify cleanup."

heading "Stage 3: cleanup through the storage contract"
touch "$RUNTIME_DIR/cleanup"
wait "$HOLDER_PID"
HOLDER_PID=""
cat "$RUNTIME_DIR/cleanup-result.json"
CLEANUP_COMPLETE=1

heading "Demo passed"
color '1;32' "Azure SQL health, migrations, lease ownership, project reads, plugin-state"
color '1;32' "direct and mailbox reads, worker/pool reuse, persistence, and cleanup succeeded."
printf '\nScope reminder: this proves the project-registry and plugin-state vertical slices. Other OpenClaw stores remain SQLite-backed.\n'
printf 'Temporary local demo files will now be removed.\n'
