import { readFile } from "node:fs/promises";
import path from "node:path";

import { ApplicationError } from "../core/errors.js";
import { log } from "../core/logger.js";
import type { LoadedConfig } from "./configTypes.js";
import { validateDatabaseConfig } from "./configValidation.js";

export function resolveConfigPath(argv: string[], env: NodeJS.ProcessEnv): string {
  const configIndex = argv.findIndex((value) => value === "--config");
  if (configIndex >= 0) {
    const explicitPath = argv[configIndex + 1];
    if (!explicitPath) {
      throw new ApplicationError("CONFIG_ERROR", "Missing value for --config");
    }

    return path.resolve(explicitPath);
  }

  if (env.MCP_DATABASE_CONFIG) {
    return path.resolve(env.MCP_DATABASE_CONFIG);
  }

  throw new ApplicationError(
    "CONFIG_ERROR",
    "No configuration path provided. Use --config <path> or MCP_DATABASE_CONFIG."
  );
}

/**
 * Startup loads configuration once and keeps only validated metadata in memory.
 * No actual database connection is opened here.
 */
export async function loadConfigFromPath(configPath: string): Promise<LoadedConfig> {
  const rawText = await readFile(configPath, "utf8");

  let rawConfig: unknown;
  try {
    rawConfig = JSON.parse(rawText);
  } catch (error) {
    throw new ApplicationError("CONFIG_ERROR", "Configuration file is not valid JSON", {
      configPath,
      reason: error instanceof Error ? error.message : String(error)
    });
  }

  const databases = validateDatabaseConfig(rawConfig);
  const databaseMap = new Map(databases.map((item) => [item.key, item]));

  log("info", "Database configuration loaded", {
    configPath,
    count: databases.length,
    databases: databases.map((item) => ({
      key: item.key,
      type: item.type,
      readonly: item.readonly
    }))
  });

  return {
    configPath,
    loadedAt: new Date().toISOString(),
    databases,
    databaseMap
  };
}

export async function loadConfig(argv: string[], env: NodeJS.ProcessEnv): Promise<LoadedConfig> {
  const configPath = resolveConfigPath(argv, env);
  return loadConfigFromPath(configPath);
}
