import {
  MessageChannel,
  receiveMessageOnPort,
  Worker,
  type MessagePort,
} from "node:worker_threads";
import {
  STORAGE_SYNC_BRIDGE_PROTOCOL_VERSION,
  type SerializedStorageSyncBridgeError,
  type StorageSyncBridgeDomain,
  type StorageSyncBridgeRequest,
  type StorageSyncBridgeResponse,
  type StorageSyncBridgeWorkerData,
} from "./storage-sync-bridge-protocol.js";

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_PAYLOAD_BYTES = 256 * 1024 * 1024;
const RESPONSE_SIGNAL_INDEX = 0;
const MAX_REQUEST_ID = 0x7fff_ffff;

export class StorageSyncBridgeTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageSyncBridgeTimeoutError";
  }
}

export class StorageSyncBridgeRemoteError extends Error {
  readonly remote: SerializedStorageSyncBridgeError;

  constructor(remote: SerializedStorageSyncBridgeError) {
    super(remote.message);
    this.name = remote.name;
    this.remote = remote;
  }
}

type BridgeGeneration = {
  generation: number;
  worker: Worker;
  port: MessagePort;
  signal: Int32Array;
  nextRequestId: number;
  poisoned: boolean;
  failure?: Error;
  termination?: Promise<number>;
};

type StorageSyncBridgeClientOptions = {
  workerUrl: URL;
  workerExecArgv?: string[];
  defaultTimeoutMs?: number;
  maxPayloadBytes?: number;
};

function workerFailure(message: string, cause?: unknown): Error {
  return new Error(message, cause === undefined ? undefined : { cause });
}

export class StorageSyncBridgeClient {
  private activeBridge: BridgeGeneration | undefined;
  private nextGeneration = 1;
  private readonly retiringBridges = new Set<Promise<number>>();
  private readonly defaultTimeoutMs: number;
  private readonly maxPayloadBytes: number;

