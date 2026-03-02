import { z } from "zod";

import { ApplicationError } from "../core/errors.js";
import type { DatabaseConfig } from "./configTypes.js";

const readonlySchema = z.boolean();
const keySchema = z.string().min(1);

const mysqlSchema = z.object({
  key: keySchema,
  type: z.literal("mysql"),
  readonly: readonlySchema,
  connection: z.object({
    host: z.string().min(1),
    port: z.number().int().positive().optional(),
    databaseName: z.string().min(1),
    user: z.string().min(1),
    password: z.string(),
    connectTimeoutMs: z.number().int().positive().optional(),
    ssl: z.union([z.boolean(), z.record(z.unknown())]).optional()
  })
});

const oracleSchema = z.object({
  key: keySchema,
  type: z.literal("oracle"),
  readonly: readonlySchema,
  connection: z
    .object({
      host: z.string().min(1),
      port: z.number().int().positive().optional(),
      serviceName: z.string().min(1).optional(),
      sid: z.string().min(1).optional(),
      user: z.string().min(1),
      password: z.string(),
      connectTimeoutMs: z.number().int().positive().optional(),
      clientMode: z.union([z.literal("thin"), z.literal("thick")]).optional(),
      clientLibDir: z.string().min(1).optional()
    })
    .superRefine((value, context) => {
      if (!value.serviceName && !value.sid) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Oracle connection requires either serviceName or sid"
        });
      }

      if (value.clientMode === "thick" && !value.clientLibDir) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Oracle thick mode requires clientLibDir"
        });
      }
    })
});

const postgresConnectionSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().positive().optional(),
  databaseName: z.string().min(1),
  user: z.string().min(1),
  password: z.string(),
  connectTimeoutMs: z.number().int().positive().optional(),
  ssl: z.union([z.boolean(), z.record(z.unknown())]).optional()
});

const postgresSchema = z.object({
  key: keySchema,
  type: z.literal("postgresql"),
  readonly: readonlySchema,
  connection: postgresConnectionSchema
});

const openGaussSchema = z.object({
  key: keySchema,
  type: z.literal("opengauss"),
  readonly: readonlySchema,
  connection: postgresConnectionSchema
});

const redisSchema = z.object({
  key: keySchema,
  type: z.literal("redis"),
  readonly: readonlySchema,
  connection: z
    .object({
      url: z.string().min(1).optional(),
      host: z.string().min(1).optional(),
      port: z.number().int().positive().optional(),
      databaseName: z.number().int().nonnegative().optional(),
      username: z.string().optional(),
      password: z.string().optional(),
      connectTimeoutMs: z.number().int().positive().optional()
    })
    .superRefine((value, context) => {
      if (!value.url && !value.host) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Redis connection requires either url or host"
        });
      }
    })
});

const configArraySchema = z
  .array(z.discriminatedUnion("type", [mysqlSchema, oracleSchema, postgresSchema, openGaussSchema, redisSchema]))
  .min(1);

/**
 * Validation happens once at startup. The returned array is already typed and
 * safe for the runtime to consume.
 */
export function validateDatabaseConfig(rawConfig: unknown): DatabaseConfig[] {
  const parsed = configArraySchema.safeParse(rawConfig);
  if (!parsed.success) {
    throw new ApplicationError("CONFIG_ERROR", "Invalid database configuration", {
      issues: parsed.error.issues
    });
  }

  const keys = new Set<string>();
  for (const config of parsed.data) {
    if (keys.has(config.key)) {
      throw new ApplicationError("CONFIG_ERROR", `Duplicate database key: ${config.key}`);
    }

    keys.add(config.key);
  }

  return parsed.data;
}
