import type { DatabaseConfig } from "../config/configTypes.js";
import { ApplicationError } from "../core/errors.js";
import { RedisAdapter } from "./redis/redisClient.js";
import { MysqlAdapter } from "./sql/mysqlClient.js";
import { OpenGaussAdapter } from "./sql/openGaussClient.js";
import { OracleAdapter } from "./sql/oracleClient.js";
import { PostgresAdapter } from "./sql/postgresClient.js";
import type { DatabaseAdapter } from "./types.js";

/**
 * Adapters are created per request so each tool call owns its own connection
 * lifecycle and can clean up independently.
 */
export function createClient(
  config: DatabaseConfig,
  options?: {
    queryTimeoutMs?: number | null;
  }
): DatabaseAdapter {
  switch (config.type) {
    case "mysql":
      return new MysqlAdapter(config, options?.queryTimeoutMs ?? null);
    case "oracle":
      return new OracleAdapter(config, options?.queryTimeoutMs ?? null);
    case "postgresql":
      return new PostgresAdapter(config, options?.queryTimeoutMs ?? null);
    case "opengauss":
      return new OpenGaussAdapter(config, options?.queryTimeoutMs ?? null);
    case "redis":
      return new RedisAdapter(config, options?.queryTimeoutMs ?? null);
    default:
      throw new ApplicationError("UNSUPPORTED_DATABASE_TYPE", `Unsupported database type: ${(config as DatabaseConfig).type}`);
  }
}
