export type DatabaseType = "mysql" | "oracle" | "postgresql" | "redis" | "opengauss";

export interface BaseDatabaseConfig {
  key: string;
  type: DatabaseType;
  readonly: boolean;
  /** 显式启用本数据库的 Codex 自动审批扩展，默认禁用。 */
  codexAutoReview?: boolean;
  /** 本数据库的 Full Access 模式，跳过操作审批与只读限制，默认禁用。 */
  dangerMode?: boolean;
}

export interface MysqlDatabaseConfig extends BaseDatabaseConfig {
  type: "mysql";
  connection: {
    host: string;
    port?: number;
    databaseName: string;
    user: string;
    password: string;
    connectTimeoutMs?: number;
    ssl?: boolean | Record<string, unknown>;
  };
}

export interface OracleDatabaseConfig extends BaseDatabaseConfig {
  type: "oracle";
  connection: {
    host: string;
    port?: number;
    serviceName?: string;
    sid?: string;
    user: string;
    password: string;
    connectTimeoutMs?: number;
    clientMode?: "thin" | "thick";
    clientLibDir?: string;
  };
}

export interface PostgresDatabaseConfig extends BaseDatabaseConfig {
  type: "postgresql" | "opengauss";
  connection: {
    host: string;
    port?: number;
    databaseName: string;
    user: string;
    password: string;
    connectTimeoutMs?: number;
    ssl?: boolean | Record<string, unknown>;
  };
}

export interface RedisDatabaseConfig extends BaseDatabaseConfig {
  type: "redis";
  connection: {
    url?: string;
    host?: string;
    port?: number;
    databaseName?: number;
    username?: string;
    password?: string;
    connectTimeoutMs?: number;
  };
}

export type DatabaseConfig =
  | MysqlDatabaseConfig
  | OracleDatabaseConfig
  | PostgresDatabaseConfig
  | RedisDatabaseConfig;

export interface LoggingConfig {
  enabled: boolean;
  directory?: string;
}

export interface QueryConfig {
  timeoutMs?: number;
}

export interface RootConfig {
  databases: DatabaseConfig[];
  logging: LoggingConfig;
  query: QueryConfig;
}

export interface LoadedConfig {
  configPath: string;
  loadedAt: string;
  databases: DatabaseConfig[];
  databaseMap: Map<string, DatabaseConfig>;
  logging: LoggingConfig & {
    directory: string;
  };
  query: {
    timeoutMs: number | null;
  };
}
