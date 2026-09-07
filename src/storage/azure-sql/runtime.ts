import { DefaultAzureCredential } from "@azure/identity";
import mssql from "mssql";

type AzureSqlToken = {
  token: string;
  expiresOnTimestamp: number;
};

export type AzureSqlTokenCredential = {
  getToken(
    scopes: string | string[],
    options?: { abortSignal?: AbortSignal },
  ): Promise<AzureSqlToken | null>;
};

export type AzureSqlConnectionOptions = {
  server: string;
  database: string;
  port?: number;
  credential?: AzureSqlTokenCredential;
  sqlPassword?: {
    username: string;
    password: string;
  };
  connectionTimeoutMs?: number;
  requestTimeoutMs?: number;
  cancelTimeoutMs?: number;
  pool?: {
    max?: number;
    min?: number;
    idleTimeoutMs?: number;
  };
};

export type AzureSqlResult<Row> = {
  rows: Row[];
  rowsAffected: readonly number[];
};

type AzureSqlDriverResult<Row> = AzureSqlResult<Row> | mssql.IResult<Row>;

export type AzureSqlRequest = {
  input(name: string, value: unknown): AzureSqlRequest;
  input(name: string, type: mssql.ISqlType, value: unknown): AzureSqlRequest;
  query<Row>(text: string): Promise<AzureSqlDriverResult<Row>>;
  cancel(): void;
};

export type AzureSqlTransaction = {
  query<Row>(text: string, bind?: (request: AzureSqlRequest) => void): Promise<AzureSqlResult<Row>>;
};

type AzureSqlTransactionHandle = {
  begin(isolationLevel?: number): Promise<unknown>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  request(): AzureSqlRequest;
};

type AzureSqlPool = {
  connected: boolean;
  connecting: boolean;
  healthy: boolean;
  request(): AzureSqlRequest;
  transaction(): AzureSqlTransactionHandle;
  connect(): Promise<AzureSqlPool>;
  close(): Promise<void>;
};

export type AzureSqlPoolFactory = (config: mssql.config) => AzureSqlPool;

type AzureSqlFailureKind =
  | "authentication"
  | "timeout"
  | "connection"
  | "cancellation"
  | "request"
  | "unknown";

class AzureSqlStorageError extends Error {
  readonly kind: AzureSqlFailureKind;
  readonly retryable: boolean;

  constructor(
    message: string,
    options: { kind: AzureSqlFailureKind; retryable: boolean; cause?: unknown },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AzureSqlStorageError";
    this.kind = options.kind;
    this.retryable = options.retryable;
  }
}

function isMssqlSqlType(value: unknown): value is mssql.ISqlType {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof value.type === "function"
  );
}

class MssqlRequestAdapter implements AzureSqlRequest {
  constructor(private readonly request: mssql.Request) {}

  input(name: string, value: unknown): AzureSqlRequest;
  input(name: string, type: mssql.ISqlType, value: unknown): AzureSqlRequest;
  input(name: string, valueOrType: unknown, value?: unknown): AzureSqlRequest {
    if (value === undefined) {
      this.request.input(name, valueOrType);
    } else if (isMssqlSqlType(valueOrType)) {
      this.request.input(name, valueOrType, value);
    } else {
      throw new TypeError("Azure SQL request input requires a mssql SQL type or a plain value");
    }
    return this;
  }

  async query<Row>(text: string): Promise<AzureSqlDriverResult<Row>> {
    return await this.request.query<Row>(text);
  }

  cancel(): void {
    this.request.cancel();
  }
}

class MssqlConnectionPoolAdapter implements AzureSqlPool {
  constructor(private readonly pool: mssql.ConnectionPool) {}

  get connected(): boolean {
    return this.pool.connected;
  }
  get connecting(): boolean {
    return this.pool.connecting;
  }
  get healthy(): boolean {
    return this.pool.healthy;
  }

  request(): AzureSqlRequest {
    return new MssqlRequestAdapter(this.pool.request());
  }

  transaction(): AzureSqlTransactionHandle {
    const transaction = this.pool.transaction();
    return {
      begin: (isolationLevel?: number) => transaction.begin(isolationLevel),
      commit: () => transaction.commit(),
      rollback: () => transaction.rollback(),
      request: () => new MssqlRequestAdapter(transaction.request()),
    };
  }

  async connect(): Promise<AzureSqlPool> {
    await this.pool.connect();
    return this;
  }

  close(): Promise<void> {
    return this.pool.close();
  }
}

function defaultPoolFactory(config: mssql.config): AzureSqlPool {
  return new MssqlConnectionPoolAdapter(new mssql.ConnectionPool(config));
}

function isAzureSqlErrorLike(error: unknown): error is { code?: unknown; message?: unknown } {
  return typeof error === "object" && error !== null;
}

