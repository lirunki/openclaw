import type { DatabaseSync } from "node:sqlite";
import { safeParseJsonRecord } from "@openclaw/normalization-core";
import { tableExists, tableHasColumn } from "./openclaw-state-db-schema-helpers.js";

export type LegacySubagentBackingMetadataRepairDisposition = {
  taskRunIdsRepaired: number;
  backingMetadataRepaired: number;
  backingMetadataUnchanged: number;
  backingMetadataSkipped: { ambiguous: number; foreign: number; mismatch: number };
};

type LegacySubagentBindingRow = {
  run_id: string;
  child_session_key: string;
  requester_session_key: string;
  created_at: number;
  payload_json: string;
};

type LegacySubagentTaskRow = {
  task_id: string;
  runtime: string;
  requester_session_key: string | null;
  owner_key: string;
  scope_kind: string;
  child_session_key: string | null;
  run_id: string | null;
  parent_flow_id: string | null;
  created_at: number;
  detail_json: string | null;
};

type LegacyTaskFlowRow = {
  flow_id: string;
  shape: string | null;
  sync_mode: string | null;
  owner_key: string;
};

type ParsedLegacyRun = {
  row: LegacySubagentBindingRow;
  payload: Record<string, unknown> | null;
  binding:
    | { kind: "explicit" | "implicit"; runId: string }
    | { kind: "invalid"; conservativeRunId?: string };
};

type LegacyBindingCandidate = {
  run: ParsedLegacyRun;
  task: LegacySubagentTaskRow;
  claimedRunId: string;
  recoveredTaskRunId: boolean;
};

