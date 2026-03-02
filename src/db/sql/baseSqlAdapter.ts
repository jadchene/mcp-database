import type {
  MysqlDatabaseConfig,
  OracleDatabaseConfig,
  PostgresDatabaseConfig
} from "../../config/configTypes.js";
import { ApplicationError, toApplicationError } from "../../core/errors.js";
import type {
  ColumnInfo,
  IndexInfo,
  PingResult,
  QueryResult,
  SchemaInfo,
  StatementResult,
  TableStatistics,
  TableInfo
} from "../../core/resultTypes.js";
import { normalizeRows } from "../../utils/normalize.js";
import { assertReadonlySql, inspectSqlStatement } from "../readonlyGuard.js";
import type { SqlDatabaseAdapter } from "../types.js";

type ExecuteRawResult = Record<string, unknown>[];
type ExecuteStatementRawResult = {
  affectedRows: number | null;
};

/**
 * BaseSqlAdapter centralizes the cross-database read-only behavior while leaving
 * dialect-specific connection and metadata queries to subclasses.
 */
export abstract class BaseSqlAdapter implements SqlDatabaseAdapter {
  public readonly config: MysqlDatabaseConfig | OracleDatabaseConfig | PostgresDatabaseConfig;

  protected constructor(config: MysqlDatabaseConfig | OracleDatabaseConfig | PostgresDatabaseConfig) {
    this.config = config;
  }

  public abstract connect(): Promise<void>;

  public abstract close(): Promise<void>;

  protected abstract executeRaw(sql: string, params?: unknown[] | Record<string, unknown>): Promise<ExecuteRawResult>;

  protected abstract executeStatementRaw(
    sql: string,
    params?: unknown[] | Record<string, unknown>
  ): Promise<ExecuteStatementRawResult>;

  protected abstract explainQueryRows(
    sql: string,
    params?: unknown[] | Record<string, unknown>
  ): Promise<ExecuteRawResult>;

  protected abstract analyzeQueryRows(
    sql: string,
    params?: unknown[] | Record<string, unknown>
  ): Promise<ExecuteRawResult>;

  protected abstract pingSql(): string;

  protected abstract listSchemasSql(): string;

  protected abstract listTablesSql(schema?: string): { sql: string; params?: unknown[] | Record<string, unknown> };

  protected abstract describeTableSql(
    schema: string | undefined,
    table: string
  ): { sql: string; params?: unknown[] | Record<string, unknown> };

  protected abstract listIndexesSql(
    schema: string | undefined,
    table: string
  ): { sql: string; params?: unknown[] | Record<string, unknown> };

  protected abstract tableStatisticsSql(
    schema: string | undefined,
    table: string
  ): { sql: string; params?: unknown[] | Record<string, unknown> };

  public async ping(): Promise<PingResult> {
    const startedAt = Date.now();
    await this.executeRaw(this.pingSql());
    return {
      ok: true,
      latencyMs: Date.now() - startedAt
    };
  }

  public async listSchemas(): Promise<SchemaInfo[]> {
    const rows = await this.executeRaw(this.listSchemasSql());
    return rows.map((row) => ({
      schema: String(row.schema ?? row.SCHEMA ?? row.SCHEMA_NAME ?? row.USERNAME)
    }));
  }

  public async listTables(schema?: string): Promise<TableInfo[]> {
    const query = this.listTablesSql(schema);
    const rows = await this.executeRaw(query.sql, query.params);
    return rows.map((row) => ({
      schema: String(
        row.schema ??
          row.SCHEMA ??
          row.schema_name ??
          row.table_schema ??
          row.SCHEMA_NAME ??
          row.OWNER ??
          row.owner ??
          schema ??
          ""
      ),
      name: String(row.name ?? row.NAME ?? row.table_name ?? row.TABLE_NAME),
      type: String(row.type ?? row.TYPE ?? row.table_type ?? row.TABLE_TYPE ?? "TABLE")
    }));
  }

