export interface PingResult {
  ok: true;
  latencyMs: number;
}

export interface SchemaInfo {
  schema: string;
}

export interface TableInfo {
  schema: string;
  name: string;
  type: string;
}

export interface ColumnInfo {
  name: string;
  dataType: string;
  nullable: boolean;
  defaultValue: string | null;
  comment: string | null;
  primaryKey: boolean;
}

export interface QueryResult {
  rowCount: number;
  rows: Record<string, unknown>[];
  truncated: boolean;
}

export interface IndexInfo {
  schema: string;
  tableName: string;
  indexName: string;
  columnName: string | null;
  isUnique: boolean | null;
  columnPosition: number | null;
  sortOrder: string | null;
  indexType: string | null;
  definition: string | null;
}

export interface TableStatistics {
  schema: string;
  tableName: string;
  metrics: Record<string, unknown>;
}

export interface StatementResult {
  command: string;
  affectedRows: number | null;
}

export interface RedisScanResult {
  nextCursor: string;
  keys: string[];
}
