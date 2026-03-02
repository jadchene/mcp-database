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
const schemaPatternSchema = z.object({
  databaseKey: z
    .string()
    .min(1)
    .describe("Exact configured SQL target key from list_databases. Use the configured target key here, not connection.databaseName."),
  schema: z
    .string()
    .min(1)
    .optional()
    .describe("Optional schema name. Omit it to use the database's current or default schema."),
  pattern: z
    .string()
    .min(1)
    .describe("Case-insensitive search pattern. Pass only part of the table or column name, not SQL wildcards unless the tool explicitly says so.")
}).strict();
const showVariablesSchema = z.object({
  databaseKey: z
    .string()
    .min(1)
    .describe("Exact configured SQL target key from list_databases. Use the configured target key here, not connection.databaseName."),
  pattern: z
    .string()
    .min(1)
    .optional()
    .describe("Optional case-insensitive pattern to filter variable names.")
}).strict();
const longRunningQueriesSchema = z.object({
  databaseKey: z
    .string()
    .min(1)
    .describe("Exact configured SQL target key from list_databases. Use the configured target key here, not connection.databaseName."),
  minDurationSeconds: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Optional minimum runtime threshold in seconds. Defaults to 30.")
}).strict();
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

function assertSqlTarget(databaseKey: string, config: LoadedConfig): Exclude<LoadedConfig["databases"][number], { type: "redis" }> {
  const database = config.databaseMap.get(databaseKey);
  if (!database) {
    throw new ApplicationError("DATABASE_NOT_FOUND", `Database not found: ${databaseKey}`);
  }

  if (database.type === "redis") {
    throw new ApplicationError("NOT_SUPPORTED", `${databaseKey} is a Redis target and does not support this SQL tool`);
  }

  return database;
}

function likePattern(pattern: string): string {
  return `%${pattern}%`;
}

function buildShowCreateTableQuery(
  type: Exclude<LoadedConfig["databases"][number]["type"], "redis">,
  schema: string | undefined,
  table: string
): { sql: string; params?: unknown[] } | null {
  switch (type) {
    case "mysql":
      return { sql: `SHOW CREATE TABLE \`${table.replace(/`/g, "``")}\`` };
    case "postgresql":
    case "opengauss":
      return null;
    case "oracle":
      return {
        sql: `
          SELECT
            object_type AS objectType,
            owner AS schema,
            object_name AS name,
            DBMS_METADATA.GET_DDL(object_type, object_name, owner) AS definition
          FROM all_objects
          WHERE owner = COALESCE(:1, SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA'))
            AND object_name = :2
            AND object_type IN ('TABLE', 'VIEW')
            FETCH FIRST 1 ROWS ONLY
        `,
        params: [schema?.toUpperCase() ?? null, table.toUpperCase()]
      };
    default:
      return { sql: "" };
  }
}

function buildListViewsQuery(
  type: Exclude<LoadedConfig["databases"][number]["type"], "redis">,
  schema?: string
): { sql: string; params?: unknown[] } {
  switch (type) {
    case "mysql":
      return {
        sql: `
          SELECT table_schema AS schema, table_name AS name
          FROM information_schema.views
          WHERE table_schema = COALESCE(?, DATABASE())
          ORDER BY table_name
        `,
        params: [schema ?? null]
      };
    case "postgresql":
    case "opengauss":
      return {
        sql: `
          SELECT table_schema AS schema, table_name AS name
          FROM information_schema.views
          WHERE table_schema = COALESCE($1, current_schema())
          ORDER BY table_name
        `,
        params: [schema ?? null]
      };
    case "oracle":
      return {
        sql: `
          SELECT owner AS schema, view_name AS name
          FROM all_views
          WHERE owner = COALESCE(:1, SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA'))
          ORDER BY view_name
        `,
        params: [schema?.toUpperCase() ?? null]
      };
    default:
      return { sql: "" };
  }
}

