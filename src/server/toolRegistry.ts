import { z } from "zod";

import { summarizeDatabaseListItem, summarizeLoadedConfig } from "../config/configSummary.js";
import type { LoadedConfig } from "../config/configTypes.js";
import { ApplicationError } from "../core/errors.js";
import type { RedisDatabaseAdapter, SqlDatabaseAdapter } from "../db/types.js";

const emptySchema = z.object({}).describe("This tool does not require any input arguments.").strict();
const databaseKeySchema = z.object({
  databaseKey: z
    .string()
    .min(1)
    .describe("Exact configured target key from list_databases. This is the MCP identifier used to call tools. It is not necessarily the same as connection.databaseName or the physical database name used inside SQL.")
}).strict();
const listTablesSchema = z.object({
  databaseKey: z
    .string()
    .min(1)
    .describe("Exact configured SQL target key from list_databases. Use the configured target key here, not connection.databaseName."),
  schema: z
    .string()
    .min(1)
    .optional()
    .describe("Optional schema name. Omit it to use the database's current or default schema.")
}).strict();
const describeTableSchema = z.object({
  databaseKey: z
    .string()
    .min(1)
    .describe("Exact configured SQL target key from list_databases. Use the configured target key here, not connection.databaseName."),
  schema: z
    .string()
    .min(1)
    .optional()
    .describe("Optional schema name. Omit it to use the database's current or default schema."),
  table: z
    .string()
    .min(1)
    .describe("Table or view name to inspect. Pass only the object name, not a full SQL statement.")
}).strict();
const listIndexesSchema = describeTableSchema;
const getTableStatisticsSchema = describeTableSchema;
const executeQuerySchema = z.object({
  databaseKey: z
    .string()
    .min(1)
    .describe("Exact configured SQL target key from list_databases. Use the configured target key to call the tool. Do not confuse it with connection.databaseName when writing SQL."),
  sql: z
    .string()
    .min(1)
    .describe("Original SQL text. Pass the raw query, not JSON, not markdown, and usually not an EXPLAIN wrapper unless the tool explicitly allows it."),
  params: z
    .array(z.unknown())
    .optional()
    .describe("Optional positional bind parameters matching placeholders in the SQL statement."),
  maxRows: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe("Optional maximum number of rows returned to the client. Default is 200 and the hard limit is 1000.")
}).strict();
const explainQuerySchema = executeQuerySchema;
const analyzeQuerySchema = executeQuerySchema;
const executeStatementSchema = z.object({
  databaseKey: z
    .string()
    .min(1)
    .describe("Exact configured writable SQL target key from list_databases. Use the configured target key to call the tool. Do not confuse it with connection.databaseName when writing SQL."),
  sql: z
    .string()
    .min(1)
    .describe("One non-query SQL statement such as INSERT, UPDATE, DELETE, MERGE, or DDL. Do not pass SELECT here."),
  params: z
    .array(z.unknown())
    .optional()
    .describe("Optional positional bind parameters matching placeholders in the SQL statement."),
  confirmationId: z
    .string()
    .min(1)
    .optional()
    .describe("Second-step confirmation id previously returned by execute_statement when the client does not support interactive confirmation."),
  confirmExecution: z
    .boolean()
    .optional()
    .describe("Set to true on the second execute_statement call after the user explicitly confirms execution.")
}).strict();
const redisKeySchema = z.object({
  databaseKey: z
    .string()
    .min(1)
    .describe("Exact configured Redis target name from list_databases."),
  key: z
    .string()
    .min(1)
    .describe("Exact Redis key name.")
}).strict();
const redisScanSchema = z.object({
  databaseKey: z
    .string()
    .min(1)
    .describe("Exact configured Redis target name from list_databases."),
  cursor: z
    .string()
    .optional()
    .describe("Optional SCAN cursor from the previous call. Use 0 or omit it on the first call."),
  pattern: z
    .string()
    .min(1)
    .optional()
    .describe("Optional Redis key pattern, for example user:* ."),
  count: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe("Optional SCAN count hint. Default is 100.")
}).strict();

