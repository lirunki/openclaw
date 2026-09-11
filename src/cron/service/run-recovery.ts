import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { prepareTaskCohortOperation } from "../../storage/task-cohort-operation.js";
import type {
  CronRunRecoveryJobState,
  CronRunRecoveryReceiptCompletion,
  CronRunRecoverySnapshot,
  RecoverCronRunCommand,
} from "../../storage/task-cohort-store.js";
import { taskCohortSyncBridge } from "../../tasks/task-cohort-sync-bridge.js";
import { noteCronJobsStoreCommit } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import { loadedCronStoreFromRows, loadCronRows, upsertCronJobRow } from "../store/row-codec.js";
import {
  inspectActiveCronRunReceipt,
  isCronRunReceiptOwnerStale,
  listActiveCronRunReceiptJobIdsInDatabase,
  type CronRunReceiptRecoveryCandidate,
} from "../store/run-receipt-store.js";
import { finalizedCronTaskRun } from "../task-run-recovery.js";
import type { CronJob } from "../types.js";
import {
  type CronMaintenanceOptions,
  recomputeJobNextRunAtMs,
  recomputeSingleJobForMaintenance,
} from "./jobs-scheduling.js";
import { resolveCronRunReceiptTerminalStatus } from "./run-receipts.js";
import {
  type InterruptedStartupRun,
  markInterruptedStartupRun,
  restoreFinalizedStartupRun,
} from "./startup-run-repair.js";
import type { CronServiceState, DeferredCronNotifications } from "./state.js";

export type CronRunRecoveryProposal = {
  jobId: string;
  queuedAtMs?: number;
  runningAtMs?: number;
  receipt?: CronRunReceiptRecoveryCandidate;
};

export type CronRunRecoveryResult =
  | { kind: "live"; receipt: CronRunReceiptRecoveryCandidate }
  | { kind: "superseded"; receipt?: CronRunReceiptRecoveryCandidate }
  | {
      kind: "repaired";
      interrupted?: InterruptedStartupRun;
      notifications: DeferredCronNotifications;
      skipStartupCatchup?: boolean;
    };

function exactReceiptMatches(
  current: CronRunReceiptRecoveryCandidate | undefined,
  proposed: CronRunReceiptRecoveryCandidate,
): boolean {
  return (
    current?.receiptId === proposed.receiptId &&
    current.ownerPid === proposed.ownerPid &&
    current.ownerStartTime === proposed.ownerStartTime &&
    current.storeKey === proposed.storeKey &&
    current.jobId === proposed.jobId &&
    current.startedAtMs === proposed.startedAtMs
  );
}

type PreparedCronRunRecovery = {
  result: CronRunRecoveryResult;
  next?: RecoverCronRunCommand["next"];
};

