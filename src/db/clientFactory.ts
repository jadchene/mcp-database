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
export function createClient(config: DatabaseConfig): DatabaseAdapter {
  switch (config.type) {
    case "mysql":
      return new MysqlAdapter(config);
    case "oracle":
      return new OracleAdapter(config);
    case "postgresql":
      return new PostgresAdapter(config);
    case "opengauss":
      return new OpenGaussAdapter(config);
    case "redis":
      return new RedisAdapter(config);
    default:
      throw new ApplicationError("UNSUPPORTED_DATABASE_TYPE", `Unsupported database type: ${(config as DatabaseConfig).type}`);
  }
}