function classifyAzureSqlFailure(error: unknown): AzureSqlStorageError {
  const candidate = isAzureSqlErrorLike(error) ? error : undefined;
  const code = candidate && typeof candidate.code === "string" ? candidate.code : undefined;
  const message =
    candidate && typeof candidate.message === "string"
      ? candidate.message
      : "Azure SQL request failed";
  if (code === "ELOGIN") {
    return new AzureSqlStorageError("Azure SQL authentication failed.", {
      kind: "authentication",
      retryable: false,
      cause: error,
    });
  }
  if (code === "ETIMEOUT") {
    return new AzureSqlStorageError("Azure SQL request timed out.", {
      kind: "timeout",
      retryable: true,
      cause: error,
    });
  }
  if (code === "EABORT" || code === "ECANCEL") {
    return new AzureSqlStorageError("Azure SQL request was cancelled.", {
      kind: "cancellation",
      retryable: false,
      cause: error,
    });
  }
  if (
    code === "ESOCKET" ||
    code === "ECONNCLOSED" ||
    code === "ENOCONN" ||
    code === "EINSTLOOKUP"
  ) {
    return new AzureSqlStorageError("Azure SQL connection is unavailable.", {
      kind: "connection",
      retryable: true,
      cause: error,
    });
  }
  if (code === "EREQUEST") {
    return new AzureSqlStorageError(message, {
      kind: "request",
      retryable: false,
      cause: error,
    });
  }
  return new AzureSqlStorageError(message, {
    kind: "unknown",
    retryable: false,
    cause: error,
  });
}

function createMssqlConfig(options: AzureSqlConnectionOptions): mssql.config {
  const credential = options.credential ?? new DefaultAzureCredential();
  return {
    server: options.server,
    database: options.database,
    ...(options.port === undefined ? {} : { port: options.port }),
    connectionTimeout: options.connectionTimeoutMs ?? 15_000,
    requestTimeout: options.requestTimeoutMs ?? 30_000,
    ...(options.sqlPassword
      ? { user: options.sqlPassword.username, password: options.sqlPassword.password }
      : {
          authentication: {
            type: "token-credential" as const,
            options: { credential },
          },
        }),
    options: {
      encrypt: true,
      trustServerCertificate: false,
    },
    pool: {
      max: options.pool?.max ?? 10,
      min: options.pool?.min ?? 0,
      idleTimeoutMillis: options.pool?.idleTimeoutMs ?? 30_000,
    },
  };
}

function normalizeAzureSqlResult<Row>(result: AzureSqlDriverResult<Row>): AzureSqlResult<Row> {
  if ("recordset" in result) {
    return {
      rows: Array.isArray(result.recordset) ? [...result.recordset] : [],
      rowsAffected: Array.isArray(result.rowsAffected) ? result.rowsAffected : [],
    };
  }
  return result;
}

function bindRequest(
  request: AzureSqlRequest,
  bind: (request: AzureSqlRequest) => void,
): AzureSqlRequest {
  bind(request);
  return request;
}

export class AzureSqlDatabase {
  private readonly pool: AzureSqlPool;
  private connected = false;

  constructor(
    options: AzureSqlConnectionOptions,
    poolFactory: AzureSqlPoolFactory = defaultPoolFactory,
  ) {
    this.pool = poolFactory(createMssqlConfig(options));
  }

  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }
    try {
      await this.pool.connect();
      this.connected = true;
    } catch (error) {
      throw classifyAzureSqlFailure(error);
    }
  }

  async query<Row>(
    text: string,
    bind?: (request: AzureSqlRequest) => void,
  ): Promise<AzureSqlResult<Row>> {
    await this.connect();
    try {
      const request = this.pool.request();
      const result = await bindRequest(request, bind ?? (() => {})).query<Row>(text);
      return normalizeAzureSqlResult(result);
    } catch (error) {
      throw classifyAzureSqlFailure(error);
    }
  }

  async checkHealth(): Promise<void> {
    const result = await this.query<{ ok: number }>("SELECT 1 AS ok");
    if (result.rows[0]?.ok !== 1) {
      throw new AzureSqlStorageError("Azure SQL health probe returned an invalid result.", {
        kind: "request",
        retryable: false,
      });
    }
  }

  async transaction<T>(operation: (transaction: AzureSqlTransaction) => Promise<T>): Promise<T> {
    await this.connect();
    const transaction = this.pool.transaction();
    try {
      await transaction.begin(mssql.ISOLATION_LEVEL.READ_COMMITTED);
      const result = await operation({
        query: async <Row>(text: string, bind?: (request: AzureSqlRequest) => void) => {
          try {
            const request = transaction.request();
            const queryResult = await bindRequest(request, bind ?? (() => {})).query<Row>(text);
            return normalizeAzureSqlResult(queryResult);
          } catch (error) {
            throw classifyAzureSqlFailure(error);
          }
        },
      });
      await transaction.commit();
      return result;
    } catch (error) {
      try {
        await transaction.rollback();
      } catch (rollbackError) {
        // eslint-disable-next-line preserve-caught-error -- AggregateError retains the original transaction failure as its cause.
        throw new AggregateError(
          [classifyAzureSqlFailure(error), classifyAzureSqlFailure(rollbackError)],
          "Azure SQL transaction and rollback both failed",
          { cause: error },
        );
      }
      const classified =
        error instanceof AzureSqlStorageError ? error : classifyAzureSqlFailure(error);
      throw new AzureSqlStorageError(classified.message, {
        kind: classified.kind,
        retryable: classified.retryable,
        cause: error,
      });
    }
  }

  async close(): Promise<void> {
    if (!this.connected) {
      return;
    }
    try {
      await this.pool.close();
    } finally {
      this.connected = false;
    }
  }
}