function prepareCronRunRecovery(params: {
  state: CronServiceState;
  proposal: CronRunRecoveryProposal;
  proposedReceiptIsStale: boolean;
  mode: "startup" | "reclaim";
  snapshot: CronRunRecoverySnapshot;
}): PreparedCronRunRecovery {
  const { state, proposal, snapshot } = params;
  const currentReceipt = snapshot.receipt ?? undefined;
  const jobState = snapshot.job;
  const job = jobState ? structuredClone(jobState.job) : undefined;
  let receiptCompletion: CronRunRecoveryReceiptCompletion | null = null;
  const finishReceipt = (input: Omit<CronRunRecoveryReceiptCompletion, "handle">): void => {
    if (proposal.receipt && currentReceipt) {
      receiptCompletion = { handle: proposal.receipt, ...input };
    }
  };
  const repaired = (
    result: Extract<CronRunRecoveryResult, { kind: "repaired" }>,
    nextJob: CronRunRecoveryJobState,
  ): PreparedCronRunRecovery => ({
    result,
    next: { job: nextJob, receipt: receiptCompletion, task: snapshot.task },
  });

  if (proposal.receipt) {
    if (!exactReceiptMatches(currentReceipt, proposal.receipt) && currentReceipt) {
      return { result: { kind: "superseded", receipt: currentReceipt } };
    }
    if (currentReceipt && !params.proposedReceiptIsStale) {
      return { result: { kind: "live", receipt: currentReceipt } };
    }
  } else if (currentReceipt) {
    return { result: { kind: "superseded", receipt: currentReceipt } };
  }

  if (!jobState || !job) {
    if (proposal.receipt && currentReceipt) {
      finishReceipt({
        status: "interrupted",
        finishedAtMs: state.deps.nowMs(),
        error: "cron: owner unavailable after the job row was finalized",
      });
      return repaired({ kind: "repaired", notifications: [] }, null);
    }
    return { result: { kind: "superseded" } };
  }

  let changed = false;
  if (proposal.queuedAtMs !== undefined && job.state.queuedAtMs === proposal.queuedAtMs) {
    delete job.state.queuedAtMs;
    if (proposal.receipt && currentReceipt) {
      finishReceipt({
        status: "interrupted",
        finishedAtMs: state.deps.nowMs(),
        error: "cron: queued run interrupted because owner is unavailable",
      });
    }
    changed = true;
  }

  let interrupted: InterruptedStartupRun | undefined;
  let replacementAtMs: number | undefined;
  const notifications: DeferredCronNotifications = [];
  if (proposal.runningAtMs !== undefined) {
    if (job.state.runningAtMs !== proposal.runningAtMs) {
      if (proposal.receipt && currentReceipt) {
        finishReceipt({
          status: "interrupted",
          finishedAtMs: state.deps.nowMs(),
          error: "cron: owner unavailable after run state was already finalized",
        });
        return repaired({ kind: "repaired", notifications: [] }, jobState);
      }
      return {
        result: { kind: "superseded", ...(currentReceipt ? { receipt: currentReceipt } : {}) },
      };
    }
    const finalized = finalizedCronTaskRun(snapshot.task ?? undefined, proposal.jobId);
    const restored = finalized
      ? restoreFinalizedStartupRun({
          state,
          job,
          runningAtMs: proposal.runningAtMs,
          entry: finalized.entry,
          ...(finalized.scriptResult ? { scriptResult: finalized.scriptResult } : {}),
          ...(finalized.triggerEval ? { triggerEval: finalized.triggerEval } : {}),
          deferredNotifications: notifications,
        })
      : undefined;
    replacementAtMs = restored?.replacementAtMs;
    if (!restored) {
      const nowMs = state.deps.nowMs();
      interrupted = markInterruptedStartupRun({
        state,
        job,
        ...(snapshot.task?.runId ? { taskRunId: snapshot.task.runId } : {}),
        runningAtMs: proposal.runningAtMs,
        nowMs,
        recoverInterruptedOneShot: params.mode === "startup",
        deferredNotifications: notifications,
      });
      replacementAtMs = interrupted.replacementAtMs;
      if (job.enabled && job.state.nextRunAtMs === undefined) {
        recomputeJobNextRunAtMs({
          state,
          job,
          nowMs,
          deferredNotifications: notifications,
        });
      }
      if (params.mode === "startup" && job.schedule.kind === "at") {
        job.state.startupCatchupAtMs = job.state.nextRunAtMs;
      }
    }
    if (proposal.receipt && currentReceipt) {
      finishReceipt({
        status:
          restored && finalized
            ? resolveCronRunReceiptTerminalStatus(
                finalized.entry.status,
                finalized.triggerEval?.fired,
              )
            : "interrupted",
        finishedAtMs: restored && finalized ? finalized.entry.ts : state.deps.nowMs(),
        ...(restored && finalized && finalized.entry.error
          ? { error: finalized.entry.error }
          : restored && finalized
            ? {}
            : { error: "cron: job interrupted because owner is unavailable" }),
      });
    }
    if (restored?.shouldDelete) {
      return repaired(
        {
          kind: "repaired",
          notifications,
          ...(restored.replacementAtMs === undefined ? { skipStartupCatchup: true } : {}),
        },
        null,
      );
    }
    changed = true;
  }

  if (!changed) {
    if (proposal.receipt && currentReceipt && params.proposedReceiptIsStale) {
      finishReceipt({
        status: "interrupted",
        finishedAtMs: state.deps.nowMs(),
        error: "cron: owner unavailable after run marker retirement",
      });
      return repaired({ kind: "repaired", notifications }, jobState);
    }
    return {
      result: { kind: "superseded", ...(currentReceipt ? { receipt: currentReceipt } : {}) },
    };
  }

  return repaired(
    {
      kind: "repaired",
      ...(interrupted ? { interrupted } : {}),
      notifications,
      ...(replacementAtMs === undefined &&
      proposal.runningAtMs !== undefined &&
      !(params.mode === "startup" && interrupted && job.schedule.kind === "at")
        ? { skipStartupCatchup: true }
        : {}),
    },
    { job, sortOrder: jobState.sortOrder },
  );
}

export function proposeCronRunRecovery(
  state: CronServiceState,
  jobId: string,
  queuedAtMs: number | undefined,
  runningAtMs: number | undefined,
): CronRunRecoveryProposal {
  return {
    jobId,
    ...(queuedAtMs !== undefined ? { queuedAtMs } : {}),
    ...(queuedAtMs !== undefined || runningAtMs !== undefined
      ? {
          receipt: inspectActiveCronRunReceipt({ storePath: state.deps.storePath, jobId }),
        }
      : {}),
    ...(runningAtMs !== undefined ? { runningAtMs } : {}),
  };
}