function buildSearchTablesQuery(
  type: Exclude<LoadedConfig["databases"][number]["type"], "redis">,
  pattern: string,
  schema?: string
): { sql: string; params?: unknown[] } {
  switch (type) {
    case "mysql":
      return {
        sql: `
          SELECT table_schema AS schema, table_name AS tableName, table_type AS objectType
          FROM information_schema.tables
          WHERE table_schema = COALESCE(?, DATABASE())
            AND LOWER(table_name) LIKE LOWER(?)
          ORDER BY table_name
        `,
        params: [schema ?? null, likePattern(pattern)]
      };
    case "postgresql":
    case "opengauss":
      return {
        sql: `
          SELECT table_schema AS schema, table_name AS tableName, table_type AS objectType
          FROM information_schema.tables
          WHERE table_schema = COALESCE($1, current_schema())
            AND table_name ILIKE $2
          ORDER BY table_name
        `,
        params: [schema ?? null, likePattern(pattern)]
      };
    case "oracle":
      return {
        sql: `
          SELECT owner AS schema, object_name AS tableName, object_type AS objectType
          FROM all_objects
          WHERE owner = COALESCE(:1, SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA'))
            AND object_type IN ('TABLE', 'VIEW')
            AND LOWER(object_name) LIKE LOWER(:2)
          ORDER BY object_name
        `,
        params: [schema?.toUpperCase() ?? null, likePattern(pattern)]
      };
    default:
      return { sql: "" };
  }
}

function buildSearchColumnsQuery(
  type: Exclude<LoadedConfig["databases"][number]["type"], "redis">,
  pattern: string,
  schema?: string
): { sql: string; params?: unknown[] } {
  switch (type) {
    case "mysql":
      return {
        sql: `
          SELECT table_schema AS schema, table_name AS tableName, column_name AS columnName, 'TABLE' AS objectType
          FROM information_schema.columns
          WHERE table_schema = COALESCE(?, DATABASE())
            AND LOWER(column_name) LIKE LOWER(?)
          ORDER BY table_name, ordinal_position
        `,
        params: [schema ?? null, likePattern(pattern)]
      };
    case "postgresql":
    case "opengauss":
      return {
        sql: `
          SELECT table_schema AS schema, table_name AS tableName, column_name AS columnName, 'TABLE' AS objectType
          FROM information_schema.columns
          WHERE table_schema = COALESCE($1, current_schema())
            AND column_name ILIKE $2
          ORDER BY table_name, ordinal_position
        `,
        params: [schema ?? null, likePattern(pattern)]
      };
    case "oracle":
      return {
        sql: `
          SELECT owner AS schema, table_name AS tableName, column_name AS columnName, 'TABLE' AS objectType
          FROM all_tab_columns
          WHERE owner = COALESCE(:1, SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA'))
            AND LOWER(column_name) LIKE LOWER(:2)
          ORDER BY table_name, column_id
        `,
        params: [schema?.toUpperCase() ?? null, likePattern(pattern)]
      };
    default:
      return { sql: "" };
  }
}

function buildShowVariablesQuery(
  type: Exclude<LoadedConfig["databases"][number]["type"], "redis">,
  pattern?: string
): { sql: string; params?: unknown[] } {
  switch (type) {
    case "mysql":
      return pattern
        ? { sql: "SHOW VARIABLES LIKE ?", params: [likePattern(pattern)] }
        : { sql: "SHOW VARIABLES" };
    case "postgresql":
    case "opengauss":
      return {
        sql: `
          SELECT name, setting AS value
          FROM pg_settings
          WHERE $1::text IS NULL OR name ILIKE $1
          ORDER BY name
        `,
        params: [pattern ? likePattern(pattern) : null]
      };
    case "oracle":
      return {
        sql: `
          SELECT name, value
          FROM v$parameter
          WHERE :1 IS NULL OR LOWER(name) LIKE LOWER(:1)
          ORDER BY name
        `,
        params: [pattern ? likePattern(pattern) : null]
      };
    default:
      return { sql: "" };
  }
}

