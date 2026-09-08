import { z } from "zod";
import { SecretRefSchema } from "./zod-schema.core.js";

const AzureSqlStorageConfigSchema = z
  .strictObject({
    server: z.string().trim().min(1),
    database: z.string().trim().min(1),
    credential: SecretRefSchema.optional(),
    authentication: z
      .discriminatedUnion("mode", [
        z.strictObject({ mode: z.literal("default") }),
        z.strictObject({
          mode: z.literal("device-code"),
          tenantId: z.string().trim().min(1).optional(),
        }),
        z.strictObject({
          mode: z.literal("sql-password"),
          username: z.string().trim().min(1),
          password: SecretRefSchema,
        }),
      ])
      .optional(),
    port: z.number().int().min(1).max(65535).optional(),
  })
  .superRefine((azureSql, ctx) => {
    if (azureSql.credential && azureSql.authentication) {
      ctx.addIssue({
        code: "custom",
        path: ["credential"],
        message: "storage.azureSql.credential cannot be combined with authentication",
      });
    }
  });

export const StorageConfigSchema = z
  .strictObject({
    backend: z.enum(["sqlite", "azuresql"]).optional(),
    azureSql: AzureSqlStorageConfigSchema.optional(),
  })
  .superRefine((storage, ctx) => {
    if (storage.backend === "azuresql" && !storage.azureSql) {
      ctx.addIssue({
        code: "custom",
        path: ["azureSql"],
        message: "storage.azureSql is required when storage.backend is azuresql",
      });
    }
    if (storage.backend !== "azuresql" && storage.azureSql) {
      ctx.addIssue({
        code: "custom",
        path: ["backend"],
        message: "storage.backend must be azuresql when storage.azureSql is configured",
      });
    }
  })
  .optional();
