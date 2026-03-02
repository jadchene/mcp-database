import { watchFile, unwatchFile } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { summarizeLoadedConfig } from "../config/configSummary.js";
import { loadConfigFromPath } from "../config/loadConfig.js";
import { inspectSqlStatement } from "../db/readonlyGuard.js";

import type { LoadedConfig } from "../config/configTypes.js";
import { ApplicationError, toApplicationError } from "../core/errors.js";
import { log } from "../core/logger.js";
import { createClient } from "../db/clientFactory.js";
import type { RedisDatabaseAdapter, SqlDatabaseAdapter } from "../db/types.js";
import { buildToolRegistry } from "./toolRegistry.js";

interface PendingStatementConfirmation {
  databaseKey: string;
  sql: string;
  params?: unknown[];
  expiresAt: number;
}

async function withDatabaseAdapter<T>(
  config: LoadedConfig,
  databaseKey: string,
  expectedType: "sql" | "redis",
  action: (adapter: SqlDatabaseAdapter | RedisDatabaseAdapter) => Promise<T>
): Promise<T> {
  const database = config.databaseMap.get(databaseKey);
  if (!database) {
    throw new ApplicationError("DATABASE_NOT_FOUND", `Database not found: ${databaseKey}`);
  }

  const isRedis = database.type === "redis";
  if (expectedType === "sql" && isRedis) {
    throw new ApplicationError("NOT_SUPPORTED", `${databaseKey} is a Redis target and does not support SQL tools`);
  }

  if (expectedType === "redis" && !isRedis) {
    throw new ApplicationError("NOT_SUPPORTED", `${databaseKey} is not a Redis target`);
  }

  const adapter = createClient(database);
  const startedAt = Date.now();

  try {
    await adapter.connect();
    return await action(adapter as SqlDatabaseAdapter & RedisDatabaseAdapter);
  } finally {
    await adapter.close().catch((error) => {
      const wrapped = toApplicationError(error, "CONNECTION_ERROR");
      log("warn", "Failed to close database connection", {
        databaseKey,
        type: database.type,
        code: wrapped.code,
        message: wrapped.message
      });
    });

    log("info", "Database operation completed", {
      databaseKey,
      type: database.type,
      durationMs: Date.now() - startedAt
    });
  }
}

/**
 * The MCP layer is intentionally thin: validate input, route to the correct
 * adapter, and return normalized JSON text for clients.
 */
