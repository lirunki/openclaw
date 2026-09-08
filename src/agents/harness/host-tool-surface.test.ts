import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { createHostCurrentTurnDeliveryOwner } from "./host-tool-surface.js";

function createCurrentTurnDelivery() {
  return createHostCurrentTurnDeliveryOwner({
    abortSignal: new AbortController().signal,
    assertActive: () => {},
    attempt: {
      agentId: "main",
      config: { tools: { codeMode: { enabled: true } } } as OpenClawConfig,
      model: { compat: { supportsTools: true } },
      modelId: "gpt-test",
      provider: "openai",
      sessionKey: "agent:main:telegram:direct:123",
    } as never,
    sessionTarget: {
      agentId: "main",
      expectedWriterRunId: "run-1",
      sessionId: "session-1",
      sessionKey: "agent:main:telegram:direct:123",
      storePath: "/state/sessions.json",
    },
  });
}

describe("agent harness host tool surface", () => {
  it("keeps delivery authority independent from terminal-result capability", () => {
    const construct = createCurrentTurnDelivery();

    const ordinaryDelivery = construct();
    const terminalDelivery = construct({ terminalCompletion: "per-result" });

    expect(ordinaryDelivery).toEqual({
      authority: expect.objectContaining({
        abortSignal: expect.any(AbortSignal),
        assertSessionWriterCurrent: expect.any(Function),
      }),
    });
    expect(terminalDelivery).toEqual({
      authority: ordinaryDelivery?.authority,
      toolRef: {},
    });
  });
});
