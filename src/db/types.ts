import type { DatabaseConfig } from "../config/configTypes.js";
import type {
  ColumnInfo,
  IndexInfo,
  LimitedMetadataResult,
  PingResult,
  QueryResult,
  RedisScanResult,
  SchemaInfo,
  StatementResult,
  TableStatistics,
  TableInfo
} from "../core/resultTypes.js";

export interface DatabaseAdapter {
  readonly config: DatabaseConfig;
  connect(): Promise<void>;
  close(): Promise<void>;
  ping(): Promise<PingResult>;
}

export interface SqlDatabaseAdapter extends DatabaseAdapter {
  listSchemas(maxRows: number): Promise<LimitedMetadataResult<SchemaInfo>>;
  listTables(schema: string | undefined, maxRows: number): Promise<LimitedMetadataResult<TableInfo>>;
  describeTable(schema: string | undefined, table: string, maxRows: number): Promise<LimitedMetadataResult<ColumnInfo>>;
  listIndexes(schema: string | undefined, table: string, maxRows: number): Promise<LimitedMetadataResult<IndexInfo>>;
  getTableStatistics(schema: string | undefined, table: string): Promise<TableStatistics | null>;
  explainQuery(sql: string, params: unknown[] | undefined, maxRows: number): Promise<QueryResult>;
  analyzeQuery(sql: string, params: unknown[] | undefined, maxRows: number): Promise<QueryResult>;
  executeQuery(sql: string, params: unknown[] | undefined, maxRows: number): Promise<QueryResult>;
  executeStatement(sql: string, params?: unknown[]): Promise<StatementResult>;
}

export interface RedisDatabaseAdapter extends DatabaseAdapter {
  get(key: string): Promise<string | null>;
  hgetall(key: string): Promise<Record<string, string>>;
  scan(cursor: string, pattern: string | undefined, count: number): Promise<RedisScanResult>;
}
