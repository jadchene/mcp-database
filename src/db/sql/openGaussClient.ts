import type { PostgresDatabaseConfig } from "../../config/configTypes.js";
import { PostgresAdapter } from "./postgresClient.js";

/**
 * openGauss is handled through the PostgreSQL-compatible adapter in v1. If
 * protocol differences appear in the future, they can be isolated here.
 */
export class OpenGaussAdapter extends PostgresAdapter {
  public constructor(config: PostgresDatabaseConfig, queryTimeoutMs: number | null) {
    super(config, queryTimeoutMs);
  }
}
