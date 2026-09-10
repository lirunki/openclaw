import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  closeDatabases: vi.fn(async () => undefined),
  createStore: vi.fn(),
  resolveOptions: vi.fn(),
  resolveSecret: vi.fn(async (_ref: unknown, context: { env: NodeJS.ProcessEnv }) =>
    String(context.env.TEST_TOKEN ?? ""),
  ),
}));

vi.mock("../secrets/resolve.js", () => ({
  resolveSecretRefString: mocks.resolveSecret,
}));
vi.mock("../storage/plugin-state-runtime-options.js", () => ({
  resolvePluginStateRuntimeOptions: mocks.resolveOptions,
}));
vi.mock("../storage/plugin-state-store-factory.js", () => ({
  closePluginStateAzureSqlDatabases: mocks.closeDatabases,
  createAzureSqlPluginStateStore: mocks.createStore,
}));

import {
  closePluginStateSyncBridgeHandler,
  handlePluginStateSyncBridgeRequest,
} from "./plugin-state-sync-bridge-handler.js";

const scope = {
  pluginId: "discord",
  namespace: "bindings",
  maxEntries: 10,
  overflowPolicy: "reject-new" as const,
};

function envelope(env: NodeJS.ProcessEnv = {}) {
  return {
    config: {
      storage: {
        backend: "azuresql" as const,
        azureSql: { server: "sql.example.invalid", database: "openclaw" },
      },
    },
    env,
    request: { operation: "lookupRaw" as const, scope, key: "thread:1" },
  };
}

function store(value: unknown) {
  return {
    lookupRaw: vi.fn(async () => value),
  };
}

afterEach(async () => {
  await closePluginStateSyncBridgeHandler();
  mocks.closeDatabases.mockClear();
  mocks.createStore.mockReset();
  mocks.resolveOptions.mockReset();
  mocks.resolveSecret.mockClear();
});

describe("plugin-state synchronous bridge handler", () => {
  it("reuses the factory-owned store while its connection identity is unchanged", async () => {
    const current = store({ key: "thread:1" });
    const options = { storage: envelope().config.storage };
    mocks.resolveOptions.mockResolvedValue(options);
    mocks.createStore.mockReturnValue(current);

    await handlePluginStateSyncBridgeRequest(envelope());
    await handlePluginStateSyncBridgeRequest(envelope());

    expect(current.lookupRaw).toHaveBeenCalledTimes(2);
    expect(mocks.closeDatabases).not.toHaveBeenCalled();
  });

  it("closes stale pools before adopting a changed connection identity", async () => {
    const previous = store({ key: "old" });
    const changed = store({ key: "new" });
    mocks.resolveOptions.mockResolvedValue({ storage: envelope().config.storage });
    mocks.createStore
      .mockReturnValueOnce(previous)
      .mockReturnValueOnce(changed)
      .mockReturnValue(changed);

    await handlePluginStateSyncBridgeRequest(envelope());
    await handlePluginStateSyncBridgeRequest(envelope());

    expect(mocks.closeDatabases).toHaveBeenCalledOnce();
    expect(changed.lookupRaw).toHaveBeenCalledOnce();
  });

  it("keeps secret-backed token resolution bound to the latest request context", async () => {
    const current = store(undefined);
    const credential = { source: "env" as const, provider: "default", id: "TEST_TOKEN" };
    mocks.resolveOptions.mockImplementation(
      async (config: ReturnType<typeof envelope>["config"]) => ({
        storage: {
          ...config.storage,
          azureSql: { ...config.storage.azureSql, credential },
        },
        azureSqlSecretResolver: vi.fn(),
      }),
    );
    mocks.createStore.mockReturnValue(current);

    await handlePluginStateSyncBridgeRequest(envelope({ TEST_TOKEN: "old" }));
    const firstOptions = mocks.createStore.mock.calls[0]?.[0];
    await handlePluginStateSyncBridgeRequest(envelope({ TEST_TOKEN: "new" }));

    await expect(firstOptions.azureSqlSecretResolver(credential)).resolves.toBe("new");
  });
});
