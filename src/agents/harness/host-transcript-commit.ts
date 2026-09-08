import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CodeModeTranscriptAuthority } from "../code-mode-transcript-authority.js";
import type { EmbeddedRunAttemptParams } from "../embedded-agent-runner/run/types.js";
import { redactTranscriptMessage } from "../transcript-redact.js";
import { runAgentHarnessBeforeMessageWriteHook } from "./hook-helpers.js";
import type { AgentHarnessHostCapabilities } from "./host-capability-types.js";
import { projectAgentHarnessTranscriptMessageForDisplay } from "./transcript-visibility.js";

type TranscriptAttempt = Pick<
  Partial<EmbeddedRunAttemptParams>,
  "agentId" | "prepareAssistantTranscriptMessage" | "sessionKey" | "trigger"
>;

export function createHostTranscriptCommit(params: {
  assertActive: () => void;
  attempt: TranscriptAttempt;
  config?: OpenClawConfig;
  transcriptAuthority?: CodeModeTranscriptAuthority;
}): AgentHarnessHostCapabilities["commitProviderTranscriptPrefix"] {
  const { transcriptAuthority } = params;
  if (!transcriptAuthority) {
    return undefined;
  }
  return async (prefix) => {
    const assertCommitCurrent = () => {
      params.assertActive();
      prefix.assertCurrent();
    };
    assertCommitCurrent();
    return await transcriptAuthority.commitPrefix(
      { ...prefix, assertCurrent: assertCommitCurrent },
      (message) => {
        // Hooks may rewrite content, but cannot erase producer provenance or
        // mutate its nested source facts before the atomic transcript commit.
        const originalMetadata = asOptionalRecord(Reflect.get(message, "__openclaw"));
        const hooked = runAgentHarnessBeforeMessageWriteHook({
          agentId: params.attempt.agentId,
          message: structuredClone(message),
          prepareAssistantTranscriptMessage: params.attempt.prepareAssistantTranscriptMessage,
          sessionKey: params.attempt.sessionKey,
        });
        assertCommitCurrent();
        if (!hooked) {
          return null;
        }
        const prepared = originalMetadata
          ? {
              ...hooked,
              __openclaw: {
                ...asOptionalRecord(Reflect.get(hooked, "__openclaw")),
                ...originalMetadata,
              },
            }
          : hooked;
        return projectAgentHarnessTranscriptMessageForDisplay({
          hidden: params.attempt.trigger === "memory",
          message: redactTranscriptMessage(prepared, params.config),
        });
      },
    );
  };
}