function textField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function positiveSafeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function countBy(values: Iterable<string>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

function readBinding(row: LegacySubagentBindingRow, payload: Record<string, unknown> | null) {
  if (!payload) {
    return { kind: "invalid" as const };
  }
  if (Object.hasOwn(payload, "taskRunId")) {
    const taskRunId = textField(payload, "taskRunId");
    if (taskRunId) {
      return { kind: "explicit" as const, runId: taskRunId };
    }
    return { kind: "invalid" as const, conservativeRunId: row.run_id };
  }
  return { kind: "implicit" as const, runId: row.run_id };
}

function isCanonicalMirroredFlow(flow: LegacyTaskFlowRow | undefined, ownerKey: string): boolean {
  if (!flow || flow.owner_key !== ownerKey) {
    return false;
  }
  return (
    flow.sync_mode === "task_mirrored" || (!flow.sync_mode?.trim() && flow.shape === "single_task")
  );
}

function hasMatchingOwnership(params: {
  run: ParsedLegacyRun;
  task: LegacySubagentTaskRow;
  flow: LegacyTaskFlowRow | undefined;
}): boolean {
  const { row } = params.run;
  const taskRunId = params.task.run_id?.trim();
  if (
    params.task.runtime !== "subagent" ||
    params.task.scope_kind !== "session" ||
    !taskRunId ||
    params.task.requester_session_key !== row.requester_session_key ||
    params.task.owner_key !== row.requester_session_key ||
    params.task.child_session_key !== row.child_session_key
  ) {
    return false;
  }
  const flowId = params.task.parent_flow_id?.trim();
  return !flowId || isCanonicalMirroredFlow(params.flow, params.task.owner_key);
}

function reservesMatchingTaskClaim(params: {
  run: ParsedLegacyRun;
  task: LegacySubagentTaskRow;
  generation: number;
}): boolean {
  const { binding, payload, row } = params.run;
  return (
    binding.kind === "invalid" &&
    binding.conservativeRunId === params.task.run_id?.trim() &&
    row.requester_session_key === params.task.requester_session_key &&
    row.requester_session_key === params.task.owner_key &&
    row.child_session_key === params.task.child_session_key &&
    positiveSafeInteger(payload?.generation) === params.generation
  );
}

function findLegacyReplacementCandidate(params: {
  run: ParsedLegacyRun;
  runsByChild: Map<string, ParsedLegacyRun[]>;
  tasksByChild: Map<string, LegacySubagentTaskRow[]>;
}): LegacySubagentTaskRow | undefined {
  const payload = params.run.payload;
  const sessionStartedAt = payload ? payload.sessionStartedAt : undefined;
  if (
    params.run.binding.kind !== "implicit" ||
    typeof sessionStartedAt !== "number" ||
    !Number.isFinite(sessionStartedAt) ||
    sessionStartedAt >= params.run.row.created_at
  ) {
    return undefined;
  }
  const childRuns = params.runsByChild.get(params.run.row.child_session_key) ?? [];
  const childTasks = (params.tasksByChild.get(params.run.row.child_session_key) ?? []).filter(
    (task) => task.runtime === "subagent",
  );
  if (childRuns.length !== 1 || childTasks.length !== 1) {
    return undefined;
  }
  const task = childTasks[0];
  return task &&
    task.requester_session_key === params.run.row.requester_session_key &&
    task.run_id?.trim() &&
    task.created_at >= sessionStartedAt &&
    task.created_at <= params.run.row.created_at
    ? task
    : undefined;
}

export function repairLegacySubagentBackingMetadata(
  db: DatabaseSync,
): LegacySubagentBackingMetadataRepairDisposition {
  const disposition: LegacySubagentBackingMetadataRepairDisposition = {
    taskRunIdsRepaired: 0,
    backingMetadataRepaired: 0,
    backingMetadataUnchanged: 0,
    backingMetadataSkipped: { ambiguous: 0, foreign: 0, mismatch: 0 },
  };
  if (
    !tableExists(db, "subagent_runs") ||
    !tableExists(db, "task_runs") ||
    !tableHasColumn(db, "task_runs", "detail_json")
  ) {
    return disposition;
  }
  const runs = db
    .prepare(
      `SELECT run_id, child_session_key, requester_session_key, created_at, payload_json
         FROM subagent_runs
        ORDER BY run_id`,
    )
    // SAFETY: The SELECT columns match this private migration row shape.
    .all() as LegacySubagentBindingRow[];
  const tasks = db
    .prepare(
      `SELECT task_id, runtime, requester_session_key, owner_key, scope_kind,
              child_session_key, run_id, parent_flow_id, created_at, detail_json
         FROM task_runs
        ORDER BY task_id`,
    )
    // SAFETY: The SELECT columns match this private migration row shape.
    .all() as LegacySubagentTaskRow[];
  const flows = tableExists(db, "flow_runs")
    ? (db
        .prepare("SELECT flow_id, shape, sync_mode, owner_key FROM flow_runs")
        // SAFETY: The SELECT columns match this private migration row shape.
        .all() as LegacyTaskFlowRow[])
    : [];
  const flowsById = new Map(flows.map((flow) => [flow.flow_id, flow]));
  const tasksByRunId = Map.groupBy(
    tasks.filter((task) => task.run_id?.trim()),
    (task) => task.run_id!.trim(),
  );
  const tasksByChild = Map.groupBy(
    tasks.filter((task) => task.child_session_key?.trim()),
    (task) => task.child_session_key!.trim(),
  );
  const parsedRuns: ParsedLegacyRun[] = runs.map((row) => {
    const payload = safeParseJsonRecord(row.payload_json);
    return { row, payload, binding: readBinding(row, payload) };
  });
  const runsByChild = Map.groupBy(parsedRuns, (run) => run.row.child_session_key);
  const explicitClaimCounts = countBy(
    parsedRuns.flatMap((run) => (run.binding.kind === "invalid" ? [] : [run.binding.runId])),
  );
  const candidates = new Map<ParsedLegacyRun, LegacyBindingCandidate>();

  for (const run of parsedRuns) {
    if (!run.payload || run.binding.kind === "invalid") {
      disposition.backingMetadataSkipped.foreign += 1;
      continue;
    }
    const directTasks = tasksByRunId.get(run.binding.runId) ?? [];
    if (directTasks.length > 1) {
      disposition.backingMetadataSkipped.ambiguous += 1;
      continue;
    }
    const directTask = directTasks[0];
    const replacementTask = directTask
      ? undefined
      : findLegacyReplacementCandidate({ run, runsByChild, tasksByChild });
    const task = directTask ?? replacementTask;
    if (!task) {
      disposition.backingMetadataSkipped.mismatch += 1;
      continue;
    }
    candidates.set(run, {
      run,
      task,
      claimedRunId: run.binding.runId,
      recoveredTaskRunId: replacementTask !== undefined,
    });
  }

  const targetCounts = countBy(
    [...candidates.values()].flatMap((candidate) => {
      const runId = candidate.task.run_id?.trim();
      return runId ? [runId] : [];
    }),
  );
  const updateRun = db.prepare(
    "UPDATE subagent_runs SET payload_json = ? WHERE run_id = ? AND payload_json = ?",
  );
  const updateTask = db.prepare(
    "UPDATE task_runs SET detail_json = ? WHERE task_id = ? AND detail_json IS ?",
  );

  for (const candidate of candidates.values()) {
    const { run, task } = candidate;
    const taskRunId = task.run_id?.trim();
    if (!taskRunId) {
      disposition.backingMetadataSkipped.mismatch += 1;
      continue;
    }
    const payload = run.payload!;
    const hasGeneration = Object.hasOwn(payload, "generation");
    const runGeneration = positiveSafeInteger(payload.generation);
    if (hasGeneration && runGeneration === undefined) {
      disposition.backingMetadataSkipped.foreign += 1;
      continue;
    }
    const detail = task.detail_json === null ? null : safeParseJsonRecord(task.detail_json);
    const detailGeneration =
      detail?.kind === "task_backing_instance" &&
      detail.runtime === "subagent" &&
      !Object.hasOwn(detail, "taskId")
        ? positiveSafeInteger(detail.generation)
        : undefined;
    if (task.detail_json !== null && detailGeneration === undefined) {
      disposition.backingMetadataSkipped.foreign += 1;
      continue;
    }
    if (
      runGeneration !== undefined &&
      detailGeneration !== undefined &&
      runGeneration !== detailGeneration
    ) {
      disposition.backingMetadataSkipped.mismatch += 1;
      continue;
    }
    const generation = runGeneration ?? detailGeneration ?? 1;
    const ownClaimMatches = candidate.claimedRunId === taskRunId;
    const conservativeClaims = parsedRuns.filter((other) =>
      reservesMatchingTaskClaim({ run: other, task, generation }),
    ).length;
    if (
      (tasksByRunId.get(taskRunId)?.length ?? 0) !== 1 ||
      (targetCounts.get(taskRunId) ?? 0) !== 1 ||
      (explicitClaimCounts.get(taskRunId) ?? 0) + conservativeClaims !== (ownClaimMatches ? 1 : 0)
    ) {
      disposition.backingMetadataSkipped.ambiguous += 1;
      continue;
    }
    const flowId = task.parent_flow_id?.trim();
    const flow = flowId ? flowsById.get(flowId) : undefined;
    if (!hasMatchingOwnership({ run, task, flow })) {
      disposition.backingMetadataSkipped.mismatch += 1;
      continue;
    }

    const bindingPayload = candidate.recoveredTaskRunId ? { ...payload, taskRunId } : payload;
    const nextPayload = {
      ...bindingPayload,
      ...(runGeneration === undefined ? { generation } : {}),
    };
    const runChanged = candidate.recoveredTaskRunId || runGeneration === undefined;
    if (
      runChanged &&
      updateRun.run(JSON.stringify(nextPayload), run.row.run_id, run.row.payload_json).changes !== 1
    ) {
      throw new Error(`legacy subagent run ${run.row.run_id} changed during metadata repair`);
    }
    if (detailGeneration === undefined) {
      if (
        updateTask.run(
          JSON.stringify({ kind: "task_backing_instance", runtime: "subagent", generation }),
          task.task_id,
          task.detail_json,
        ).changes !== 1
      ) {
        throw new Error(`legacy subagent task ${task.task_id} changed during metadata repair`);
      }
    }
    if (candidate.recoveredTaskRunId) {
      disposition.taskRunIdsRepaired += 1;
    }
    if (runGeneration === generation && detailGeneration === generation) {
      disposition.backingMetadataUnchanged += 1;
    } else {
      disposition.backingMetadataRepaired += 1;
    }
  }
  return disposition;
}
