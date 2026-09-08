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

export interface LimitedMetadataResult<T> {
  items: T[];
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

/**
 * 一条 SQL 脚本语句的执行结果（由数据库驱动在整段直传时返回）。
 * MySQL 开启 multipleStatements 后返回结果数组，每一项对应一条语句。
 */
export interface ScriptStatementResult {
  index: number;
  /** 语句结果类型：affected 表示受影响行数，rows 表示查询结果行。 */
  kind: "affected" | "rows";
  affectedRows: number | null;
  rowCount: number | null;
}

/**
 * SQL 脚本整体执行结果。事务开启时以 outcome 表示提交/回滚状态。
 */
export interface ScriptExecutionResult {
  command: string;
  statementCount: number;
  statements: ScriptStatementResult[];
  totalAffectedRows: number | null;
  transaction: {
    enabled: boolean;
    outcome: "committed" | "rolled_back" | "not_applied";
  };
}

export interface RedisScanResult {
  nextCursor: string;
  keys: string[];
}
