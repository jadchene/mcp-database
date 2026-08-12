import { z } from "zod";

import { ApplicationError } from "../core/errors.js";
import type { DatabaseConfig, RootConfig } from "./configTypes.js";

const readonlySchema = z.boolean();
const keySchema = z.string().min(1);
const portSchema = z.number().int().min(1).max(65_535).optional();
const timeoutSchema = z.number().int().min(1).max(2_147_483_647).optional();

const mysqlSchema = z.object({
  key: keySchema,
  type: z.literal("mysql"),
  readonly: readonlySchema,
  connection: z.object({
    host: z.string().min(1),
    port: portSchema,
    databaseName: z.string().min(1),
    user: z.string().min(1),
    password: z.string(),
    connectTimeoutMs: timeoutSchema,
    ssl: z.union([z.boolean(), z.record(z.unknown())]).optional()
  }).strict()
}).strict();

const oracleSchema = z.object({
  key: keySchema,
  type: z.literal("oracle"),
  readonly: readonlySchema,
  connection: z
    .object({
      host: z.string().min(1),
      port: portSchema,
      serviceName: z.string().min(1).optional(),
      sid: z.string().min(1).optional(),
      user: z.string().min(1),
      password: z.string(),
      connectTimeoutMs: timeoutSchema,
      clientMode: z.union([z.literal("thin"), z.literal("thick")]).optional(),
      clientLibDir: z.string().min(1).optional()
    }).strict()
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
}).strict();

const postgresConnectionSchema = z.object({
  host: z.string().min(1),
  port: portSchema,
  databaseName: z.string().min(1),
  user: z.string().min(1),
  password: z.string(),
  connectTimeoutMs: timeoutSchema,
  ssl: z.union([z.boolean(), z.record(z.unknown())]).optional()
}).strict();

const postgresSchema = z.object({
  key: keySchema,
  type: z.literal("postgresql"),
  readonly: readonlySchema,
  connection: postgresConnectionSchema
}).strict();

const openGaussSchema = z.object({
  key: keySchema,
  type: z.literal("opengauss"),
  readonly: readonlySchema,
  connection: postgresConnectionSchema
}).strict();

const redisSchema = z.object({
  key: keySchema,
  type: z.literal("redis"),
  readonly: readonlySchema,
  connection: z
    .object({
      url: z.string().min(1).optional(),
      host: z.string().min(1).optional(),
      port: portSchema,
      databaseName: z.number().int().nonnegative().optional(),
      username: z.string().optional(),
      password: z.string().optional(),
      connectTimeoutMs: timeoutSchema
    }).strict()
    .superRefine((value, context) => {
      if (!value.url && !value.host) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Redis connection requires either url or host"
        });
      }
    })
}).strict();

const databaseArraySchema = z
  .array(z.discriminatedUnion("type", [mysqlSchema, oracleSchema, postgresSchema, openGaussSchema, redisSchema]))
  .min(1);

const rootConfigSchema = z.object({
  databases: databaseArraySchema,
  logging: z
    .object({
      enabled: z.boolean().default(false),
      directory: z.string().min(1).optional()
    }).strict()
    .default({
      enabled: false
    }),
  query: z
    .object({
      timeoutMs: timeoutSchema
    }).strict()
    .default({})
}).strict();

/**
 * Validation happens once at startup. The returned array is already typed and
 * safe for the runtime to consume.
 */
export function validateDatabaseConfig(rawConfig: unknown): RootConfig {
  const parsed = rootConfigSchema.safeParse(rawConfig);
  if (!parsed.success) {
    throw new ApplicationError("CONFIG_ERROR", "Invalid database configuration", {
      issues: parsed.error.issues
    });
  }

  const keys = new Set<string>();
  for (const config of parsed.data.databases) {
    if (keys.has(config.key)) {
      throw new ApplicationError("CONFIG_ERROR", `Duplicate database key: ${config.key}`);
    }

    keys.add(config.key);
  }

  return {
    databases: parsed.data.databases as DatabaseConfig[],
    logging: {
      enabled: parsed.data.logging.enabled,
      directory: parsed.data.logging.directory
    },
    query: {
      timeoutMs: parsed.data.query.timeoutMs
    }
  };
}
