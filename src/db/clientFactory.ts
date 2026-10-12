import type { DatabaseConfig } from "../config/configTypes.js";
import { ApplicationError } from "../core/errors.js";
import { RedisAdapter } from "./redis/redisClient.js";
import { MysqlAdapter } from "./sql/mysqlClient.js";
import { OracleAdapter } from "./sql/oracleClient.js";
import { PostgresAdapter } from "./sql/postgresClient.js";
import type { DatabaseAdapter } from "./types.js";

/**
 * 仅由显式 connect 创建适配器，后续调用复用会话持有的实例。
 */
export function createClient(
  config: DatabaseConfig,
  options?: {
    queryTimeoutMs?: number | null;
  }
): DatabaseAdapter {
  // 仅为本次连接解除配置层的只读约束，不修改原始配置或其他目标。
  if (config.dangerMode === true) config = { ...config, readonly: false };
  switch (config.type) {
    case "mysql":
      return new MysqlAdapter(config, options?.queryTimeoutMs ?? null);
    case "oracle":
      return new OracleAdapter(config, options?.queryTimeoutMs ?? null);
    case "postgresql":
      return new PostgresAdapter(config, options?.queryTimeoutMs ?? null);
    case "redis":
      return new RedisAdapter(config, options?.queryTimeoutMs ?? null);
    default:
      throw new ApplicationError("UNSUPPORTED_DATABASE_TYPE", `Unsupported database type: ${(config as DatabaseConfig).type}`);
  }
}
