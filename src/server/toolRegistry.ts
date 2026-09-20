import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";

import { fingerprintDatabaseTarget } from "../config/databaseFingerprint.js";
import { summarizeDatabaseListItem, summarizeLoadedConfig } from "../config/configSummary.js";
import type { LoadedConfig } from "../config/configTypes.js";
import { ApplicationError } from "../core/errors.js";
import type { RedisDatabaseAdapter, SqlDatabaseAdapter } from "../db/types.js";
import { scanScriptRisk } from "../db/scriptGuard.js";

const emptySchema = z.object({}).strict();
const databaseKeySchema = z.object({
  databaseKey: z
    .string()
    .min(1)
    .describe("Target key from list_databases.key; use databaseName for SQL identifiers.")
}).strict();
const metadataMaxRowsSchema = z
  .number()
  .int()
  .min(1)
  .max(1000)
  .optional()
  .describe("Row limit; defaults to 200.");
const listSchemasSchema = databaseKeySchema.extend({ maxRows: metadataMaxRowsSchema });
const listTablesSchema = z.object({
  databaseKey: z
    .string()
    .min(1)
    .describe("Target key from list_databases.key; use databaseName for SQL identifiers."),
  schema: z
    .string()
    .min(1)
    .optional()
    .describe("Schema name; omitted uses the current/default schema."),
  maxRows: metadataMaxRowsSchema
}).strict();
const describeTableSchema = z.object({
  databaseKey: z
    .string()
    .min(1)
    .describe("Target key from list_databases.key; use databaseName for SQL identifiers."),
  schema: z
    .string()
    .min(1)
    .optional()
    .describe("Schema name; omitted uses the current/default schema."),
  table: z
    .string()
    .min(1)
    .describe("Table or view name.")
}).strict();
const limitedDescribeTableSchema = describeTableSchema.extend({ maxRows: metadataMaxRowsSchema });
const listIndexesSchema = limitedDescribeTableSchema;
const getTableStatisticsSchema = describeTableSchema;
const schemaPatternSchema = z.object({
  databaseKey: z
    .string()
    .min(1)
    .describe("Target key from list_databases.key; use databaseName for SQL identifiers."),
  schema: z
    .string()
    .min(1)
    .optional()
    .describe("Schema name; omitted uses the current/default schema."),
  pattern: z
    .string()
    .min(1)
    .describe("Case-insensitive name fragment; no SQL LIKE expression.")
}).strict();
const showVariablesSchema = z.object({
  databaseKey: z
    .string()
    .min(1)
    .describe("Target key from list_databases.key; use databaseName for SQL identifiers."),
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
    .describe("Target key from list_databases.key; use databaseName for SQL identifiers."),
  minDurationSeconds: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Minimum runtime in seconds; defaults to 30.")
}).strict();
const executeQuerySchema = z.object({
  databaseKey: z
    .string()
    .min(1)
    .describe("Target key from list_databases.key; use databaseName for SQL identifiers."),
  sql: z
    .string()
    .min(1)
    .describe("Original SQL without an EXPLAIN wrapper."),
  params: z
    .array(z.unknown())
    .optional()
    .describe("Positional values for SQL placeholders."),
  maxRows: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe("Row limit; defaults to 200.")
}).strict();
const explainQuerySchema = executeQuerySchema;
const analyzeQuerySchema = executeQuerySchema;
const executeStatementSchema = z.object({
  databaseKey: z
    .string()
    .min(1)
    .describe("Target key from list_databases.key; use databaseName for SQL identifiers."),
  sql: z
    .string()
    .min(1)
    .describe("One non-query SQL statement such as INSERT, UPDATE, DELETE, MERGE, or DDL. Do not pass SELECT here."),
  params: z
    .array(z.unknown())
    .optional()
    .describe("Positional values for SQL placeholders.")
}).strict();
const executeScriptSchema = z
  .object({
    databaseKey: z
      .string()
      .min(1)
      .describe(
        "Target key from list_databases.key; use databaseName for SQL identifiers."
      ),
    sql: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Whole SQL script; provide exactly one of sql or sqlFile. Session variables persist across statements."
      ),
    sqlFile: z
      .string()
      .min(1)
      .optional()
      .describe(
        "UTF-8 .sql file on the MCP server machine, up to 2 MiB; provide exactly one of sql or sqlFile."
      ),
    useTransaction: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Wrap the script in a transaction; defaults to false. MySQL DDL implicitly commits and cannot be rolled back."
      )
  })
  .strict()
  .superRefine((value, context) => {
    const hasSql = typeof value.sql === "string" && value.sql.length > 0;
    const hasSqlFile = typeof value.sqlFile === "string" && value.sqlFile.length > 0;

    if (hasSql === hasSqlFile) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [hasSql ? "sql" : "sqlFile"],
        message: "Exactly one of sql or sqlFile must be provided"
      });
    }
  });
