import type mssql from "mssql";
import { describe, expect, it } from "vitest";
import {
  AzureSqlDatabase,
  type AzureSqlPoolFactory,
  type AzureSqlRequest,
  type AzureSqlResult,
} from "./runtime.js";

type FakeRequestResult = { rows: unknown[]; rowsAffected: number[] };

class FakeRequest implements AzureSqlRequest {
  readonly inputs = new Map<string, unknown>();
  cancelled = false;

  constructor(private readonly result: FakeRequestResult) {}

  input(name: string, valueOrType: unknown, value?: unknown): AzureSqlRequest {
    this.inputs.set(name, value === undefined ? valueOrType : value);
    return this;
  }

  async query<Row>(): Promise<AzureSqlResult<Row> | mssql.IResult<Row>> {
    return this.result as AzureSqlResult<Row>;
  }

  cancel(): void {
    this.cancelled = true;
  }
}

function createFakePoolFactory(
  options: {
    connectError?: { code: string; message: string };
    queryResult?: FakeRequestResult;
    transactionResult?: FakeRequestResult;
    commitError?: Error;
    onConfig?: (config: unknown) => void;
  } = {},
): AzureSqlPoolFactory {
  return (config) => {
    options.onConfig?.(config);
    let connected = false;
    return {
      connected: false,
      connecting: false,
      healthy: false,
      async connect() {
        if (options.connectError) {
          throw Object.assign(new Error(options.connectError.message), {
            code: options.connectError.code,
          });
        }
        connected = true;
        return this;
      },
      request() {
        return new FakeRequest(options.queryResult ?? { rows: [], rowsAffected: [] });
      },
      transaction() {
        let committed = false;
        let rolledBack = false;
        return {
          async begin() {
            if (!connected) {
              throw new Error("transaction started before connection");
            }
          },
          async commit() {
            committed = true;
            if (options.commitError) {
              throw options.commitError;
            }
          },
          async rollback() {
            rolledBack = true;
          },
          request() {
            if (committed || rolledBack) {
              throw new Error("transaction is closed");
            }
            return new FakeRequest(options.transactionResult ?? { rows: [], rowsAffected: [] });
          },
        };
      },
      async close() {
        connected = false;
      },
    };
  };
}

describe("AzureSqlDatabase", () => {
  it("builds a Linux-neutral encrypted token-credential pool and reuses the connection", async () => {
    let observedConfig: unknown;
    let connects = 0;
    const factory: AzureSqlPoolFactory = (config) => {
      observedConfig = config;
      const pool = createFakePoolFactory({
        queryResult: { rows: [{ value: 1 }], rowsAffected: [] },
      })(config);
      const connect = pool.connect.bind(pool);
      pool.connect = async () => {
        connects += 1;
        return await connect();
      };
      return pool;
    };
    const database = new AzureSqlDatabase(
      { server: "localhost", database: "openclaw-test" },
      factory,
    );

    await expect(database.query<{ value: number }>("SELECT 1")).resolves.toEqual({
      rows: [{ value: 1 }],
      rowsAffected: [],
    });
    await database.query("SELECT 1");

    expect(connects).toBe(1);
    expect(observedConfig).toMatchObject({
      server: "localhost",
      database: "openclaw-test",
      authentication: { type: "token-credential" },
      options: { encrypt: true, trustServerCertificate: false },
    });
    await database.close();
  });

  it("configures SQL password authentication only when explicitly supplied", async () => {
    let observedConfig: unknown;
    const database = new AzureSqlDatabase(
      {
        server: "localhost",
        database: "openclaw-test",
        sqlPassword: { username: "openclaw_experiment", password: "test-only-password" },
      },
      createFakePoolFactory({ onConfig: (config) => (observedConfig = config) }),
    );

    await database.connect();
    expect(observedConfig).toMatchObject({
      user: "openclaw_experiment",
      password: "test-only-password",
    });
    expect(observedConfig).not.toHaveProperty("authentication");
  });

  it("runs a health probe through the same pooled query path", async () => {
    const database = new AzureSqlDatabase(
      { server: "localhost", database: "openclaw-test" },
      createFakePoolFactory({ queryResult: { rows: [{ ok: 1 }], rowsAffected: [] } }),
    );

    await expect(database.checkHealth()).resolves.toBeUndefined();
  });

  it("commits a transaction after the operation succeeds", async () => {
    let committed = false;
    let rolledBack = false;
    const factory: AzureSqlPoolFactory = (config) => {
      const pool = createFakePoolFactory()(config);
      const transaction = pool.transaction.bind(pool);
      pool.transaction = () => {
        const current = transaction();
        const commit = current.commit.bind(current);
        const rollback = current.rollback.bind(current);
        current.commit = async () => {
          committed = true;
          await commit();
        };
        current.rollback = async () => {
          rolledBack = true;
          await rollback();
        };
        return current;
      };
      return pool;
    };
    const database = new AzureSqlDatabase(
      { server: "localhost", database: "openclaw-test" },
      factory,
    );

    await expect(
      database.transaction(async (transaction) => {
        await transaction.query("UPDATE projects SET display_name = @name", (request) => {
          request.input("name", "OpenClaw");
        });
        return "committed";
      }),
    ).resolves.toBe("committed");

    expect(committed).toBe(true);
    expect(rolledBack).toBe(false);
  });

  it("surfaces an ambiguous commit after best-effort cleanup without marking it retryable", async () => {
    let rolledBack = false;
    const factory: AzureSqlPoolFactory = (config) => {
      const pool = createFakePoolFactory({
        commitError: Object.assign(new Error("connection lost after commit request"), {
          code: "ESOCKET",
        }),
      })(config);
      const transaction = pool.transaction.bind(pool);
      pool.transaction = () => {
        const current = transaction();
        const rollback = current.rollback.bind(current);
        current.rollback = async () => {
          rolledBack = true;
          await rollback();
        };
        return current;
      };
      return pool;
    };
    const database = new AzureSqlDatabase(
      { server: "localhost", database: "openclaw-test" },
      factory,
    );

    const error = await database
      .transaction(async () => "written")
      .catch((value: unknown) => value);
    expect(error).toMatchObject({ kind: "ambiguous-commit", retryable: false });
    expect((error as Error).message).toContain("reconcile before retrying");
    expect(rolledBack).toBe(true);
  });

  it("rolls back when a transaction operation fails", async () => {
    let rolledBack = false;
    const factory: AzureSqlPoolFactory = (config) => {
      const pool = createFakePoolFactory()(config);
      const transaction = pool.transaction.bind(pool);
      pool.transaction = () => {
        const current = transaction();
        const rollback = current.rollback.bind(current);
        current.rollback = async () => {
          rolledBack = true;
          await rollback();
        };
        return current;
      };
      return pool;
    };
    const database = new AzureSqlDatabase(
      { server: "localhost", database: "openclaw-test" },
      factory,
    );

    await expect(
      database.transaction(async () => {
        throw new Error("synthetic transaction failure");
      }),
    ).rejects.toThrow("synthetic transaction failure");
    expect(rolledBack).toBe(true);
  });

  it("classifies authentication failures without exposing the original error", async () => {
    const database = new AzureSqlDatabase(
      { server: "localhost", database: "openclaw-test" },
      createFakePoolFactory({ connectError: { code: "ELOGIN", message: "secret-token=redacted" } }),
    );

    const error = await database.connect().catch((value: unknown) => value);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("AzureSqlStorageError");
    expect(error).toMatchObject({ kind: "authentication", retryable: false });
    expect((error as Error).message).toBe("Azure SQL authentication failed.");
  });
});
