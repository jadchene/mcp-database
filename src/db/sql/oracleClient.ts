import type { OracleDatabaseConfig } from "../../config/configTypes.js";
import { ApplicationError, toApplicationError } from "../../core/errors.js";
import { BaseSqlAdapter } from "./baseSqlAdapter.js";

export class OracleAdapter extends BaseSqlAdapter {
  private connection: { close(): Promise<void>; execute: (...args: unknown[]) => Promise<{ rows?: unknown[] }> } | null = null;

  public constructor(private readonly oracleConfig: OracleDatabaseConfig) {
    super(oracleConfig);
  }

  public override async connect(): Promise<void> {
    try {
      const oracledb = await loadOracleDb(this.oracleConfig);
      const connectString = this.oracleConfig.connection.serviceName
        ? `${this.oracleConfig.connection.host}:${this.oracleConfig.connection.port ?? 1521}/${this.oracleConfig.connection.serviceName}`
        : `${this.oracleConfig.connection.host}:${this.oracleConfig.connection.port ?? 1521}:${this.oracleConfig.connection.sid}`;

      this.connection = await oracledb.getConnection({
        user: this.oracleConfig.connection.user,
        password: this.oracleConfig.connection.password,
        connectString
      });
    } catch (error) {
      throw toApplicationError(error, "CONNECTION_ERROR");
    }
  }

  public override async close(): Promise<void> {
    if (!this.connection) {
      return;
    }

    await this.connection.close();
    this.connection = null;
  }

  protected override async executeRaw(
    sql: string,
    params?: unknown[] | Record<string, unknown>
  ): Promise<Record<string, unknown>[]> {
    if (!this.connection) {
      throw new ApplicationError("CONNECTION_ERROR", "Oracle connection is not open");
    }

    const oracledb = await loadOracleDb(this.oracleConfig);
    const result = await this.connection.execute(sql, params ?? [], {
      outFormat: oracledb.OUT_FORMAT_OBJECT
    });

    return (result.rows ?? []) as Record<string, unknown>[];
  }

  protected override async executeStatementRaw(
    sql: string,
    params?: unknown[] | Record<string, unknown>
  ): Promise<{ affectedRows: number | null }> {
    if (!this.connection) {
      throw new ApplicationError("CONNECTION_ERROR", "Oracle connection is not open");
    }

    const result = await this.connection.execute(sql, params ?? []);
    const affectedRows =
      typeof result === "object" && result !== null && "rowsAffected" in result
        ? Number((result as { rowsAffected?: number }).rowsAffected ?? 0)
        : null;

    return { affectedRows };
  }

  protected override async explainQueryRows(
    sql: string,
    params?: unknown[] | Record<string, unknown>
  ): Promise<Record<string, unknown>[]> {
    await this.executeStatementRaw(`EXPLAIN PLAN FOR ${sql}`, params);
    return this.executeRaw(`
      SELECT plan_table_output AS planLine
      FROM TABLE(DBMS_XPLAN.DISPLAY())
    `);
  }

  protected override async analyzeQueryRows(
    _sql: string,
    _params?: unknown[] | Record<string, unknown>
  ): Promise<Record<string, unknown>[]> {
    throw new ApplicationError(
      "NOT_SUPPORTED",
      "analyze_query is not supported for Oracle in the current implementation"
    );
  }

  protected override pingSql(): string {
    return "SELECT 1 AS ok FROM dual";
  }

  protected override listSchemasSql(): string {
    return "SELECT username AS schema FROM all_users ORDER BY username";
  }

  protected override listTablesSql(schema?: string): { sql: string; params?: Record<string, unknown> } {
    return {
      sql: `
        SELECT owner AS schema_name, table_name AS name, 'TABLE' AS type
        FROM all_tables
        WHERE owner = COALESCE(:schema, SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA'))
        UNION ALL
        SELECT owner AS schema_name, view_name AS name, 'VIEW' AS type
        FROM all_views
        WHERE owner = COALESCE(:schema, SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA'))
        ORDER BY name
      `,
      params: { schema: schema?.toUpperCase() ?? null }
    };
  }