  public async describeTable(schema: string | undefined, table: string): Promise<ColumnInfo[]> {
    if (!table.trim()) {
      throw new ApplicationError("INVALID_ARGUMENT", "table must not be empty");
    }

    const query = this.describeTableSql(schema, table);
    const rows = await this.executeRaw(query.sql, query.params);
    return rows.map((row) => ({
      name: String(row.name ?? row.NAME ?? row.column_name ?? row.COLUMN_NAME),
      dataType: String(row.dataType ?? row.datatype ?? row.DATATYPE ?? row.data_type ?? row.DATA_TYPE),
      nullable: String(row.nullable ?? row.IS_NULLABLE ?? row.NULLABLE).toUpperCase() !== "N",
      defaultValue:
        row.defaultValue !== undefined && row.defaultValue !== null
          ? String(row.defaultValue)
          : row.DEFAULTVALUE !== undefined && row.DEFAULTVALUE !== null
            ? String(row.DEFAULTVALUE)
          : row.COLUMN_DEFAULT !== undefined && row.COLUMN_DEFAULT !== null
            ? String(row.COLUMN_DEFAULT)
            : null,
      comment:
        row.comment !== undefined && row.comment !== null
          ? String(row.comment)
          : row.COMMENT_TEXT !== undefined && row.COMMENT_TEXT !== null
            ? String(row.COMMENT_TEXT)
          : row.COMMENTS !== undefined && row.COMMENTS !== null
            ? String(row.COMMENTS)
            : null,
      primaryKey:
        row.primaryKey === true ||
        row.PRIMARY_KEY === true ||
        row.primarykey === true ||
        row.primary_key === true ||
        String(row.primaryKey ?? row.PRIMARY_KEY ?? row.primarykey ?? row.primary_key ?? row.is_primary_key ?? "0") === "1"
    }));
  }

  public async listIndexes(schema: string | undefined, table: string): Promise<IndexInfo[]> {
    if (!table.trim()) {
      throw new ApplicationError("INVALID_ARGUMENT", "table must not be empty");
    }

    const query = this.listIndexesSql(schema, table);
    const rows = await this.executeRaw(query.sql, query.params);
    return rows.map((row) => ({
      schema: String(
        row.schema ??
          row.SCHEMA ??
          row.schema_name ??
          row.SCHEMA_NAME ??
          row.owner ??
          row.OWNER ??
          schema ??
          ""
      ),
      tableName: String(row.tableName ?? row.TABLE_NAME ?? row.table_name ?? row.NAME ?? table),
      indexName: String(row.indexName ?? row.INDEX_NAME ?? row.index_name ?? row.name ?? row.NAME),
      columnName:
        row.columnName !== undefined && row.columnName !== null
          ? String(row.columnName)
          : row.COLUMN_NAME !== undefined && row.COLUMN_NAME !== null
            ? String(row.COLUMN_NAME)
            : row.column_name !== undefined && row.column_name !== null
              ? String(row.column_name)
              : null,
      isUnique:
        row.isUnique !== undefined && row.isUnique !== null
          ? Boolean(row.isUnique)
          : row.IS_UNIQUE !== undefined && row.IS_UNIQUE !== null
            ? Boolean(row.IS_UNIQUE)
            : row.is_unique !== undefined && row.is_unique !== null
              ? Boolean(row.is_unique)
              : null,
      columnPosition:
        row.columnPosition !== undefined && row.columnPosition !== null
          ? Number(row.columnPosition)
          : row.COLUMN_POSITION !== undefined && row.COLUMN_POSITION !== null
            ? Number(row.COLUMN_POSITION)
            : row.column_position !== undefined && row.column_position !== null
              ? Number(row.column_position)
              : null,
      sortOrder:
        row.sortOrder !== undefined && row.sortOrder !== null
          ? String(row.sortOrder)
          : row.SORT_ORDER !== undefined && row.SORT_ORDER !== null
            ? String(row.SORT_ORDER)
            : row.sort_order !== undefined && row.sort_order !== null
              ? String(row.sort_order)
              : null,
      indexType:
        row.indexType !== undefined && row.indexType !== null
          ? String(row.indexType)
          : row.INDEX_TYPE !== undefined && row.INDEX_TYPE !== null
            ? String(row.INDEX_TYPE)
            : row.index_type !== undefined && row.index_type !== null
              ? String(row.index_type)
              : null,
      definition:
        row.definition !== undefined && row.definition !== null
          ? String(row.definition)
          : row.DEFINITION !== undefined && row.DEFINITION !== null
            ? String(row.DEFINITION)
            : row.indexdef !== undefined && row.indexdef !== null
              ? String(row.indexdef)
              : null
    }));
  }