type ToolExecutionContext = {
  getConfig(): LoadedConfig;
  reloadConfig(): Promise<LoadedConfig>;
  useSqlDatabase<T>(databaseKey: string, action: (adapter: SqlDatabaseAdapter) => Promise<T>): Promise<T>;
  useRedisDatabase<T>(databaseKey: string, action: (adapter: RedisDatabaseAdapter) => Promise<T>): Promise<T>;
  confirmStatementExecution(input: {
    databaseKey: string;
    sql: string;
    params?: unknown[];
    confirmationId?: string;
    confirmExecution?: boolean;
  }): Promise<
    | { status: "confirmed" }
    | {
      status: "pending";
      confirmationId: string;
      confirmationMode: "two_step";
      message: string;
      statement: string;
      targetObject: string;
      riskLevel: "normal" | "high" | "critical";
      riskDetails: string;
      sqlPreview: string;
      paramsPreview: string;
    }
  >;
};

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(args: unknown, context: ToolExecutionContext): Promise<unknown>;
}

function makeTool<T>(
  name: string,
  description: string,
  schema: z.ZodType<T>,
  handler: (args: T, context: ToolExecutionContext) => Promise<unknown>
): ToolDefinition {
  return {
    name,
    description,
    inputSchema: zodSchemaToJsonSchema(schema),
    async run(args, context) {
      const parsed = schema.safeParse(args ?? {});
      if (!parsed.success) {
        throw new ApplicationError("INVALID_ARGUMENT", `Invalid arguments for ${name}`, {
          issues: parsed.error.issues
        });
      }

      return handler(parsed.data, context);
    }
  };
}

function zodSchemaToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const shape = schema instanceof z.ZodObject ? schema.shape : {};
  const properties = Object.fromEntries(
    Object.entries(shape).map(([key, value]) => [key, zodNodeToJsonSchema(value as z.ZodTypeAny)])
  );

  const required = Object.entries(shape)
    .filter(([, value]) => !(value instanceof z.ZodOptional) && !(value instanceof z.ZodDefault))
    .map(([key]) => key);

  return {
    type: "object",
    description: readZodDescription(schema),
    properties,
    additionalProperties: false,
    required
  };
}

function zodNodeToJsonSchema(node: z.ZodTypeAny): Record<string, unknown> {
  if (node instanceof z.ZodString) {
    return withDescription({ type: "string" }, node);
  }

  if (node instanceof z.ZodNumber) {
    return withDescription({ type: "number" }, node);
  }

  if (node instanceof z.ZodArray) {
    return withDescription({
      type: "array",
      items: zodNodeToJsonSchema(node.element)
    }, node);
  }

  if (node instanceof z.ZodOptional || node instanceof z.ZodDefault) {
    if (node instanceof z.ZodOptional) {
      return withDescription(zodNodeToJsonSchema(node.unwrap()), node);
    }

    return withDescription(zodNodeToJsonSchema((node as z.ZodDefault<z.ZodTypeAny>)._def.innerType), node);
  }

  return withDescription({}, node);
}

function withDescription(schema: Record<string, unknown>, node: z.ZodTypeAny): Record<string, unknown> {
  const description = readZodDescription(node);
  return description ? { ...schema, description } : schema;
}

function readZodDescription(node: z.ZodTypeAny): string | undefined {
  const description = (node._def as { description?: string } | undefined)?.description;
  return typeof description === "string" && description.trim() ? description : undefined;
}

function buildToolDescription(sections: {
  whenToUse: string;
  whenNotToUse: string;
  inputExpectations: string;
  databaseSupport: string;
}): string {
  return [
    `When to use: ${sections.whenToUse}`,
    `When not to use: ${sections.whenNotToUse}`,
    `Input expectations: ${sections.inputExpectations}`,
    `Database support: ${sections.databaseSupport}`
  ].join("\n");
}

