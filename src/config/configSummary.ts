import { URL } from "node:url";

import type {
  DatabaseConfig,
  LoadedConfig,
  MysqlDatabaseConfig,
  OracleDatabaseConfig,
  PostgresDatabaseConfig,
  RedisDatabaseConfig
} from "./configTypes.js";

export function summarizeLoadedConfig(config: LoadedConfig): Record<string, unknown> {
  return {
    configPath: config.configPath,
    loadedAt: config.loadedAt,
    databaseCount: config.databases.length,
    items: config.databases.map((database) => summarizeDatabaseConfig(database))
  };
}

export function summarizeDatabaseConfig(database: DatabaseConfig): Record<string, unknown> {
  return {
    key: database.key,
    databaseName: summarizeLogicalDatabaseName(database),
    type: database.type,
    readonly: database.readonly,
    connection: summarizeConnection(database)
  };
}

export function summarizeDatabaseListItem(database: DatabaseConfig): Record<string, unknown> {
  return {
    key: database.key,
    databaseName: summarizeLogicalDatabaseName(database),
    type: database.type,
    readonly: database.readonly
  };
}

function summarizeConnection(database: DatabaseConfig): Record<string, unknown> {
  switch (database.type) {
    case "mysql":
      return summarizeMysqlConnection(database);
    case "postgresql":
    case "opengauss":
      return summarizePostgresConnection(database);
    case "oracle":
      return summarizeOracleConnection(database);
    case "redis":
      return summarizeRedisConnection(database);
  }
}

function summarizeMysqlConnection(database: MysqlDatabaseConfig): Record<string, unknown> {
  return {
    host: database.connection.host,
    port: database.connection.port ?? 3306,
    databaseName: database.connection.databaseName,
    user: database.connection.user,
    connectTimeoutMs: database.connection.connectTimeoutMs ?? null,
    sslEnabled: database.connection.ssl === true || typeof database.connection.ssl === "object"
  };
}

function summarizePostgresConnection(database: PostgresDatabaseConfig): Record<string, unknown> {
  return {
    host: database.connection.host,
    port: database.connection.port ?? 5432,
    databaseName: database.connection.databaseName,
    user: database.connection.user,
    connectTimeoutMs: database.connection.connectTimeoutMs ?? null,
    sslEnabled: database.connection.ssl === true || typeof database.connection.ssl === "object"
  };
}

function summarizeOracleConnection(database: OracleDatabaseConfig): Record<string, unknown> {
  return {
    host: database.connection.host,
    port: database.connection.port ?? 1521,
    serviceName: database.connection.serviceName ?? null,
    sid: database.connection.sid ?? null,
    user: database.connection.user,
    connectTimeoutMs: database.connection.connectTimeoutMs ?? null,
    clientMode: database.connection.clientMode ?? (database.connection.clientLibDir ? "thick" : "thin"),
    clientLibDir: database.connection.clientLibDir ?? null
  };
}

function summarizeRedisConnection(database: RedisDatabaseConfig): Record<string, unknown> {
  return {
    url: database.connection.url ? sanitizeRedisUrl(database.connection.url) : null,
    host: database.connection.host ?? null,
    port: database.connection.port ?? null,
    databaseName: database.connection.databaseName ?? null,
    username: database.connection.username ?? null,
    connectTimeoutMs: database.connection.connectTimeoutMs ?? null
  };
}

function summarizeLogicalDatabaseName(database: DatabaseConfig): string | number | null {
  switch (database.type) {
    case "mysql":
      return database.connection.databaseName;
    case "postgresql":
    case "opengauss":
      return database.connection.databaseName;
    case "oracle":
      return database.connection.serviceName ?? database.connection.sid ?? null;
    case "redis":
      return database.connection.databaseName ?? null;
  }
}

function sanitizeRedisUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.password) {
      parsed.password = "***";
    }

    if (parsed.username) {
      parsed.username = parsed.username;
    }

    return parsed.toString();
  } catch {
    return rawUrl.replace(/\/\/([^:@/]+):([^@/]+)@/, "//$1:***@");
  }
}
