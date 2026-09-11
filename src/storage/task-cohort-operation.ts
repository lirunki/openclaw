import { createHash, randomUUID } from "node:crypto";
import { stableStringify } from "@openclaw/normalization-core";

const TASK_COHORT_OPERATION_VERSION = 1;
const TASK_COHORT_OPERATION_PREFIX = `task-cohort-v${TASK_COHORT_OPERATION_VERSION}`;
const TASK_COHORT_OPERATION_ID_PATTERN =
  /^task-cohort-v1:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):sha256:([0-9a-f]{64})$/;

export type TaskCohortOperationKind =
  | "commit-task-state"
  | "bind-task-execution"
  | "admit-subagent-completion"
  | "settle-subagent-completion"
  | "block-subagent-completion"
  | "replace-subagent-task"
  | "recover-cron-run";

type OperationCommand = Readonly<{ operationId: string }>;

function transportCanonicalValue(value: unknown): unknown {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new TypeError("Task cohort operation command is not JSON serializable.");
  }
  return JSON.parse(encoded) as unknown;
}

function operationDigest(params: {
  kind: TaskCohortOperationKind;
  nonce: string;
  command: unknown;
}): string {
  return createHash("sha256")
    .update(
      stableStringify({
        version: TASK_COHORT_OPERATION_VERSION,
        kind: params.kind,
        nonce: params.nonce,
        command: transportCanonicalValue(params.command),
      }),
    )
    .digest("hex");
}

/** Adds one self-validating correlation ID to a prepared JSON-safe command. */
export function prepareTaskCohortOperation<Body extends object>(
  kind: TaskCohortOperationKind,
  command: Body & Readonly<{ operationId?: never }>,
): Readonly<Body & { operationId: string }> {
  const nonce = randomUUID();
  const digest = operationDigest({ kind, nonce, command });
  return {
    ...command,
    operationId: `${TASK_COHORT_OPERATION_PREFIX}:${nonce}:sha256:${digest}`,
  };
}

/** Validates correlation integrity only; a valid ID is not evidence of commit. */
export function isValidTaskCohortOperation(
  kind: TaskCohortOperationKind,
  command: OperationCommand,
): boolean {
  const match = TASK_COHORT_OPERATION_ID_PATTERN.exec(command.operationId);
  if (!match) {
    return false;
  }
  const [, nonce, expectedDigest] = match;
  if (!nonce || !expectedDigest) {
    return false;
  }
  const { operationId: _operationId, ...body } = command;
  try {
    return operationDigest({ kind, nonce, command: body }) === expectedDigest;
  } catch {
    return false;
  }
}