export function buildToolRegistry(): ToolDefinition[] {
  return [
    makeTool(
      "show_loaded_config",
      buildToolDescription({
        whenToUse:
          "Use this only when you need to inspect the currently loaded configuration snapshot, confirm which config file is active, or diagnose config reload behavior.",
        whenNotToUse:
          "Do not use this as the default discovery tool for normal database work. Use list_databases first when you only need callable target names and logical database names.",
        inputExpectations:
          "No arguments. Returns the current config path, load timestamp, database count, and each configured target summary without exposing secrets.",
        databaseSupport: "All configured targets, including SQL databases and Redis."
      }),
      emptySchema,
      async (_args, context) => {
        const config = context.getConfig();
        return summarizeLoadedConfig(config);
      }
    ),
    makeTool(
      "reload_config",
      buildToolDescription({
        whenToUse:
          "Use this after the JSON config file has been edited and you want the running MCP server to reload the new configuration without restarting the process.",
        whenNotToUse:
          "Do not use this when the config file has not changed. Do not assume a failed reload partially updates the state; on failure the previous config remains active.",
        inputExpectations:
          "No arguments. Reloads the currently active configPath from disk, validates it fully, and then atomically replaces the in-memory configuration on success.",
        databaseSupport: "All configured targets, including SQL databases and Redis."
      }),
      emptySchema,
      async (_args, context) => {
        const config = await context.reloadConfig();
        return summarizeLoadedConfig(config);
      }
    ),
    makeTool(
      "list_databases",
      buildToolDescription({
        whenToUse:
          "Use this first when you do not know which databaseKey values are available or when you want a lightweight list of configured target identifiers and their logical database names before choosing another tool.",
        whenNotToUse:
          "Do not use this when you need the full loaded config snapshot or sanitized connection details. Use show_loaded_config for that.",
        inputExpectations:
          "No arguments. Returns the configured target key used by other tools in the key field, the logical or physical database identifier from the connection config in the databaseName field, the database type, and the readonly flag. Use key for MCP tool calls. Use databaseName when generating SQL that needs an explicit database name. This tool does not open database connections.",
        databaseSupport: "All configured targets, including SQL databases and Redis."
      }),
      emptySchema,
      async (_args, context) => ({
        items: context.getConfig().databases.map((database) => summarizeDatabaseListItem(database))
      })
    ),
    makeTool(
      "ping_database",
      buildToolDescription({
        whenToUse:
          "Use this for connectivity diagnosis before running metadata, query, or write tools, or when you suspect network, credential, or service availability issues.",
        whenNotToUse:
          "Do not use this as a substitute for metadata discovery or SQL execution. A successful ping does not validate schema, table, or query correctness.",
        inputExpectations:
          "Requires an exact databaseKey from list_databases, which means the configured target key in the key field. Do not pass connection.databaseName here. Returns database type, success flag, and latency.",
        databaseSupport: "All configured targets, including SQL databases and Redis."
      }),
      databaseKeySchema,
      async (args, context) => {
        const database = context.getConfig().databaseMap.get(args.databaseKey);
        if (!database) {
          throw new ApplicationError("DATABASE_NOT_FOUND", `Database not found: ${args.databaseKey}`);
        }

        if (database.type === "redis") {
          return context.useRedisDatabase(args.databaseKey, async (adapter) => ({
            databaseKey: args.databaseKey,
            type: adapter.config.type,
            ...(await adapter.ping())
          }));
        }

        return context.useSqlDatabase(args.databaseKey, async (adapter) => ({
          databaseKey: args.databaseKey,
          type: adapter.config.type,
          ...(await adapter.ping())
        }));
      }
    ),
    makeTool(
      "list_schemas",
      buildToolDescription({
        whenToUse:
          "Use this when you need to discover which schema to inspect before listing tables, describing tables, or writing report and optimization SQL.",
        whenNotToUse:
          "Do not use this for Redis or when you already know the exact schema name.",
        inputExpectations:
          "Requires databaseKey only, using the configured target key from list_databases.key. Returns schema names visible to the configured user.",
        databaseSupport: "SQL databases only: MySQL, Oracle, PostgreSQL, and openGauss."
      }),
      databaseKeySchema,
      async (args, context) =>
      context.useSqlDatabase(args.databaseKey, async (adapter) => ({
        databaseKey: args.databaseKey,
        type: adapter.config.type,
        items: await adapter.listSchemas()
      }))
    ),
    makeTool(
      "list_tables",
      buildToolDescription({
        whenToUse:
          "Use this after list_schemas or when you already know the schema and need to discover available tables and views before building queries or reports.",
        whenNotToUse:
          "Do not use this for Redis or when you already know the exact table name and only need column or index metadata.",
        inputExpectations:
          "Requires databaseKey using the configured target key from list_databases.key. Optional schema. If schema is omitted, the database's current or default schema is used.",
        databaseSupport: "SQL databases only: MySQL, Oracle, PostgreSQL, and openGauss."
      }),
      listTablesSchema,
      async (args, context) =>
      context.useSqlDatabase(args.databaseKey, async (adapter) => ({
        databaseKey: args.databaseKey,
        type: adapter.config.type,
        items: await adapter.listTables(args.schema)
      }))
    ),
    makeTool(
      "describe_table",
      buildToolDescription({
        whenToUse:
          "Use this before writing report SQL, join SQL, aggregation SQL, export SQL, or optimization advice so you can see column names, types, nullability, defaults, comments, and primary key hints.",
        whenNotToUse:
          "Do not use this for Redis or when you only need a high-level table list.",
        inputExpectations:
          "Requires databaseKey using the configured target key from list_databases.key, plus table. Optional schema. Returns one item per column.",
        databaseSupport: "SQL databases only: MySQL, Oracle, PostgreSQL, and openGauss."
      }),
      describeTableSchema,
      async (args, context) =>
      context.useSqlDatabase(args.databaseKey, async (adapter) => ({
        databaseKey: args.databaseKey,
        type: adapter.config.type,
        items: await adapter.describeTable(args.schema, args.table)
      }))
    ),
    makeTool(
      "list_indexes",
      buildToolDescription({
        whenToUse:
          "Use this when analyzing performance, checking whether filter, join, group by, or order by columns are indexed, or reviewing why a query may fall back to full scans.",
        whenNotToUse:
          "Do not use this for Redis or as a substitute for runtime plan analysis. Use explain_query or analyze_query for plan details.",
        inputExpectations:
          "Requires databaseKey using the configured target key from list_databases.key, plus table. Optional schema. Some databases may return full index definitions instead of per-column detail rows.",
        databaseSupport: "SQL databases only: MySQL, Oracle, PostgreSQL, and openGauss."
      }),
      listIndexesSchema,
      async (args, context) =>
      context.useSqlDatabase(args.databaseKey, async (adapter) => ({
        databaseKey: args.databaseKey,
        type: adapter.config.type,
        items: await adapter.listIndexes(args.schema, args.table)
      }))
    ),
    makeTool(
      "get_table_statistics",
      buildToolDescription({
        whenToUse:
          "Use this for performance diagnosis, report-query estimation, capacity review, and table health checks. It helps explain whether a table is large, stale, or heavily scanned.",
        whenNotToUse:
          "Do not use this when you need exact business query results or row-level data. Statistics may be approximate and database-specific.",
        inputExpectations:
          "Requires databaseKey using the configured target key from list_databases.key, plus table. Optional schema. Returns one statistics object or null if the table metadata is unavailable.",
        databaseSupport: "SQL databases only: MySQL, Oracle, PostgreSQL, and openGauss."
      }),
      getTableStatisticsSchema,
      async (args, context) =>
      context.useSqlDatabase(args.databaseKey, async (adapter) => ({
        databaseKey: args.databaseKey,
        type: adapter.config.type,
        item: await adapter.getTableStatistics(args.schema, args.table)
      }))
    ),
    makeTool(
      "execute_query",
      buildToolDescription({
        whenToUse:
          "Use this to run one read-only SQL query and get result rows for analysis, report development, validation, and ad hoc investigation.",
        whenNotToUse:
          "Do not use this for INSERT, UPDATE, DELETE, MERGE, DDL, or multi-statement SQL. Do not use it for runtime plan analysis; use analyze_query instead.",
        inputExpectations:
          "Requires databaseKey using the configured target key from list_databases.key, plus original query SQL. Allowed SQL shapes are SELECT, SHOW, DESCRIBE, DESC, EXPLAIN, or WITH ... SELECT. Optional params and maxRows. When SQL needs an explicit database name, refer to list_databases.databaseName, not list_databases.key.",
        databaseSupport: "SQL databases only: MySQL, Oracle, PostgreSQL, and openGauss."
      }),
      executeQuerySchema,
      async (args, context) =>
      context.useSqlDatabase(args.databaseKey, async (adapter) => ({
        databaseKey: args.databaseKey,
        type: adapter.config.type,
        ...(await adapter.executeQuery(args.sql, args.params, args.maxRows ?? 200))
      }))
    ),
    makeTool(
      "explain_query",
      buildToolDescription({
        whenToUse:
          "Use this to inspect the static execution plan of one read-only query before changing SQL, adding indexes, or deciding whether runtime analysis is worth the cost.",
        whenNotToUse:
          "Do not use this when you need actual runtime metrics such as real row counts, buffer usage, or elapsed execution behavior. Use analyze_query for that.",
        inputExpectations:
          "Requires databaseKey using the configured target key from list_databases.key, plus the original query SQL, usually SELECT or WITH ... SELECT. Do not include EXPLAIN in the sql argument; the server adds the database-specific EXPLAIN wrapper. When SQL needs an explicit database name, refer to list_databases.databaseName, not list_databases.key.",
        databaseSupport: "SQL databases only: MySQL, Oracle, PostgreSQL, and openGauss."
      }),
      explainQuerySchema,
      async (args, context) =>
      context.useSqlDatabase(args.databaseKey, async (adapter) => ({
        databaseKey: args.databaseKey,
        type: adapter.config.type,
        ...(await adapter.explainQuery(args.sql, args.params, args.maxRows ?? 200))
      }))
    ),
    makeTool(
      "analyze_query",
      buildToolDescription({
        whenToUse:
          "Use this when you need runtime analysis for a read-only query, such as actual row counts, execution-time behavior, or richer plan diagnostics during SQL optimization.",
        whenNotToUse:
          "Do not use this for write SQL, multi-statement SQL, or cheap metadata inspection. It is more expensive than explain_query because it may really execute the query.",
        inputExpectations:
          "Requires databaseKey using the configured target key from list_databases.key, plus the original query SQL. Do not pass EXPLAIN ANALYZE SQL; the server adds the database-specific analyze wrapper automatically. Optional params and maxRows. When SQL needs an explicit database name, refer to list_databases.databaseName, not list_databases.key.",
        databaseSupport: "Currently supported for MySQL, PostgreSQL, and openGauss. Oracle currently returns NOT_SUPPORTED."
      }),
      analyzeQuerySchema,
      async (args, context) =>
      context.useSqlDatabase(args.databaseKey, async (adapter) => ({
        databaseKey: args.databaseKey,
        type: adapter.config.type,
        ...(await adapter.analyzeQuery(args.sql, args.params, args.maxRows ?? 200))
      }))
    ),
    makeTool(
      "execute_statement",
      buildToolDescription({
        whenToUse:
          "Use this only for non-query SQL on writable targets, such as INSERT, UPDATE, DELETE, MERGE, or DDL, when the user explicitly wants a change to be made.",
        whenNotToUse:
          "Do not use this for SELECT or other readonly SQL. Do not use it on targets configured as readonly. Avoid it unless a write is truly required.",
        inputExpectations:
          "Requires databaseKey using the configured target key from list_databases.key, plus one non-query SQL statement. Manual user confirmation is always required before execution. If the client supports interactive confirmation, the server requests it directly. Otherwise the first call returns confirmation details and a confirmationId, and the second call must resend the same SQL with confirmationId and confirmExecution=true. High-risk statements such as UPDATE or DELETE without WHERE are specially highlighted. When SQL needs an explicit database name, refer to list_databases.databaseName, not list_databases.key.",
        databaseSupport: "Writable SQL targets only: MySQL, Oracle, PostgreSQL, and openGauss when readonly is false."
      }),
      executeStatementSchema,
      async (args, context) => {
      const confirmation = await context.confirmStatementExecution({
        databaseKey: args.databaseKey,
        sql: args.sql,
        params: args.params,
        confirmationId: args.confirmationId,
        confirmExecution: args.confirmExecution
      });

      if (confirmation.status === "pending") {
        return confirmation;
      }

      return context.useSqlDatabase(args.databaseKey, async (adapter) => {
        if (adapter.config.readonly) {
          throw new ApplicationError("NOT_SUPPORTED", `${args.databaseKey} is configured as readonly`);
        }

        return {
          databaseKey: args.databaseKey,
          type: adapter.config.type,
          ...(await adapter.executeStatement(args.sql, args.params))
        };
      });
    }
    ),
    makeTool(
      "redis_get",
      buildToolDescription({
        whenToUse:
          "Use this to read one Redis string key when you already know the exact key name and the key is expected to hold a string value.",
        whenNotToUse:
          "Do not use this for key discovery, pattern search, or hash inspection. Use redis_scan for discovery and redis_hgetall for hash keys.",
        inputExpectations:
          "Requires databaseKey and exact key name. Returns null when the key does not exist.",
        databaseSupport: "Redis targets only."
      }),
      redisKeySchema,
      async (args, context) =>
      context.useRedisDatabase(args.databaseKey, async (adapter) => ({
        databaseKey: args.databaseKey,
        type: adapter.config.type,
        key: args.key,
        value: await adapter.get(args.key)
      }))
    ),
    makeTool(
      "redis_hgetall",
      buildToolDescription({
        whenToUse:
          "Use this to inspect one Redis hash key when you expect multiple named fields under the key.",
        whenNotToUse:
          "Do not use this for string keys or key discovery. Use redis_get for strings and redis_scan for discovery.",
        inputExpectations:
          "Requires databaseKey and exact key name. Returns all hash fields and values.",
        databaseSupport: "Redis targets only."
      }),
      redisKeySchema,
      async (args, context) =>
      context.useRedisDatabase(args.databaseKey, async (adapter) => ({
        databaseKey: args.databaseKey,
        type: adapter.config.type,
        key: args.key,
        value: await adapter.hgetall(args.key)
      }))
    ),
    makeTool(
      "redis_scan",
      buildToolDescription({
        whenToUse:
          "Use this for Redis key discovery when you do not know the exact key name or when you need to browse keys by pattern in a safer way than KEYS.",
        whenNotToUse:
          "Do not use this when you already know the exact key and only want its value. Use redis_get or redis_hgetall directly in that case.",
        inputExpectations:
          "Requires databaseKey. Optional cursor, pattern, and count. Repeat calls with the returned nextCursor until it becomes 0 or until enough keys are collected.",
        databaseSupport: "Redis targets only."
      }),
      redisScanSchema,
      async (args, context) =>
      context.useRedisDatabase(args.databaseKey, async (adapter) => ({
        databaseKey: args.databaseKey,
        type: adapter.config.type,
        ...(await adapter.scan(args.cursor ?? "0", args.pattern, args.count ?? 100))
      }))
    )
  ];
}