function buildLongRunningQueriesQuery(
  type: Exclude<LoadedConfig["databases"][number]["type"], "redis">,
  minDurationSeconds: number
): { sql: string; params?: unknown[] } {
  switch (type) {
    case "mysql":
      return {
        sql: `
          SELECT
            id AS sessionId,
            user AS username,
            db AS databaseName,
            state,
            time AS durationSeconds,
            info AS sqlText
          FROM information_schema.processlist
          WHERE command <> 'Sleep'
            AND time >= ?
          ORDER BY time DESC
        `,
        params: [minDurationSeconds]
      };
    case "postgresql":
    case "opengauss":
      return {
        sql: `
          SELECT
            pid AS sessionId,
            usename AS username,
            datname AS databaseName,
            state,
            EXTRACT(EPOCH FROM (clock_timestamp() - query_start))::bigint AS durationSeconds,
            query AS sqlText
          FROM pg_stat_activity
          WHERE query_start IS NOT NULL
            AND pid <> pg_backend_pid()
            AND EXTRACT(EPOCH FROM (clock_timestamp() - query_start)) >= $1
          ORDER BY durationSeconds DESC
        `,
        params: [minDurationSeconds]
      };
    case "oracle":
      return {
        sql: `
          SELECT
            s.sid || ',' || s.serial# AS sessionId,
            s.username AS username,
            s.schemaname AS databaseName,
            s.status AS state,
            FLOOR(s.last_call_et) AS durationSeconds,
            q.sql_text AS sqlText
          FROM v$session s
          LEFT JOIN v$sql q ON s.sql_id = q.sql_id
          WHERE s.type = 'USER'
            AND s.last_call_et >= :1
          ORDER BY s.last_call_et DESC
        `,
        params: [minDurationSeconds]
      };
    default:
      return { sql: "" };
  }
}

function buildBlockingSessionsQuery(
  type: Exclude<LoadedConfig["databases"][number]["type"], "redis">
): { sql: string; params?: unknown[] } {
  switch (type) {
    case "mysql":
      return {
        sql: `
          SELECT
            r.trx_mysql_thread_id AS blockedSessionId,
            pr.user AS blockedUser,
            b.trx_mysql_thread_id AS blockingSessionId,
            pb.user AS blockingUser,
            w.requesting_engine_lock_id AS waitDetails,
            pr.info AS blockedSqlText,
            pb.info AS blockingSqlText
          FROM information_schema.innodb_lock_waits w
          JOIN information_schema.innodb_trx b ON w.blocking_trx_id = b.trx_id
          JOIN information_schema.innodb_trx r ON w.requesting_trx_id = r.trx_id
          LEFT JOIN information_schema.processlist pr ON pr.id = r.trx_mysql_thread_id
          LEFT JOIN information_schema.processlist pb ON pb.id = b.trx_mysql_thread_id
        `
      };
    case "postgresql":
    case "opengauss":
      return {
        sql: `
          SELECT
            blocked.pid AS blockedSessionId,
            blocked.usename AS blockedUser,
            blocker.pid AS blockingSessionId,
            blocker.usename AS blockingUser,
            blocked_locks.locktype AS waitDetails,
            blocked.query AS blockedSqlText,
            blocker.query AS blockingSqlText
          FROM pg_catalog.pg_locks blocked_locks
          JOIN pg_catalog.pg_stat_activity blocked
            ON blocked.pid = blocked_locks.pid
          JOIN pg_catalog.pg_locks blocker_locks
            ON blocker_locks.locktype = blocked_locks.locktype
           AND blocker_locks.database IS NOT DISTINCT FROM blocked_locks.database
           AND blocker_locks.relation IS NOT DISTINCT FROM blocked_locks.relation
           AND blocker_locks.page IS NOT DISTINCT FROM blocked_locks.page
           AND blocker_locks.tuple IS NOT DISTINCT FROM blocked_locks.tuple
           AND blocker_locks.virtualxid IS NOT DISTINCT FROM blocked_locks.virtualxid
           AND blocker_locks.transactionid IS NOT DISTINCT FROM blocked_locks.transactionid
           AND blocker_locks.classid IS NOT DISTINCT FROM blocked_locks.classid
           AND blocker_locks.objid IS NOT DISTINCT FROM blocked_locks.objid
           AND blocker_locks.objsubid IS NOT DISTINCT FROM blocked_locks.objsubid
           AND blocker_locks.pid <> blocked_locks.pid
          JOIN pg_catalog.pg_stat_activity blocker
            ON blocker.pid = blocker_locks.pid
          WHERE NOT blocked_locks.granted
            AND blocker_locks.granted
        `
      };
    case "oracle":
      return {
        sql: `
          SELECT
            waiting.sid || ',' || waiting.serial# AS blockedSessionId,
            waiting.username AS blockedUser,
            holding.sid || ',' || holding.serial# AS blockingSessionId,
            holding.username AS blockingUser,
            waiting.event AS waitDetails,
            waiting_sql.sql_text AS blockedSqlText,
            holding_sql.sql_text AS blockingSqlText
          FROM v$session waiting
          JOIN v$session holding ON waiting.blocking_session = holding.sid
          LEFT JOIN v$sql waiting_sql ON waiting.sql_id = waiting_sql.sql_id
          LEFT JOIN v$sql holding_sql ON holding.sql_id = holding_sql.sql_id
          WHERE waiting.blocking_session IS NOT NULL
        `
      };
    default:
      return { sql: "" };
  }
}