export async function createServer(config: LoadedConfig): Promise<Server> {
  let currentConfig = config;
  let reloadInFlight: Promise<LoadedConfig> | null = null;
  let pendingWatchReloadTimer: NodeJS.Timeout | null = null;
  let watcherDisposed = false;
  const pendingStatementConfirmations = new Map<string, PendingStatementConfirmation>();

  const reloadConfigSnapshot = async (reason: "manual" | "watch"): Promise<LoadedConfig> => {
    if (reloadInFlight) {
      return reloadInFlight;
    }

    const previousConfig = currentConfig;
    reloadInFlight = loadConfigFromPath(previousConfig.configPath)
      .then((reloadedConfig) => {
        currentConfig = reloadedConfig;

        log("info", reason === "manual" ? "Database configuration reloaded" : "Database configuration auto-reloaded", {
          reason,
          previousConfigPath: previousConfig.configPath,
            previousLoadedAt: previousConfig.loadedAt,
            previousDatabaseCount: previousConfig.databases.length,
            ...summarizeLoadedConfig(reloadedConfig)
          });

        return reloadedConfig;
      })
      .catch((error) => {
        const wrapped = toApplicationError(error, "CONFIG_ERROR");
        log("error", reason === "manual" ? "Database configuration reload failed" : "Database configuration auto-reload failed", {
          reason,
          configPath: previousConfig.configPath,
          code: wrapped.code,
          message: wrapped.message,
          details: wrapped.details
        });
        throw wrapped;
      })
      .finally(() => {
        reloadInFlight = null;
      });

    return reloadInFlight;
  };

  const disposeWatcher = (): void => {
    if (watcherDisposed) {
      return;
    }

    if (pendingWatchReloadTimer) {
      clearTimeout(pendingWatchReloadTimer);
      pendingWatchReloadTimer = null;
    }

    unwatchFile(currentConfig.configPath);
    watcherDisposed = true;
  };

  const cleanupExpiredConfirmations = (): void => {
    const now = Date.now();
    for (const [confirmationId, pending] of pendingStatementConfirmations.entries()) {
      if (pending.expiresAt <= now) {
        pendingStatementConfirmations.delete(confirmationId);
      }
    }
  };

  watchFile(
    currentConfig.configPath,
    { interval: 1000 },
    (currentStat, previousStat) => {
      if (currentStat.mtimeMs === previousStat.mtimeMs && currentStat.size === previousStat.size) {
        return;
      }

      if (pendingWatchReloadTimer) {
        clearTimeout(pendingWatchReloadTimer);
      }

      pendingWatchReloadTimer = setTimeout(() => {
        pendingWatchReloadTimer = null;
        void reloadConfigSnapshot("watch").catch(() => {
          // Failure is already logged and the previous config remains active.
        });
      }, 300);
    }
  );

  process.once("exit", disposeWatcher);
  process.once("SIGINT", disposeWatcher);
  process.once("SIGTERM", disposeWatcher);

  const server = new Server(
    {
      name: "mcp-database-service",
      version: "0.1.0"
    },
    {
      capabilities: {
        tools: {}
      }
    }
  );

  const tools = buildToolRegistry();
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema
    }))
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = toolsByName.get(request.params.name);
    if (!tool) {
      throw new ApplicationError("INVALID_ARGUMENT", `Unknown tool: ${request.params.name}`);
    }

    try {
      const result = await tool.run(request.params.arguments ?? {}, {
        getConfig() {
          return currentConfig;
        },
        async reloadConfig() {
          return reloadConfigSnapshot("manual");
        },
        useSqlDatabase(databaseKey, action) {
          return withDatabaseAdapter(currentConfig, databaseKey, "sql", async (adapter) =>
            action(adapter as SqlDatabaseAdapter)
          );
        },
        useRedisDatabase(databaseKey, action) {
          return withDatabaseAdapter(currentConfig, databaseKey, "redis", async (adapter) =>
            action(adapter as RedisDatabaseAdapter)
          );
        },
        async confirmStatementExecution(input) {
          const database = currentConfig.databaseMap.get(input.databaseKey);
          if (!database) {
            throw new ApplicationError("DATABASE_NOT_FOUND", `Database not found: ${input.databaseKey}`);
          }

          if (database.type === "redis") {
            throw new ApplicationError("NOT_SUPPORTED", "Redis does not support SQL statement execution");
          }

          if (database.readonly) {
            throw new ApplicationError("NOT_SUPPORTED", `${input.databaseKey} is configured as readonly`);
          }

          const statement = inspectSqlStatement(input.sql);
          if (statement.isReadonlyQuery) {
            throw new ApplicationError("INVALID_ARGUMENT", "Use execute_query for query SQL");
          }

          const previewSql = buildSqlPreview(input.sql);
          const previewParams = buildParamsPreview(input.params);
          const targetObject = extractSqlTargetObject(statement.firstKeyword, input.sql);
          const riskSummary = buildRiskSummary(statement.riskLevel, statement.riskReasons);
          const clientCapabilities = server.getClientCapabilities();

          cleanupExpiredConfirmations();
          if (!clientCapabilities?.elicitation) {
            if (input.confirmationId && input.confirmExecution === true) {
              const pending = pendingStatementConfirmations.get(input.confirmationId);
              if (!pending) {
                throw new ApplicationError(
                  "INVALID_ARGUMENT",
                  "Unknown or expired confirmationId for execute_statement"
                );
              }

              if (
                pending.databaseKey !== input.databaseKey ||
                pending.sql !== input.sql ||
                JSON.stringify(pending.params ?? []) !== JSON.stringify(input.params ?? [])
              ) {
                throw new ApplicationError(
                  "INVALID_ARGUMENT",
                  "execute_statement confirmation does not match the pending SQL request"
                );
              }

              pendingStatementConfirmations.delete(input.confirmationId);
              return { status: "confirmed" } as const;
            }

            const confirmationId = createConfirmationId();
            pendingStatementConfirmations.set(confirmationId, {
              databaseKey: input.databaseKey,
              sql: input.sql,
              params: input.params,
              expiresAt: Date.now() + 10 * 60 * 1000
            });

            return {
              status: "pending" as const,
              confirmationId,
              confirmationMode: "two_step" as const,
              message:
                "This MCP client does not support interactive confirmation. Ask the user whether to execute the statement, then call execute_statement again with the same databaseKey, sql, params, confirmationId, and confirmExecution=true.",
              statement: statement.firstKeyword,
              targetObject,
              riskLevel: statement.riskLevel,
              riskDetails: riskSummary,
              sqlPreview: previewSql,
              paramsPreview: previewParams
            };
          }

          const confirmation = await server.elicitInput({
            mode: "form",
            message:
              `Manual confirmation required before executing write SQL.\n` +
              `Database Key: ${input.databaseKey}\n` +
              `Statement: ${statement.firstKeyword}\n` +
              `Target: ${targetObject}\n` +
              `Risk: ${statement.riskLevel.toUpperCase()}\n` +
              `Risk Details: ${riskSummary}\n` +
              `SQL Preview: ${previewSql}\n` +
              `Params: ${previewParams}`,
            requestedSchema: {
              type: "object",
              properties: {
                confirm: {
                  type: "boolean",
                  title: "Confirm Execution",
                  description: "Set to true to allow this SQL statement to run"
                }
              },
              required: ["confirm"]
            }
          });

          const confirmed = confirmation.action === "accept" && confirmation.content?.confirm === true;
          if (!confirmed) {
            throw new ApplicationError("NOT_SUPPORTED", "Write SQL execution was not confirmed");
          }

          return { status: "confirmed" } as const;
        }
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2)
          }
        ]
      };
    } catch (error) {
      const wrapped = toApplicationError(error, "QUERY_ERROR");
      log("error", "Tool execution failed", {
        toolName: tool.name,
        code: wrapped.code,
        message: wrapped.message,
        details: wrapped.details
      });

      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: {
                  code: wrapped.code,
                  message: wrapped.message,
                  details: wrapped.details ?? {}
                }
              },
              null,
              2
            )
          }
        ]
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}