const redisKeySchema = z.object({
  databaseKey: z
    .string()
    .min(1)
    .describe("Redis target key from list_databases.key."),
  key: z
    .string()
    .min(1)
    .describe("Exact Redis key name.")
}).strict();
const redisScanSchema = z.object({
  databaseKey: z
    .string()
    .min(1)
    .describe("Redis target key from list_databases.key."),
  cursor: z
    .string()
    .optional()
    .describe("SCAN cursor; omit or use the string 0 on the first call."),
  pattern: z
    .string()
    .min(1)
    .optional()
    .describe("Redis glob pattern, e.g. user:*."),
  count: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe("SCAN count hint; defaults to 100.")
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
  }): Promise<{ status: "confirmed"; databaseFingerprint: string }>;
  confirmScriptExecution(input: {
    databaseKey: string;
    sourceKind: "file" | "inline";
    sourceLabel: string;
    scriptLength: number;
    statementCount: number;
    ddlKeywords: string[];
    highRiskKeywords: string[];
  }): Promise<{ status: "confirmed"; databaseFingerprint: string }>;
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
    inputSchema: zodToJsonSchema(schema, {
      target: "jsonSchema7",
      $refStrategy: "none"
    }) as Record<string, unknown>,
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

interface ScriptSourceInput {
  sql?: string;
  sqlFile?: string;
}

interface ResolvedScriptSource {
  scriptText: string;
  sourceKind: "file" | "inline";
  sourceLabel: string;
}

/**
 * 解析 execute_script 的输入来源：整段字符串或本地 .sql 文件。
 * 只读取可信任的 .sql 文本文件，限制文件大小避免内存风险。
 */
