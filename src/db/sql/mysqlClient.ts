import type { Connection } from "mysql2/promise";

import type { MysqlDatabaseConfig } from "../../config/configTypes.js";
import { ApplicationError, toApplicationError } from "../../core/errors.js";
import { BaseSqlAdapter } from "./baseSqlAdapter.js";

export class MysqlAdapter extends BaseSqlAdapter {
  private connection: Connection | null = null;

  public constructor(private readonly mysqlConfig: MysqlDatabaseConfig) {
    super(mysqlConfig);
  }

  public override async connect(): Promise<void> {
    try {
      const mysql = await import("mysql2/promise");
      const ssl =
        this.mysqlConfig.connection.ssl === true
          ? {}
          : this.mysqlConfig.connection.ssl && typeof this.mysqlConfig.connection.ssl === "object"
            ? this.mysqlConfig.connection.ssl
            : undefined;
      this.connection = await mysql.createConnection({
        host: this.mysqlConfig.connection.host,
        port: this.mysqlConfig.connection.port ?? 3306,
        database: this.mysqlConfig.connection.databaseName,
        user: this.mysqlConfig.connection.user,
        password: this.mysqlConfig.connection.password,
        connectTimeout: this.mysqlConfig.connection.connectTimeoutMs,
        ssl
      });

      if (this.mysqlConfig.readonly) {
        await this.connection.query("SET SESSION TRANSACTION READ ONLY");
      }
    } catch (error) {
      throw toApplicationError(error, "CONNECTION_ERROR");
    }
  }

  public override async close(): Promise<void> {
    if (!this.connection) {
      return;
    }

    await this.connection.end();
    this.connection = null;
  }

  protected override async executeRaw(
    sql: string,
    params?: unknown[] | Record<string, unknown>
  ): Promise<Record<string, unknown>[]> {
    if (!this.connection) {
      throw new ApplicationError("CONNECTION_ERROR", "MySQL connection is not open");
    }

    const [rows] = await this.connection.query(sql, Array.isArray(params) ? params : []);
    return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
  }

  protected override async executeStatementRaw(
    sql: string,
    params?: unknown[] | Record<string, unknown>
  ): Promise<{ affectedRows: number | null }> {
    if (!this.connection) {
      throw new ApplicationError("CONNECTION_ERROR", "MySQL connection is not open");
    }

    const [result] = await this.connection.query(sql, Array.isArray(params) ? params : []);
    const affectedRows =
      typeof result === "object" && result !== null && "affectedRows" in result
        ? Number((result as { affectedRows?: number }).affectedRows ?? 0)
        : null;

    return { affectedRows };
  }

  protected override async explainQueryRows(
    sql: string,
    params?: unknown[] | Record<string, unknown>
  ): Promise<Record<string, unknown>[]> {
    return this.executeRaw(`EXPLAIN ${sql}`, params);
  }

  protected override async analyzeQueryRows(
    sql: string,
    params?: unknown[] | Record<string, unknown>
  ): Promise<Record<string, unknown>[]> {
    return this.executeRaw(`EXPLAIN ANALYZE ${sql}`, params);
  }

  protected override pingSql(): string {
    return "SELECT 1 AS ok";
  }

  protected override listSchemasSql(): string {
    return "SELECT schema_name AS schema FROM information_schema.schemata ORDER BY schema_name";
  }

  protected override listTablesSql(schema?: string): { sql: string; params?: unknown[] } {
    return {
      sql: `
        SELECT table_schema AS schema_name, table_name AS name, table_type AS type
        FROM information_schema.tables
        WHERE table_schema = COALESCE(?, DATABASE())
        ORDER BY table_name
      `,
      params: [schema ?? null]
    };
  }

  protected override describeTableSql(schema: string | undefined, table: string): { sql: string; params?: unknown[] } {
    return {
      sql: `
        SELECT
          c.column_name AS name,
          c.data_type AS dataType,
          c.is_nullable AS nullable,
          c.column_default AS defaultValue,
          c.column_comment AS comment,
          CASE WHEN k.column_name IS NOT NULL THEN 1 ELSE 0 END AS primaryKey
        FROM information_schema.columns c
        LEFT JOIN information_schema.key_column_usage k
          ON c.table_schema = k.table_schema
         AND c.table_name = k.table_name
         AND c.column_name = k.column_name
         AND k.constraint_name = 'PRIMARY'
        WHERE c.table_schema = COALESCE(?, DATABASE())
          AND c.table_name = ?
        ORDER BY c.ordinal_position
      `,
      params: [schema ?? null, table]
    };
  }

  protected override listIndexesSql(schema: string | undefined, table: string): { sql: string; params?: unknown[] } {
    return {
      sql: `
        SELECT
          table_schema AS schema_name,
          table_name AS table_name,
          index_name AS index_name,
          column_name AS column_name,
          CASE WHEN non_unique = 0 THEN 1 ELSE 0 END AS is_unique,
          seq_in_index AS column_position,
          collation AS sort_order,
          index_type AS index_type
        FROM information_schema.statistics
        WHERE table_schema = COALESCE(?, DATABASE())
          AND table_name = ?
        ORDER BY index_name, seq_in_index
      `,
      params: [schema ?? null, table]
    };
  }

  protected override tableStatisticsSql(schema: string | undefined, table: string): { sql: string; params?: unknown[] } {
    return {
      sql: `
        SELECT
          table_schema AS schema_name,
          table_name AS table_name,
          engine,
          table_rows AS approximateRowCount,
          data_length AS dataLength,
          index_length AS indexLength,
          data_free AS dataFree,
          create_time AS createTime,
          update_time AS updateTime,
          table_collation AS collation
        FROM information_schema.tables
        WHERE table_schema = COALESCE(?, DATABASE())
          AND table_name = ?
      `,
      params: [schema ?? null, table]
    };
  }
}