function buildSqlPreview(sql: string): string {
  const singleLine = sql.replace(/\s+/g, " ").trim();
  return singleLine.length <= 240 ? singleLine : `${singleLine.slice(0, 237)}...`;
}

function buildParamsPreview(params?: unknown[]): string {
  if (!params || params.length === 0) {
    return "[]";
  }

  const preview = JSON.stringify(params);
  return preview.length <= 240 ? preview : `${preview.slice(0, 237)}...`;
}

function buildRiskSummary(riskLevel: "normal" | "high" | "critical", riskReasons: string[]): string {
  if (riskReasons.length === 0) {
    if (riskLevel === "normal") {
      return "No special risk markers were detected.";
    }

    return "This statement type is treated as high risk.";
  }

  return riskReasons.join("; ");
}

function extractSqlTargetObject(statementKeyword: string, sql: string): string {
  const normalized = sql.replace(/\s+/g, " ").trim();
  const upperKeyword = statementKeyword.toUpperCase();

  const patterns: Record<string, RegExp> = {
    INSERT: /^\s*INSERT\s+INTO\s+([^\s(]+)/i,
    UPDATE: /^\s*UPDATE\s+([^\s(]+)/i,
    DELETE: /^\s*DELETE\s+FROM\s+([^\s(]+)/i,
    MERGE: /^\s*MERGE\s+INTO\s+([^\s(]+)/i,
    ALTER: /^\s*ALTER\s+(?:TABLE|VIEW|INDEX)?\s*([^\s(]+)/i,
    DROP: /^\s*DROP\s+(?:TABLE|VIEW|INDEX|SCHEMA|DATABASE)?\s*([^\s(]+)/i,
    CREATE: /^\s*CREATE\s+(?:TABLE|VIEW|INDEX|SCHEMA|DATABASE)?\s*([^\s(]+)/i,
    TRUNCATE: /^\s*TRUNCATE\s+TABLE\s+([^\s(]+)/i
  };

  const pattern = patterns[upperKeyword];
  if (!pattern) {
    return "unknown";
  }

  const match = pattern.exec(normalized);
  return match?.[1] ?? "unknown";
}

function createConfirmationId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
