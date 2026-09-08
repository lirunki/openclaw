import { createOpenClawCodingTools } from "openclaw/plugin-sdk/agent-harness";
import type { AgentHarnessAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";

/** Published v2026.9.2 host shape, before provider transcript commit was promoted. */
export function createCopilotStableHostCapabilitiesV2026_9_2(): AgentHarnessAttemptParamsV2["hostCapabilities"] {
  return Object.freeze({
    kind: "agent-harness-host-capability",
    version: 1,
    assertActive: () => {},
    bindToolSurface: (tools) => tools,
    runBeforeToolCall: async (request) => ({ blocked: false, params: request.params }),
    requestApproval: async () => undefined,
    waitForApproval: async () => undefined,
  });
}

/** Minimal host authority for tests that do not exercise host policy or approvals. */
export function createCopilotTestHostCapabilities(): AgentHarnessAttemptParamsV2["hostCapabilities"] {
  return Object.freeze({
    ...createCopilotStableHostCapabilitiesV2026_9_2(),
    createToolSurface: (options) => createOpenClawCodingTools(options),
    commitProviderTranscriptPrefix: async () => ({
      kind: "rejected",
      reason: "test host transcript commit is not configured",
    }),
  });
}
