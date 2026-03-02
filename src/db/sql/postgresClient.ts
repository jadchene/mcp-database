import type { Client } from "pg";

import type { PostgresDatabaseConfig } from "../../config/configTypes.js";
import { ApplicationError, toApplicationError } from "../../core/errors.js";
import { BaseSqlAdapter } from "./baseSqlAdapter.js";

export class PostgresAdapter extends BaseSqlAdapter {
  private client: Client | null = null;

  public constructor(private readonly postgresConfig: PostgresDatabaseConfig, queryTimeoutMs: number | null) {
    super(postgresConfig, queryTimeoutMs);
  }

  public override async connect(): Promise<void> {
    try {
      const { Client: PgClient } = await import("pg");
      this.client = new PgClient({
        host: this.postgresConfig.connection.host,
        port: this.postgresConfig.connection.port ?? 5432,
        database: this.postgresConfig.connection.databaseName,
        user: this.postgresConfig.connection.user,
        password: this.postgresConfig.connection.password,
        connectionTimeoutMillis: this.postgresConfig.connection.connectTimeoutMs,
        ssl: this.postgresConfig.connection.ssl
      });
      await this.client.connect();

      if (this.postgresConfig.readonly) {
        await this.client.query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");
      }

      if (this.queryTimeoutMs) {
        await this.client.query(`SET statement_timeout = ${this.queryTimeoutMs}`);
      }
    } catch (error) {
      throw toApplicationError(error, "CONNECTION_ERROR");
    }
  }

  public override async close(): Promise<void> {
    if (!this.client) {
      return;
    }

    await this.client.end();
    this.client = null;
  }

  protected override async executeRaw(
    sql: string,
    params?: unknown[] | Record<string, unknown>
  ): Promise<Record<string, unknown>[]> {
    if (!this.client) {
      throw new ApplicationError("CONNECTION_ERROR", "PostgreSQL connection is not open");
    }

    const result = await this.client.query(sql, Array.isArray(params) ? params : []);
    return result.rows as Record<string, unknown>[];
  }

  protected override async executeStatementRaw(
    sql: string,
    params?: unknown[] | Record<string, unknown>
  ): Promise<{ affectedRows: number | null }> {
    if (!this.client) {
      throw new ApplicationError("CONNECTION_ERROR", "PostgreSQL connection is not open");
    }

    const result = await this.client.query(sql, Array.isArray(params) ? params : []);
    return {
      affectedRows: typeof result.rowCount === "number" ? result.rowCount : null
    };
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
    return this.executeRaw(`EXPLAIN (ANALYZE, BUFFERS, VERBOSE) ${sql}`, params);
  }

  protected override pingSql(): string {
    return "SELECT 1 AS ok";
  }

  protected override listSchemasSql(): string {
    return `
      SELECT schema_name AS schema
      FROM information_schema.schemata
      WHERE schema_name NOT IN ('information_schema', 'pg_catalog')
      ORDER BY schema_name
    `;
  }

  protected override listTablesSql(schema?: string): { sql: string; params?: unknown[] } {
    return {
      sql: `
        SELECT table_schema AS schema, table_name AS name, table_type AS type
        FROM information_schema.tables
        WHERE table_schema = COALESCE($1, current_schema())
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
          pgd.description AS comment,
          EXISTS (
            SELECT 1
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON tc.constraint_name = kcu.constraint_name
             AND tc.table_schema = kcu.table_schema
            WHERE tc.constraint_type = 'PRIMARY KEY'
              AND tc.table_schema = c.table_schema
              AND tc.table_name = c.table_name
              AND kcu.column_name = c.column_name
          ) AS primaryKey
        FROM information_schema.columns c
        LEFT JOIN pg_catalog.pg_statio_all_tables st
          ON st.relname = c.table_name
         AND st.schemaname = c.table_schema
        LEFT JOIN pg_catalog.pg_description pgd
          ON pgd.objoid = st.relid
         AND pgd.objsubid = c.ordinal_position
        WHERE c.table_schema = COALESCE($1, current_schema())
          AND c.table_name = $2
        ORDER BY c.ordinal_position
      `,
      params: [schema ?? null, table]
    };
  }

  protected override listIndexesSql(schema: string | undefined, table: string): { sql: string; params?: unknown[] } {
    return {
      sql: `
        SELECT
          schemaname AS schema_name,
          tablename AS table_name,
          indexname AS index_name,
          indexdef AS definition
        FROM pg_indexes
        WHERE schemaname = COALESCE($1, current_schema())
          AND tablename = $2
        ORDER BY indexname
      `,
      params: [schema ?? null, table]
    };
  }

  protected override tableStatisticsSql(schema: string | undefined, table: string): { sql: string; params?: unknown[] } {
    return {
      sql: `
        SELECT
          schemaname AS schema_name,
          relname AS table_name,
          n_live_tup AS approximateRowCount,
          n_dead_tup AS deadRowCount,
          seq_scan AS sequentialScans,
          idx_scan AS indexScans,
          pg_total_relation_size(relid) AS totalBytes,
          pg_relation_size(relid) AS tableBytes,
          pg_indexes_size(relid) AS indexBytes,
          last_analyze AS lastAnalyze,
          last_autoanalyze AS lastAutoAnalyze,
          last_vacuum AS lastVacuum,
          last_autovacuum AS lastAutoVacuum
        FROM pg_stat_user_tables
        WHERE schemaname = COALESCE($1, current_schema())
          AND relname = $2
      `,
      params: [schema ?? null, table]
    };
  }
}