function buildShowLocksQuery(
  type: Exclude<LoadedConfig["databases"][number]["type"], "redis">
): { sql: string; params?: unknown[] } {
  switch (type) {
    case "mysql":
      return {
        sql: `
          SELECT
            engine_transaction_id AS sessionId,
            lock_type AS lockType,
            lock_mode AS mode,
            lock_status AS status,
            object_schema AS objectSchema,
            object_name AS objectName,
            index_name,
            lock_data
          FROM performance_schema.data_locks
        `
      };
    case "postgresql":
    case "opengauss":
      return {
        sql: `
          SELECT
            l.pid AS sessionId,
            l.locktype AS lockType,
            l.mode,
            CASE WHEN l.granted THEN 'granted' ELSE 'waiting' END AS status,
            n.nspname AS objectSchema,
            c.relname AS objectName,
            l.page,
            l.tuple,
            l.virtualxid,
            l.transactionid
          FROM pg_locks l
          LEFT JOIN pg_class c ON l.relation = c.oid
          LEFT JOIN pg_namespace n ON c.relnamespace = n.oid
        `
      };
    case "oracle":
      return {
        sql: `
          SELECT
            lo.session_id AS sessionId,
            lo.locked_mode AS mode,
            'LOCKED' AS status,
            o.owner AS objectSchema,
            o.object_name AS objectName,
            o.object_type AS lockType,
            lo.oracle_username AS username
          FROM v$locked_object lo
          JOIN all_objects o ON lo.object_id = o.object_id
        `
      };
    default:
      return { sql: "" };
  }
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
      "show_create_table",
      buildToolDescription({
        whenToUse:
          "Use this when you need the database-side table or view definition instead of just column metadata, especially before schema changes, migration work, or exact DDL review.",
        whenNotToUse:
          "Do not use this when you only need columns or indexes. Use describe_table and list_indexes for cheaper structured metadata.",
        inputExpectations:
          "Requires databaseKey and table. Optional schema. The object name should be a table or view name, not a full SQL statement. Some databases may return NOT_SUPPORTED if exact DDL extraction is not available in the current implementation.",
        databaseSupport: "SQL databases only. MySQL and Oracle are supported. PostgreSQL and openGauss currently return NOT_SUPPORTED."
      }),
      describeTableSchema,
      async (args, context) => {
        const database = assertSqlTarget(args.databaseKey, context.getConfig());
        const query = buildShowCreateTableQuery(database.type, args.schema, args.table);
        if (!query) {
          throw new ApplicationError("NOT_SUPPORTED", `show_create_table is not supported for ${database.type} in the current implementation`);
        }

        return context.useSqlDatabase(args.databaseKey, async (adapter) => {
          const result = await adapter.executeQuery(query.sql, query.params, 10);

          if (database.type === "mysql") {
            const row = result.rows[0] ?? {};
            return {
              databaseKey: args.databaseKey,
              type: adapter.config.type,
              objectType: "TABLE",
              schema: args.schema ?? null,
              name: args.table,
              definition: String(row["Create Table"] ?? row["Create View"] ?? "")
            };
          }

          const row = result.rows[0] ?? {};
          return {
            databaseKey: args.databaseKey,
            type: adapter.config.type,
            objectType: String(row.objecttype ?? row.objectType ?? "TABLE"),
            schema: row.schema ?? args.schema ?? null,
            name: String(row.name ?? args.table),
            definition: String(row.definition ?? "")
          };
        });
      }
    ),
    makeTool(
      "list_views",
      buildToolDescription({
        whenToUse:
          "Use this when you need to discover available SQL views before reporting, debugging view logic, or choosing between base tables and views.",
        whenNotToUse:
          "Do not use this for Redis or when you specifically need all tables and views together. Use list_tables for the broader object list.",
        inputExpectations:
          "Requires databaseKey. Optional schema. Returns one item per view name under the given schema or the database default schema.",
        databaseSupport: "SQL databases only: MySQL, Oracle, PostgreSQL, and openGauss."
      }),
      listTablesSchema,
      async (args, context) => {
        const database = assertSqlTarget(args.databaseKey, context.getConfig());
        const query = buildListViewsQuery(database.type, args.schema);
        return context.useSqlDatabase(args.databaseKey, async (adapter) => ({
          databaseKey: args.databaseKey,
          type: adapter.config.type,
          ...(await adapter.executeQuery(query.sql, query.params, 1000))
        }));
      }
    ),
    makeTool(
      "search_tables",
      buildToolDescription({
        whenToUse:
          "Use this when you know part of a table or view name and need to discover matching objects before writing SQL against an unfamiliar schema.",
        whenNotToUse:
          "Do not use this for Redis or when you already know the exact object name. Use list_tables or list_views for complete lists within one schema.",
        inputExpectations:
          "Requires databaseKey and a partial name pattern. Optional schema. The service applies the wildcard matching for you, so pass the meaningful text fragment instead of a full SQL LIKE expression.",
        databaseSupport: "SQL databases only: MySQL, Oracle, PostgreSQL, and openGauss."
      }),
      schemaPatternSchema,
      async (args, context) => {
        const database = assertSqlTarget(args.databaseKey, context.getConfig());
        const query = buildSearchTablesQuery(database.type, args.pattern, args.schema);
        return context.useSqlDatabase(args.databaseKey, async (adapter) => ({
          databaseKey: args.databaseKey,
          type: adapter.config.type,
          ...(await adapter.executeQuery(query.sql, query.params, 1000))
        }));
      }
    ),
    makeTool(
      "search_columns",
      buildToolDescription({
        whenToUse:
          "Use this when you know part of a column name such as user_id, status, created_at, or tenant_id and need to find where it appears across a schema.",
        whenNotToUse:
          "Do not use this for Redis or when you already know the exact table and only need its columns. Use describe_table for that.",
        inputExpectations:
          "Requires databaseKey and a partial column-name pattern. Optional schema. The service applies wildcard matching for you.",
        databaseSupport: "SQL databases only: MySQL, Oracle, PostgreSQL, and openGauss."
      }),
      schemaPatternSchema,
      async (args, context) => {
        const database = assertSqlTarget(args.databaseKey, context.getConfig());
        const query = buildSearchColumnsQuery(database.type, args.pattern, args.schema);
        return context.useSqlDatabase(args.databaseKey, async (adapter) => ({
          databaseKey: args.databaseKey,
          type: adapter.config.type,
          ...(await adapter.executeQuery(query.sql, query.params, 1000))
        }));
      }
    ),
    makeTool(
      "show_variables",
      buildToolDescription({
        whenToUse:
          "Use this to inspect database runtime parameters such as character set, time zone, transaction settings, memory settings, SQL mode, or database-specific tuning variables.",
        whenNotToUse:
          "Do not use this when you need schema metadata or query plans. This tool is for instance or session configuration inspection.",
        inputExpectations:
          "Requires databaseKey. Optional pattern filters variable names. Returns name-value rows.",
        databaseSupport: "SQL databases only: MySQL, Oracle, PostgreSQL, and openGauss."
      }),
      showVariablesSchema,
      async (args, context) => {
        const database = assertSqlTarget(args.databaseKey, context.getConfig());
        const query = buildShowVariablesQuery(database.type, args.pattern);
        return context.useSqlDatabase(args.databaseKey, async (adapter) => ({
          databaseKey: args.databaseKey,
          type: adapter.config.type,
          ...(await adapter.executeQuery(query.sql, query.params, 1000))
        }));
      }
    ),
    makeTool(
      "find_long_running_queries",
      buildToolDescription({
        whenToUse:
          "Use this during database troubleshooting when you want to see currently running sessions or statements that have been active longer than a threshold.",
        whenNotToUse:
          "Do not use this for historical slow-query analysis or for metadata discovery. It only reports currently running sessions visible to the configured account.",
        inputExpectations:
          "Requires databaseKey. Optional minDurationSeconds defaults to 30. Returns current long-running session rows when the database exposes them to the configured user.",
        databaseSupport: "SQL databases only: MySQL, Oracle, PostgreSQL, and openGauss."
      }),
      longRunningQueriesSchema,
      async (args, context) => {
        const database = assertSqlTarget(args.databaseKey, context.getConfig());
        const query = buildLongRunningQueriesQuery(database.type, args.minDurationSeconds ?? 30);
        return context.useSqlDatabase(args.databaseKey, async (adapter) => ({
          databaseKey: args.databaseKey,
          type: adapter.config.type,
          ...(await adapter.executeQuery(query.sql, query.params, 1000))
        }));
      }
    ),
    makeTool(
      "find_blocking_sessions",
      buildToolDescription({
        whenToUse:
          "Use this when you suspect lock waits, blocking, or deadlock-like symptoms and you need to identify which session is blocking which other session right now.",
        whenNotToUse:
          "Do not use this for normal metadata discovery or for historical lock analysis. This tool only reports currently visible blocking relationships.",
        inputExpectations:
          "Requires databaseKey only. Returns zero or more blocking relationships when supported by the target database and the configured account has sufficient visibility.",
        databaseSupport: "SQL databases only: MySQL, Oracle, PostgreSQL, and openGauss."
      }),
      databaseKeySchema,
      async (args, context) => {
        const database = assertSqlTarget(args.databaseKey, context.getConfig());
        const query = buildBlockingSessionsQuery(database.type);
        return context.useSqlDatabase(args.databaseKey, async (adapter) => ({
          databaseKey: args.databaseKey,
          type: adapter.config.type,
          ...(await adapter.executeQuery(query.sql, query.params, 1000))
        }));
      }
    ),
    makeTool(
      "show_locks",
      buildToolDescription({
        whenToUse:
          "Use this when diagnosing lock contention, blocked DDL, row locks, metadata locks, or object-level locking behavior that may affect application performance.",
        whenNotToUse:
          "Do not use this as a substitute for query plans or table metadata. This tool is specifically for currently visible lock state.",
        inputExpectations:
          "Requires databaseKey only. Returns current lock rows as exposed by the target database and the permissions of the configured account.",
        databaseSupport: "SQL databases only: MySQL, Oracle, PostgreSQL, and openGauss."
      }),
      databaseKeySchema,
      async (args, context) => {
        const database = assertSqlTarget(args.databaseKey, context.getConfig());
        const query = buildShowLocksQuery(database.type);
        return context.useSqlDatabase(args.databaseKey, async (adapter) => ({
          databaseKey: args.databaseKey,
          type: adapter.config.type,
          ...(await adapter.executeQuery(query.sql, query.params, 1000))
        }));
      }
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
