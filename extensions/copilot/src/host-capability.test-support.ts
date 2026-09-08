import { createOpenClawCodingTools } from "openclaw/plugin-sdk/agent-harness";
import type { AgentHarnessAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";

type TestHostCapabilities = NonNullable<AgentHarnessAttemptParamsV2["hostCapabilities"]>;
type TestTranscriptCommit = () => Promise<{
  kind: "rejected";
  reason: string;
}>;
type TranscriptCapableTestHostCapabilities = TestHostCapabilities &
  Readonly<{
    commitProviderTranscriptPrefix: TestTranscriptCommit;
  }>;

/** Exact published v2026.9.2 host shape before either newer capability shipped. */
export function createCopilotStableHostCapabilitiesV2026_9_2(): TestHostCapabilities {
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

/** Minimal modern host authority for tests that do not exercise host policy or approvals. */
export function createCopilotTestHostCapabilities(): TranscriptCapableTestHostCapabilities {
  const commitProviderTranscriptPrefix: TestTranscriptCommit = async () => ({
    kind: "rejected",
    reason: "test host transcript commit is not configured",
  });
  return Object.freeze({
    ...createCopilotStableHostCapabilitiesV2026_9_2(),
    commitProviderTranscriptPrefix,
    createToolSurface: (options) => createOpenClawCodingTools(options),
  });
}

/** Constructor-less test host that retains every other modern capability. */
export function createCopilotConstructorlessTestHostCapabilities(): TranscriptCapableTestHostCapabilities {
  const { createToolSurface: _createToolSurface, ...hostCapabilities } =
    createCopilotTestHostCapabilities();
  return Object.freeze(hostCapabilities);
}