async function resolveScriptSource(input: ScriptSourceInput): Promise<ResolvedScriptSource> {
  if (typeof input.sqlFile === "string" && input.sqlFile.length > 0) {
    const filename = resolve(input.sqlFile);
    if (extname(filename).toLowerCase() !== ".sql") {
      throw new ApplicationError("INVALID_ARGUMENT", "sqlFile must point to a .sql file");
    }

    let contents: string;
    try {
      const buffer = await readFile(filename);
      if (buffer.length > 2 * 1024 * 1024) {
        throw new ApplicationError("INVALID_ARGUMENT", "sqlFile exceeds the 2 MiB size limit");
      }
      contents = buffer.toString("utf8");
    } catch (error) {
      if (error instanceof ApplicationError) {
        throw error;
      }
      throw new ApplicationError("INVALID_ARGUMENT", `Unable to read sqlFile: ${filename}`);
    }

    return {
      scriptText: contents,
      sourceKind: "file",
      sourceLabel: filename
    };
  }

  return {
    scriptText: input.sql ?? "",
    sourceKind: "inline",
    sourceLabel: "inline SQL"
  };
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
      "Inspect the active config path, load time, and sanitized target settings.",
      emptySchema,
      async (_args, context) => {
        const config = context.getConfig();
        return summarizeLoadedConfig(config);
      }
    ),
    makeTool(
      "reload_config",
      "Reload the active config file. Invalid updates leave the previous configuration active.",
      emptySchema,
      async (_args, context) => {
        const config = await context.reloadConfig();
        return summarizeLoadedConfig(config);
      }
    ),
    makeTool(
      "list_databases",
      "List configured SQL and Redis targets without connecting. Use key as databaseKey in tool calls and databaseName in SQL.",
      emptySchema,
      async (_args, context) => ({
        items: context.getConfig().databases.map((database) => summarizeDatabaseListItem(database))
      })
    ),
    makeTool(
      "ping_database",
      "Test SQL or Redis connectivity and report latency.",
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
      "List schemas visible to the SQL target's user. Results may be truncated.",
      listSchemasSchema,
      async (args, context) =>
      context.useSqlDatabase(args.databaseKey, async (adapter) => ({
        databaseKey: args.databaseKey,
        type: adapter.config.type,
        ...(await adapter.listSchemas(args.maxRows ?? 200))
      }))
    ),
    makeTool(
      "list_tables",
      "List SQL tables and views in a schema. Results may be truncated.",
      listTablesSchema,
      async (args, context) =>
      context.useSqlDatabase(args.databaseKey, async (adapter) => ({
        databaseKey: args.databaseKey,
        type: adapter.config.type,
        ...(await adapter.listTables(args.schema, args.maxRows ?? 200))
      }))
    ),
    makeTool(
      "describe_table",
      "Inspect SQL columns, types, defaults, nullability, comments, and primary keys. Results may be truncated.",
      limitedDescribeTableSchema,
      async (args, context) =>
      context.useSqlDatabase(args.databaseKey, async (adapter) => ({
        databaseKey: args.databaseKey,
        type: adapter.config.type,
        ...(await adapter.describeTable(args.schema, args.table, args.maxRows ?? 200))
      }))
    ),
    makeTool(
      "list_indexes",
      "Inspect SQL indexes. Some engines return full definitions instead of per-column rows.",
      listIndexesSchema,
      async (args, context) =>
      context.useSqlDatabase(args.databaseKey, async (adapter) => ({
        databaseKey: args.databaseKey,
        type: adapter.config.type,
        ...(await adapter.listIndexes(args.schema, args.table, args.maxRows ?? 200))
      }))
    ),
    makeTool(
      "get_table_statistics",
      "Get approximate, engine-specific SQL table statistics; returns null when unavailable.",
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
      "Get table or view DDL. MySQL and Oracle only; PostgreSQL and openGauss return NOT_SUPPORTED.",
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
      "List SQL views in a schema.",
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
      "Find SQL tables and views by a name fragment.",
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
      "Find SQL columns by a name fragment across a schema.",
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
      "Inspect SQL runtime parameters as name-value rows.",
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
      "List currently running SQL sessions above the duration threshold, subject to account visibility.",
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
      "Find current SQL blocking relationships visible to the configured account.",
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
      "Inspect current SQL locks visible to the configured account.",
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
      "Run one read-only SQL statement: SELECT, SHOW, DESCRIBE, DESC, or WITH ... SELECT.",
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
      "Get a static plan for a read-only SQL query without executing it. Pass original SQL; the server adds EXPLAIN.",
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
      "Execute a read-only query for runtime plan metrics. Pass original SQL. MySQL, PostgreSQL, and openGauss only; Oracle returns NOT_SUPPORTED.",
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
      "Execute one non-query SQL statement on a writable target. Requires interactive confirmation; no execution if confirmation is unavailable or declined.",
      executeStatementSchema,
      async (args, context) => {
      const confirmation = await context.confirmStatementExecution({
        databaseKey: args.databaseKey,
        sql: args.sql,
        params: args.params
      });

      const confirmedDatabase = context.getConfig().databaseMap.get(args.databaseKey);
      if (
        !confirmedDatabase ||
        fingerprintDatabaseTarget(confirmedDatabase) !== confirmation.databaseFingerprint
      ) {
        throw new ApplicationError(
          "INVALID_ARGUMENT",
          "Database target configuration changed after confirmation; request confirmation again"
        );
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
      "execute_script",
      "Execute a whole SQL script on one connection, preserving session state. Writable MySQL targets only; other adapters return NOT_SUPPORTED. Requires interactive confirmation. Scripts are not split; partial results are unavailable.",
      executeScriptSchema,
      async (args, context) => {
        assertSqlTarget(args.databaseKey, context.getConfig());

        const { scriptText, sourceKind, sourceLabel } = await resolveScriptSource(args);
        const scriptSecurity = scanScriptRisk(scriptText);

        const confirmation = await context.confirmScriptExecution({
          databaseKey: args.databaseKey,
          sourceKind,
          sourceLabel,
          scriptLength: scriptText.length,
          statementCount: scriptSecurity.statementCount,
          ddlKeywords: scriptSecurity.ddlKeywords,
          highRiskKeywords: scriptSecurity.highRiskKeywords
        });

        const confirmedDatabase = context.getConfig().databaseMap.get(args.databaseKey);
        if (
          !confirmedDatabase ||
          fingerprintDatabaseTarget(confirmedDatabase) !== confirmation.databaseFingerprint
        ) {
          throw new ApplicationError(
            "INVALID_ARGUMENT",
            "Database target configuration changed after confirmation; request confirmation again"
          );
        }

        if (scriptSecurity.highRiskKeywords.includes("OUTFILE") || scriptSecurity.highRiskKeywords.includes("DUMPFILE")) {
          throw new ApplicationError(
            "INVALID_ARGUMENT",
            "Script contains a write to a server-side file (INTO OUTFILE/DUMPFILE) which is not allowed through execute_script"
          );
        }

        return context.useSqlDatabase(args.databaseKey, async (adapter) => {
          if (adapter.config.readonly) {
            throw new ApplicationError("NOT_SUPPORTED", `${args.databaseKey} is configured as readonly`);
          }

          const result = await adapter.executeScript(scriptText, {
            useTransaction: args.useTransaction ?? false
          });

          return {
            databaseKey: args.databaseKey,
            type: adapter.config.type,
            scriptMode: sourceKind,
            source: sourceLabel,
            ...result
          };
        });
      }
    ),
    makeTool(
      "redis_get",
      "Read an exact Redis string key; returns null if absent.",
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
      "Read all fields of an exact Redis hash key.",
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
      "Discover Redis keys incrementally. Continue with nextCursor until it is 0 or enough keys are found.",
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
