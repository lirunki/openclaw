import { describe, expect, it } from "vitest";
import { StorageConfigSchema } from "./zod-schema.storage.js";

describe("StorageConfigSchema", () => {
  it("accepts the default SQLite backend when storage is omitted", () => {
    expect(StorageConfigSchema.safeParse(undefined).success).toBe(true);
    expect(StorageConfigSchema.safeParse({ backend: "sqlite" }).success).toBe(true);
  });

  it("requires Azure SQL settings when Azure SQL is selected", () => {
    expect(StorageConfigSchema.safeParse({ backend: "azuresql" }).success).toBe(false);
    expect(
      StorageConfigSchema.safeParse({
        backend: "azuresql",
        azureSql: {
          server: "sql.example.invalid",
          database: "openclaw",
          authentication: { mode: "device-code" },
        },
      }).success,
    ).toBe(true);
  });

  it("accepts SQL password authentication only with a username and SecretRef", () => {
    expect(
      StorageConfigSchema.safeParse({
        backend: "azuresql",
        azureSql: {
          server: "sql.example.invalid",
          database: "openclaw",
          authentication: {
            mode: "sql-password",
            username: "openclaw_experiment",
            password: { source: "file", provider: "azure-sql", id: "value" },
          },
        },
      }).success,
    ).toBe(true);
    expect(
      StorageConfigSchema.safeParse({
        backend: "azuresql",
        azureSql: {
          server: "sql.example.invalid",
          database: "openclaw",
          authentication: {
            mode: "sql-password",
            username: "openclaw_experiment",
            password: "plaintext-password",
          },
        },
      }).success,
    ).toBe(false);
  });

  it("rejects ambiguous Azure authentication settings", () => {
    expect(
      StorageConfigSchema.safeParse({
        backend: "azuresql",
        azureSql: {
          server: "sql.example.invalid",
          database: "openclaw",
          credential: { source: "env", provider: "default", id: "AZURE_SQL_TOKEN" },
          authentication: { mode: "device-code" },
        },
      }).success,
    ).toBe(false);
    expect(
      StorageConfigSchema.safeParse({
        backend: "azuresql",
        azureSql: {
          server: "sql.example.invalid",
          database: "openclaw",
          authentication: { mode: "default", tenantId: "ignored-tenant" },
        },
      }).success,
    ).toBe(false);
  });

  it("rejects Azure settings unless Azure SQL is explicitly selected", () => {
    const azureSql = { server: "sql.example.invalid", database: "openclaw" };
    expect(StorageConfigSchema.safeParse({ azureSql }).success).toBe(false);
    expect(StorageConfigSchema.safeParse({ backend: "sqlite", azureSql }).success).toBe(false);
  });

  it("rejects unknown storage settings", () => {
    expect(StorageConfigSchema.safeParse({ backend: "sqlite", unexpected: true }).success).toBe(
      false,
    );
  });
});