  constructor(private readonly options: StorageSyncBridgeClientOptions) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  }

  private retireBridge(bridge: BridgeGeneration, failure?: Error): Promise<number> {
    bridge.poisoned = true;
    bridge.failure ??= failure;
    if (this.activeBridge === bridge) {
      this.activeBridge = undefined;
    }
    bridge.port.close();
    if (!bridge.termination) {
      const termination = bridge.worker.terminate();
      bridge.termination = termination;
      this.retiringBridges.add(termination);
      void termination.then(
        () => this.retiringBridges.delete(termination),
        () => this.retiringBridges.delete(termination),
      );
    }
    return bridge.termination;
  }

  private createBridge(): BridgeGeneration {
    const generation = this.nextGeneration++;
    const { port1, port2 } = new MessageChannel();
    const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    const worker = new Worker(this.options.workerUrl, {
      workerData: {
        generation,
        port: port2,
        signal: signal.buffer,
        maxResponseBytes: this.maxPayloadBytes,
      } satisfies StorageSyncBridgeWorkerData,
      transferList: [port2],
      execArgv: this.options.workerExecArgv,
    });
    const bridge: BridgeGeneration = {
      generation,
      worker,
      port: port1,
      signal,
      nextRequestId: 1,
      poisoned: false,
    };
    port1.unref();
    worker.unref();
    worker.on("error", (error) => {
      void this.retireBridge(bridge, workerFailure("Storage compatibility worker failed.", error));
    });
    worker.on("exit", (code) => {
      if (!bridge.poisoned) {
        void this.retireBridge(
          bridge,
          workerFailure(`Storage compatibility worker exited unexpectedly with code ${code}.`),
        );
      }
    });
    this.activeBridge = bridge;
    return bridge;
  }

  private getBridge(): BridgeGeneration {
    if (this.retiringBridges.size > 0) {
      throw workerFailure("Storage compatibility worker replacement is still in progress.");
    }
    const current = this.activeBridge;
    if (current && !current.poisoned && current.nextRequestId <= MAX_REQUEST_ID) {
      return current;
    }
    if (current) {
      void this.retireBridge(current);
    }
    return this.createBridge();
  }

  private decodeResponse(raw: unknown, bridge: BridgeGeneration, requestId: number): unknown {
    if (typeof raw !== "string") {
      throw workerFailure("Storage compatibility worker returned a non-text response.");
    }
    let response: StorageSyncBridgeResponse;
    try {
      // SAFETY: the worker emits the closed protocol and the identity fields are validated below.
      response = JSON.parse(raw) as StorageSyncBridgeResponse;
    } catch (error) {
      throw workerFailure("Storage compatibility worker returned invalid JSON.", error);
    }
    if (
      response.protocolVersion !== STORAGE_SYNC_BRIDGE_PROTOCOL_VERSION ||
      response.generation !== bridge.generation ||
      response.requestId !== requestId
    ) {
      throw workerFailure("Storage compatibility worker returned a mismatched response.");
    }
    if (!response.ok) {
      throw new StorageSyncBridgeRemoteError(response.error);
    }
    return response.value;
  }

  request<T>(params: {
    domain: StorageSyncBridgeDomain;
    payload: unknown;
    timeoutMs?: number;
    maxPayloadBytes?: number;
  }): T {
    const bridge = this.getBridge();
    if (bridge.failure) {
      throw bridge.failure;
    }
    const requestId = bridge.nextRequestId++;
    const request: StorageSyncBridgeRequest = {
      protocolVersion: STORAGE_SYNC_BRIDGE_PROTOCOL_VERSION,
      generation: bridge.generation,
      requestId,
      domain: params.domain,
      payload: params.payload,
    };
    let encoded: string;
    try {
      encoded = JSON.stringify(request);
    } catch (error) {
      throw workerFailure("Storage compatibility request is not serializable.", error);
    }
    const maxPayloadBytes = params.maxPayloadBytes ?? this.maxPayloadBytes;
    if (Buffer.byteLength(encoded, "utf8") > maxPayloadBytes) {
      throw workerFailure("Storage compatibility request exceeds the payload limit.");
    }
    const previousSignal = Atomics.load(bridge.signal, RESPONSE_SIGNAL_INDEX);
    try {
      bridge.port.postMessage(encoded);
    } catch (error) {
      const failure = workerFailure("Storage compatibility worker request failed.", error);
      void this.retireBridge(bridge, failure);
      throw failure;
    }
    const timeoutMs = params.timeoutMs ?? this.defaultTimeoutMs;
    const waitResult = Atomics.wait(
      bridge.signal,
      RESPONSE_SIGNAL_INDEX,
      previousSignal,
      timeoutMs,
    );
    if (
      waitResult === "timed-out" &&
      Atomics.load(bridge.signal, RESPONSE_SIGNAL_INDEX) !== requestId
    ) {
      const error = new StorageSyncBridgeTimeoutError(
        `Storage compatibility worker timed out after ${timeoutMs}ms; the commit outcome is unknown.`,
      );
      void this.retireBridge(bridge, error);
      throw error;
    }
    if (Atomics.load(bridge.signal, RESPONSE_SIGNAL_INDEX) !== requestId) {
      const error = workerFailure("Storage compatibility worker signaled an unexpected response.");
      void this.retireBridge(bridge, error);
      throw error;
    }
    const received = receiveMessageOnPort(bridge.port)?.message;
    try {
      // SAFETY: each closed domain command fixes its response type at the call site.
      return this.decodeResponse(received, bridge, requestId) as T;
    } catch (error) {
      if (!(error instanceof StorageSyncBridgeRemoteError)) {
        void this.retireBridge(
          bridge,
          error instanceof Error
            ? error
            : workerFailure("Storage compatibility worker response failed.", error),
        );
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    const bridge = this.activeBridge;
    if (!bridge) {
      await Promise.allSettled([...this.retiringBridges]);
      return;
    }
    try {
      this.request<void>({
        domain: "control",
        payload: { operation: "close" },
      });
    } finally {
      await this.retireBridge(bridge);
      await Promise.allSettled([...this.retiringBridges]);
    }
  }
}
