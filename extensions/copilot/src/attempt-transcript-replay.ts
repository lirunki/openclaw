import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { AttemptParamsLike } from "./attempt-types.js";

type TranscriptRecorder = NonNullable<AttemptParamsLike["userTurnTranscriptRecorder"]>;
type TurnTaintMetadata = { resultContentSource?: "network"; turnTainted?: true };

export type AttemptTranscriptMessage =
  | NonNullable<TranscriptRecorder["message"]>
  | Extract<AgentMessage, { role: "assistant" | "toolResult" }>;

export function readTurnTaintMetadata(message: AgentMessage): TurnTaintMetadata | undefined {
  const metadata = (message as unknown as Record<string, unknown>)["__openclaw"];
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as TurnTaintMetadata)
    : undefined;
}

export function isActiveTurnTainted(messages: readonly AgentMessage[]): boolean {
  for (const message of messages.toReversed()) {
    if (message.role === "user") {
      return false;
    }
    const metadata = readTurnTaintMetadata(message);
    if (metadata?.turnTainted === true || metadata?.resultContentSource === "network") {
      return true;
    }
  }
  return false;
}

export function withAssistantTurnTaint(
  message: Extract<AgentMessage, { role: "assistant" }>,
  tainted: boolean,
) {
  return tainted
    ? ({
        ...message,
        __openclaw: { ...readTurnTaintMetadata(message), turnTainted: true },
      } as typeof message)
    : message;
}

export function readIdempotencyKey(message: AgentMessage): string | undefined {
  const key = (message as { idempotencyKey?: unknown }).idempotencyKey;
  return typeof key === "string" && key ? key : undefined;
}

export function isCurrentJournalIdentity(
  key: string,
  params: { attempt: AttemptParamsLike; sdkSessionId: string },
): boolean {
  // Old mirror keys can be content fingerprints and are not turn identity.
  // Current journal keys use a run id or the SDK's unique event id.
  return (
    key === `${params.attempt.runId}:user` || key.startsWith(`copilot-sdk:${params.sdkSessionId}:`)
  );
}

export function isSameUserTurn(
  candidate: AgentMessage | undefined,
  current: Extract<AgentMessage, { role: "user" }> | undefined,
  currentRunUserKey: string,
): boolean {
  if (candidate?.role !== "user" || !current) {
    return false;
  }
  if (candidate === current) {
    return true;
  }
  const candidateKey = (candidate as { idempotencyKey?: unknown }).idempotencyKey;
  const currentKey = (current as { idempotencyKey?: unknown }).idempotencyKey;
  if (typeof candidateKey === "string" || typeof currentKey === "string") {
    if (typeof candidateKey === "string" && typeof currentKey === "string") {
      return candidateKey === currentKey;
    }
    if (
      typeof candidateKey !== "string" ||
      typeof currentKey === "string" ||
      (!candidateKey.startsWith("copilot:") && candidateKey !== currentRunUserKey)
    ) {
      return false;
    }
  }
  // The embedded-runner boundary identifies the active user as the last user
  // and stamps it with this recorder timestamp; historical turns are ineligible.
  return (
    candidate.timestamp === current.timestamp &&
    userText(candidate.content) === userText(current.content)
  );
}

export function userText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content) && content.length === 1) {
    const part = content[0] as { text?: unknown; type?: unknown };
    if (part?.type === "text" && typeof part.text === "string") {
      return part.text;
    }
  }
  return JSON.stringify(content) ?? "";
}

export function isAttemptTranscriptMessage(value: unknown): value is AttemptTranscriptMessage {
  const message = asOptionalRecord(value);
  if (message?.role === "user") {
    return typeof message.content === "string" || Array.isArray(message.content);
  }
  if (message?.role === "assistant") {
    return Array.isArray(message.content);
  }
  return (
    message?.role === "toolResult" &&
    Array.isArray(message.content) &&
    typeof message.toolCallId === "string" &&
    typeof message.toolName === "string" &&
    typeof message.isError === "boolean"
  );
}

function readAssistantToolCallIds(message: AttemptTranscriptMessage): string[] {
  return message.role === "assistant"
    ? message.content.flatMap((part) => (part.type === "toolCall" ? [part.id] : []))
    : [];
}

export function isCompatibleSingletonRewrite(
  original: AttemptTranscriptMessage,
  prepared: AttemptTranscriptMessage,
): boolean {
  // Hooks may redact content, but role and tool topology are journal-owned;
  // accepting either rewrite would make the canonical replay structurally false.
  return (
    original.role === prepared.role &&
    (original.role !== "assistant" ||
      JSON.stringify(readAssistantToolCallIds(original)) ===
        JSON.stringify(readAssistantToolCallIds(prepared)))
  );
}

export function projectReplayPayload(message: AttemptTranscriptMessage): unknown {
  switch (message.role) {
    case "user":
      return { role: message.role, content: message.content };
    case "assistant":
      return {
        role: message.role,
        content: message.content,
        api: message.api,
        model: message.model,
        provider: message.provider,
        stopReason: message.stopReason,
      };
    case "toolResult":
      return {
        role: message.role,
        content: message.content,
        isError: message.isError,
        toolCallId: message.toolCallId,
        toolName: message.toolName,
      };
  }
  return undefined;
}

export function isCompleteToolGroup(
  messages: readonly AttemptTranscriptMessage[],
  order: readonly string[],
): boolean {
  const [assistant, ...results] = messages;
  return (
    assistant?.role === "assistant" &&
    JSON.stringify(readAssistantToolCallIds(assistant)) === JSON.stringify(order) &&
    results.length === order.length &&
    results.every(
      (message, index) => message.role === "toolResult" && message.toolCallId === order[index],
    )
  );
}
