import { afterEach, describe, expect, it, vi } from "vitest";

const childState = vi.hoisted(() => ({
  spawnSync: vi.fn(),
  result: {
    pid: 123,
    output: [],
    stdout: '{"ok":true}',
    stderr: "",
    status: 0,
    signal: null,
  },
}));

vi.mock("node:child_process", () => ({
  spawnSync: (...args: unknown[]) => {
    childState.spawnSync(...args);
    return childState.result;
  },
}));

import { AzureSqlPluginStateSyncBridge } from "./plugin-state-sync-bridge.js";

const config = {
  storage: {
    backend: "azuresql" as const,
    azureSql: { server: "sql.example.invalid", database: "openclaw" },
  },
};

const scope = {
  pluginId: "discord",
  namespace: "bindings",
  maxEntries: 10,
  overflowPolicy: "reject-new" as const,
};

afterEach(() => {
  childState.spawnSync.mockReset();
  childState.result = {
    pid: 123,
    output: [],
    stdout: '{"ok":true}',
    stderr: "",
    status: 0,
    signal: null,
  };
});

describe("AzureSqlPluginStateSyncBridge", () => {
  it("blocks until the bridge process returns the durable value", () => {
    childState.result.stdout = JSON.stringify({
      ok: true,
      value: {
        key: "thread:1",
        valueJson: '{"session":"main"}',
        createdAt: 1,
        expiresAt: null,
      },
    });

    const bridge = new AzureSqlPluginStateSyncBridge(config, {}, scope);
    expect(bridge.lookup("thread:1")).toEqual({ session: "main" });
    expect(childState.spawnSync).toHaveBeenCalledWith(
      process.execPath,
      expect.any(Array),
      expect.objectContaining({ stdio: ["pipe", "pipe", "inherit"] }),
    );
  });

  it("restores typed plugin-state failures from the process", () => {
    childState.result.stdout = JSON.stringify({
      ok: false,
      error: {
        name: "PluginStateStoreError",
        message: "capacity reached",
        code: "PLUGIN_STATE_LIMIT_EXCEEDED",
        operation: "register",
      },
    });

    const bridge = new AzureSqlPluginStateSyncBridge(config, {}, scope);
    expect(() => bridge.register({ key: "thread:1", valueJson: "{}" })).toThrow(
      expect.objectContaining({
        code: "PLUGIN_STATE_LIMIT_EXCEEDED",
        operation: "register",
      }),
    );
  });

  it("fails immediately when the bridge process cannot start", () => {
    childState.result = {
      pid: 0,
      output: [],
      stdout: "",
      stderr: "",
      status: null,
      signal: null,
      error: new Error("spawn failed"),
    };

    const bridge = new AzureSqlPluginStateSyncBridge(config, {}, scope);
    expect(() => bridge.lookup("thread:1")).toThrow("bridge process failed");
  });
});