  protected override describeTableSql(
    schema: string | undefined,
    table: string
  ): { sql: string; params?: Record<string, unknown> } {
    return {
      sql: `
        SELECT
          c.column_name AS name,
          c.data_type AS datatype,
          c.nullable AS nullable,
          c.data_default AS defaultValue,
          com.comments AS comment_text,
          CASE
            WHEN EXISTS (
              SELECT 1
              FROM all_constraints cons
              JOIN all_cons_columns cols
                ON cons.owner = cols.owner
               AND cons.constraint_name = cols.constraint_name
              WHERE cons.constraint_type = 'P'
                AND cons.owner = c.owner
                AND cons.table_name = c.table_name
                AND cols.column_name = c.column_name
            ) THEN 1 ELSE 0
          END AS primary_key
        FROM all_tab_columns c
        LEFT JOIN all_col_comments com
          ON com.owner = c.owner
         AND com.table_name = c.table_name
         AND com.column_name = c.column_name
        WHERE c.owner = COALESCE(:schema, SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA'))
          AND c.table_name = :tableName
        ORDER BY c.column_id
      `,
      params: {
        schema: schema?.toUpperCase() ?? null,
        tableName: table.toUpperCase()
      }
    };
  }

  protected override listIndexesSql(
    schema: string | undefined,
    table: string
  ): { sql: string; params?: Record<string, unknown> } {
    return {
      sql: `
        SELECT
          idx.table_owner AS schema_name,
          idx.table_name AS table_name,
          idx.index_name AS index_name,
          col.column_name AS column_name,
          CASE WHEN idx.uniqueness = 'UNIQUE' THEN 1 ELSE 0 END AS is_unique,
          col.column_position AS column_position,
          col.descend AS sort_order,
          idx.index_type AS index_type
        FROM all_indexes idx
        LEFT JOIN all_ind_columns col
          ON idx.owner = col.index_owner
         AND idx.index_name = col.index_name
         AND idx.table_owner = col.table_owner
         AND idx.table_name = col.table_name
        WHERE idx.table_owner = COALESCE(:schema, SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA'))
          AND idx.table_name = :tableName
        ORDER BY idx.index_name, col.column_position
      `,
      params: {
        schema: schema?.toUpperCase() ?? null,
        tableName: table.toUpperCase()
      }
    };
  }

  protected override tableStatisticsSql(
    schema: string | undefined,
    table: string
  ): { sql: string; params?: Record<string, unknown> } {
    return {
      sql: `
        SELECT
          owner AS schema_name,
          table_name AS table_name,
          num_rows AS approximateRowCount,
          blocks,
          avg_row_len AS averageRowLength,
          sample_size AS sampleSize,
          last_analyzed AS lastAnalyzed,
          temporary AS isTemporary,
          partitioned AS isPartitioned
        FROM all_tables
        WHERE owner = COALESCE(:schema, SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA'))
          AND table_name = :tableName
      `,
      params: {
        schema: schema?.toUpperCase() ?? null,
        tableName: table.toUpperCase()
      }
    };
  }
}

let initializedOracleClient:
  | {
      mode: "thin" | "thick";
      clientLibDir?: string;
    }
  | null = null;

async function loadOracleDb(config: OracleDatabaseConfig): Promise<{
  getConnection(options: Record<string, unknown>): Promise<{
    close(): Promise<void>;
    execute: (...args: unknown[]) => Promise<{ rows?: unknown[] }>;
  }>;
  OUT_FORMAT_OBJECT: number;
  initOracleClient?(options?: { libDir?: string }): void;
}> {
  const module = await import("oracledb");
  const oracledb = (module.default ?? module) as {
    getConnection(options: Record<string, unknown>): Promise<{
      close(): Promise<void>;
      execute: (...args: unknown[]) => Promise<{ rows?: unknown[] }>;
    }>;
    OUT_FORMAT_OBJECT: number;
    initOracleClient?(options?: { libDir?: string }): void;
  };

  initializeOracleClientIfNeeded(oracledb, config);
  return oracledb;
}

function initializeOracleClientIfNeeded(
  oracledb: {
    initOracleClient?(options?: { libDir?: string }): void;
  },
  config: OracleDatabaseConfig
): void {
  const desiredMode = config.connection.clientMode ?? (config.connection.clientLibDir ? "thick" : "thin");
  const desiredLibDir = config.connection.clientLibDir;

  if (!initializedOracleClient) {
    if (desiredMode === "thick") {
      oracledb.initOracleClient?.({ libDir: desiredLibDir });
    }

    initializedOracleClient = {
      mode: desiredMode,
      clientLibDir: desiredLibDir
    };
    return;
  }

  if (initializedOracleClient.mode !== desiredMode) {
    throw new ApplicationError(
      "CONFIG_ERROR",
      `Oracle client mode conflict: already initialized as ${initializedOracleClient.mode}, requested ${desiredMode}`
    );
  }

  if (desiredMode === "thick" && initializedOracleClient.clientLibDir !== desiredLibDir) {
    throw new ApplicationError(
      "CONFIG_ERROR",
      "Oracle thick mode already initialized with a different clientLibDir",
      {
        currentLibDir: initializedOracleClient.clientLibDir ?? null,
        requestedLibDir: desiredLibDir ?? null
      }
    );
  }
}