/** Reconciles the bounded durable marker set so live siblings can adopt dead owners. */
export function recoverNonTerminalCronRunReceipts(state: CronServiceState): {
  repaired: boolean;
  receipts: CronRunReceiptRecoveryCandidate[];
  notifications: DeferredCronNotifications;
} {
  let repaired = false;
  const receipts: CronRunReceiptRecoveryCandidate[] = [];
  const notifications: DeferredCronNotifications = [];
  for (const job of state.store?.jobs ?? []) {
    const queuedAtMs = job.state.queuedAtMs;
    const runningAtMs = job.state.runningAtMs;
    if (queuedAtMs === undefined && runningAtMs === undefined) {
      continue;
    }
    const proposal = proposeCronRunRecovery(state, job.id, queuedAtMs, runningAtMs);
    const result = recoverCronRunProposal(state, proposal);
    if (result.kind === "live") {
      if (result.receipt.ownerPid !== process.pid) {
        receipts.push(result.receipt);
      }
    } else if (result.kind === "superseded") {
      if (result.receipt && result.receipt.ownerPid !== process.pid) {
        receipts.push(result.receipt);
      }
    } else {
      repaired = true;
      notifications.push(...result.notifications);
    }
  }
  return { repaired, receipts, notifications };
}

export function recoverCronRunProposal(
  state: CronServiceState,
  proposal: CronRunRecoveryProposal,
  mode: "startup" | "reclaim" = "reclaim",
): CronRunRecoveryResult {
  const proposedReceiptIsStale = proposal.receipt
    ? isCronRunReceiptOwnerStale(proposal.receipt, state.deps.nowMs())
    : true;
  const storeKey = cronStoreKey(state.deps.storePath);
  const selector = {
    storeKey,
    jobId: proposal.jobId,
    startedAt: proposal.runningAtMs ?? proposal.queuedAtMs ?? 0,
    ...(proposal.receipt ? { receiptId: proposal.receipt.receiptId } : {}),
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const snapshot = taskCohortSyncBridge.inspectCronRunRecovery(selector);
    const prepared = prepareCronRunRecovery({
      state,
      proposal,
      proposedReceiptIsStale,
      mode,
      snapshot,
    });
    if (!prepared.next) {
      return prepared.result;
    }
    const command: RecoverCronRunCommand = prepareTaskCohortOperation("recover-cron-run", {
      selector,
      expected: snapshot,
      next: prepared.next,
    });
    const committed = taskCohortSyncBridge.recoverCronRun({
      command,
      options: { mode: "execute" },
    });
    if (committed.status === "conflict") {
      continue;
    }
    if (committed.status === "outcome-unknown") {
      throw new Error("cron run recovery commit outcome could not be proven");
    }
    noteCronJobsStoreCommit(storeKey);
    return committed.status === "already-applied"
      ? { kind: "repaired", notifications: [] }
      : prepared.result;
  }
  throw new Error(`cron run recovery changed repeatedly for job ${proposal.jobId}`);
}

/** Schedules only authoritative rows that are not protected by an active run. */
export function recomputeUnownedCronSchedules(
  state: CronServiceState,
  opts?: Omit<CronMaintenanceOptions, "deferredNotifications">,
): {
  changed: boolean;
  jobs: CronJob[];
  notifications: DeferredCronNotifications;
} {
  const storeKey = cronStoreKey(state.deps.storePath);
  const nowMs = state.deps.nowMs();
  const result = runOpenClawStateWriteTransaction(
    ({ db }) => {
      const notifications: DeferredCronNotifications = [];
      let changed = false;
      const jobs: CronJob[] = [];
      const rows = loadCronRows(db, storeKey);
      const decodedJobs = loadedCronStoreFromRows(rows).store.jobs;
      const jobsById = new Map(decodedJobs.map((job) => [job.id, job]));
      const activeJobIds = listActiveCronRunReceiptJobIdsInDatabase(db, state.deps.storePath);
      for (const row of rows) {
        if (activeJobIds.has(row.job_id)) {
          continue;
        }
        const job = jobsById.get(row.job_id);
        if (!job) {
          continue;
        }
        if (
          recomputeSingleJobForMaintenance(state, job, {
            ...opts,
            nowMs: opts?.nowMs ?? nowMs,
            deferredNotifications: notifications,
          })
        ) {
          upsertCronJobRow(db, storeKey, job, row.sort_order);
          jobs.push(job);
          changed = true;
        }
      }
      return { changed, jobs, notifications };
    },
    {},
    { operationLabel: "cron.schedule-unowned" },
  );
  if (result.changed) {
    noteCronJobsStoreCommit(storeKey);
  }
  return result;
}
