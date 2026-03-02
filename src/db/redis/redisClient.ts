import type { RedisClientType } from "redis";

import type { RedisDatabaseConfig } from "../../config/configTypes.js";
import { ApplicationError, toApplicationError } from "../../core/errors.js";
import type { PingResult, RedisScanResult } from "../../core/resultTypes.js";
import type { RedisDatabaseAdapter } from "../types.js";

export class RedisAdapter implements RedisDatabaseAdapter {
  public readonly config: RedisDatabaseConfig;

  private client: RedisClientType | null = null;

  public constructor(config: RedisDatabaseConfig) {
    this.config = config;
  }

  public async connect(): Promise<void> {
    try {
      const redis = await import("redis");
      this.client = this.config.connection.url
        ? redis.createClient({
            url: this.config.connection.url,
            socket: {
              connectTimeout: this.config.connection.connectTimeoutMs
            }
          })
        : redis.createClient({
            socket: {
              host: this.config.connection.host,
              port: this.config.connection.port ?? 6379,
              connectTimeout: this.config.connection.connectTimeoutMs
            },
            database: this.config.connection.databaseName,
            username: this.config.connection.username,
            password: this.config.connection.password
          });

      await this.client.connect();
    } catch (error) {
      throw toApplicationError(error, "CONNECTION_ERROR");
    }
  }

  public async close(): Promise<void> {
    if (!this.client) {
      return;
    }

    await this.client.quit();
    this.client = null;
  }

  public async ping(): Promise<PingResult> {
    if (!this.client) {
      throw new ApplicationError("CONNECTION_ERROR", "Redis connection is not open");
    }

    const startedAt = Date.now();
    await this.client.ping();
    return {
      ok: true,
      latencyMs: Date.now() - startedAt
    };
  }

  public async get(key: string): Promise<string | null> {
    if (!this.client) {
      throw new ApplicationError("CONNECTION_ERROR", "Redis connection is not open");
    }

    return this.client.get(key);
  }

  public async hgetall(key: string): Promise<Record<string, string>> {
    if (!this.client) {
      throw new ApplicationError("CONNECTION_ERROR", "Redis connection is not open");
    }

    return this.client.hGetAll(key);
  }

  public async scan(cursor: string, pattern: string | undefined, count: number): Promise<RedisScanResult> {
    if (!this.client) {
      throw new ApplicationError("CONNECTION_ERROR", "Redis connection is not open");
    }

    const options: { MATCH?: string; COUNT: number } = { COUNT: count };
    if (pattern) {
      options.MATCH = pattern;
    }

    const result = await this.client.scan(cursor, options);

    return {
      nextCursor: result.cursor,
      keys: result.keys
    };
  }
}