  public async getTableStatistics(schema: string | undefined, table: string): Promise<TableStatistics | null> {
    if (!table.trim()) {
      throw new ApplicationError("INVALID_ARGUMENT", "table must not be empty");
    }

    const query = this.tableStatisticsSql(schema, table);
    const rows = normalizeRows(await this.executeRaw(query.sql, query.params));
    if (rows.length === 0) {
      return null;
    }

    const row = rows[0]!;
    const { schema: rowSchema, SCHEMA, schema_name, SCHEMA_NAME, tableName, TABLE_NAME, table_name, ...metrics } = row;

    return {
      schema: String(rowSchema ?? SCHEMA ?? schema_name ?? SCHEMA_NAME ?? schema ?? ""),
      tableName: String(tableName ?? TABLE_NAME ?? table_name ?? table),
      metrics
    };
  }

  public async explainQuery(sql: string, params: unknown[] | undefined, maxRows: number): Promise<QueryResult> {
    const info = inspectSqlStatement(sql);
    if (!info.isReadonlyQuery) {
      throw new ApplicationError("INVALID_ARGUMENT", "explain_query only accepts read-only query SQL");
    }

    try {
      const rows = await this.explainQueryRows(sql, params);
      const normalizedRows = normalizeRows(rows);
      const limitedRows = normalizedRows.slice(0, maxRows);

      return {
        rowCount: normalizedRows.length,
        rows: limitedRows,
        truncated: normalizedRows.length > maxRows
      };
    } catch (error) {
      throw toApplicationError(error, "QUERY_ERROR");
    }
  }

  public async analyzeQuery(sql: string, params: unknown[] | undefined, maxRows: number): Promise<QueryResult> {
    const info = inspectSqlStatement(sql);
    if (!info.isReadonlyQuery) {
      throw new ApplicationError("INVALID_ARGUMENT", "analyze_query only accepts read-only query SQL");
    }

    try {
      const rows = await this.analyzeQueryRows(sql, params);
      const normalizedRows = normalizeRows(rows);
      const limitedRows = normalizedRows.slice(0, maxRows);

      return {
        rowCount: normalizedRows.length,
        rows: limitedRows,
        truncated: normalizedRows.length > maxRows
      };
    } catch (error) {
      throw toApplicationError(error, "QUERY_ERROR");
    }
  }

  public async executeQuery(sql: string, params: unknown[] | undefined, maxRows: number): Promise<QueryResult> {
    try {
      assertReadonlySql(sql);
      const rows = await this.executeRaw(sql, params);
      const normalizedRows = normalizeRows(rows);
      const limitedRows = normalizedRows.slice(0, maxRows);

      return {
        rowCount: normalizedRows.length,
        rows: limitedRows,
        truncated: normalizedRows.length > maxRows
      };
    } catch (error) {
      throw toApplicationError(error, "QUERY_ERROR");
    }
  }

  public async executeStatement(sql: string, params?: unknown[]): Promise<StatementResult> {
    const info = inspectSqlStatement(sql);
    if (info.isReadonlyQuery) {
      throw new ApplicationError("INVALID_ARGUMENT", "execute_statement only accepts non-query SQL");
    }

    try {
      const result = await this.executeStatementRaw(sql, params);
      return {
        command: info.firstKeyword,
        affectedRows: result.affectedRows
      };
    } catch (error) {
      throw toApplicationError(error, "QUERY_ERROR");
    }
  }
}
