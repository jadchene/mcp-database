import type { Connection, QueryOptions, RowDataPacket } from "mysql2";

import type { MysqlDatabaseConfig } from "../../config/configTypes.js";
import { ApplicationError, toApplicationError } from "../../core/errors.js";
import { BaseSqlAdapter } from "./baseSqlAdapter.js";

export class MysqlAdapter extends BaseSqlAdapter {
  private connection: Connection | null = null;

  public constructor(private readonly mysqlConfig: MysqlDatabaseConfig, queryTimeoutMs: number | null) {
    super(mysqlConfig, queryTimeoutMs);
  }

  public override async connect(): Promise<void> {
    try {
      const module = await import("mysql2");
      const mysql = module.default ?? module;
      const ssl =
        this.mysqlConfig.connection.ssl === true
          ? {}
          : this.mysqlConfig.connection.ssl && typeof this.mysqlConfig.connection.ssl === "object"
            ? this.mysqlConfig.connection.ssl
            : undefined;
      this.connection = await new Promise<Connection>((resolve, reject) => {
        const connection = mysql.createConnection({
          host: this.mysqlConfig.connection.host,
          port: this.mysqlConfig.connection.port ?? 3306,
          database: this.mysqlConfig.connection.databaseName,
          user: this.mysqlConfig.connection.user,
          password: this.mysqlConfig.connection.password,
          connectTimeout: this.mysqlConfig.connection.connectTimeoutMs,
          ssl
        });
        connection.connect((error) => {
          if (error) {
            connection.destroy();
            reject(error);
            return;
          }
          resolve(connection);
        });
      });

      if (this.mysqlConfig.readonly) {
        await this.query("SET SESSION TRANSACTION READ ONLY");
      }

      if (this.queryTimeoutMs) {
        await this.query("SET SESSION MAX_EXECUTION_TIME = ?", [this.queryTimeoutMs]);
      }
    } catch (error) {
      throw toApplicationError(error, "CONNECTION_ERROR");
    }
  }

  public override async close(): Promise<void> {
    if (!this.connection) {
      return;
    }

    const connection = this.connection;
    this.connection = null;
    await new Promise<void>((resolve, reject) => {
      connection.end((error) => error ? reject(error) : resolve());
    });
  }

  protected override async executeRaw(
    sql: string,
    params?: unknown[] | Record<string, unknown>
  ): Promise<Record<string, unknown>[]> {
    if (!this.connection) {
      throw new ApplicationError("CONNECTION_ERROR", "MySQL connection is not open");
    }

    const rows = await this.query(sql, Array.isArray(params) ? params : []);
    return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
  }

  protected override async executeStatementRaw(
    sql: string,
    params?: unknown[] | Record<string, unknown>
  ): Promise<{ affectedRows: number | null }> {
    if (!this.connection) {
      throw new ApplicationError("CONNECTION_ERROR", "MySQL connection is not open");
    }

    const result = await this.query(sql, Array.isArray(params) ? params : []);
    const affectedRows =
      typeof result === "object" && result !== null && "affectedRows" in result
        ? Number((result as { affectedRows?: number }).affectedRows ?? 0)
        : null;

    return { affectedRows };
  }

  protected override async executeLimitedQueryRaw(
    sql: string,
    params: unknown[] | undefined,
    maxRows: number
  ): Promise<{ rows: Record<string, unknown>[]; truncated: boolean }> {
    if (!this.connection) {
      throw new ApplicationError("CONNECTION_ERROR", "MySQL connection is not open");
    }

    const connection = this.connection;
    return new Promise((resolve, reject) => {
      const rows: Record<string, unknown>[] = [];
      let settled = false;
      const options: QueryOptions = {
        sql,
        values: (params ?? []) as never,
        timeout: this.queryTimeoutMs ?? undefined
      };
      const stream = connection.query(options).stream({ objectMode: true, highWaterMark: 16 });

      stream.on("data", (row: RowDataPacket) => {
        rows.push(row as Record<string, unknown>);
        if (rows.length <= maxRows || settled) {
          return;
        }

        settled = true;
        stream.destroy();
        connection.destroy();
        if (this.connection === connection) {
          this.connection = null;
        }
        resolve({ rows: rows.slice(0, maxRows), truncated: true });
      });
      stream.once("end", () => {
        if (!settled) {
          settled = true;
          resolve({ rows, truncated: false });
        }
      });
      stream.once("error", (error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      });
    });
  }

  protected override async beginReadonlyTransaction(): Promise<void> {
    await this.query("START TRANSACTION READ ONLY");
  }

  protected override async rollbackReadonlyTransaction(): Promise<void> {
    if (this.connection) {
      await this.query("ROLLBACK");
    }
  }

  protected override async cancelCurrentOperation(): Promise<void> {
    if (this.connection) {
      this.connection.destroy();
      this.connection = null;
    }
  }

  protected override async explainQueryRows(
    sql: string,
    params: unknown[] | undefined,
    maxRows: number
  ): Promise<{ rows: Record<string, unknown>[]; truncated: boolean }> {
    return this.executeLimitedQueryRaw(`EXPLAIN ${sql}`, params, maxRows);
  }

  protected override async analyzeQueryRows(
    sql: string,
    params: unknown[] | undefined,
    maxRows: number
  ): Promise<{ rows: Record<string, unknown>[]; truncated: boolean }> {
    return this.executeLimitedQueryRaw(`EXPLAIN ANALYZE ${sql}`, params, maxRows);
  }

  protected override pingSql(): string {
    return "SELECT 1 AS ok";
  }

  protected override listSchemasSql(): string {
    return "SELECT schema_name FROM information_schema.schemata ORDER BY schema_name";
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

  private async query(sql: string, params: unknown[] = []): Promise<unknown> {
    if (!this.connection) {
      throw new ApplicationError("CONNECTION_ERROR", "MySQL connection is not open");
    }

    return new Promise((resolve, reject) => {
      this.connection!.query(sql, params as never, (error, result) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(result);
      });
    });
  }
}
