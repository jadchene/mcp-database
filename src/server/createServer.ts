import { watchFile, unwatchFile } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { fingerprintDatabaseTarget } from "../config/databaseFingerprint.js";
import { summarizeLoadedConfig } from "../config/configSummary.js";
import { loadConfigFromPath } from "../config/loadConfig.js";
import { inspectSqlStatement } from "../db/readonlyGuard.js";

import type { LoadedConfig } from "../config/configTypes.js";
import { ApplicationError, toApplicationError } from "../core/errors.js";
import { log } from "../core/logger.js";
import { createClient } from "../db/clientFactory.js";
import type { RedisDatabaseAdapter, SqlDatabaseAdapter } from "../db/types.js";
import { buildToolRegistry } from "./toolRegistry.js";
import { SERVICE_NAME, SERVICE_VERSION } from "../version.js";

interface StatementConfirmationInput {
  databaseKey: string;
  sql: string;
  params?: unknown[];
}

interface ScriptConfirmationInput {
  databaseKey: string;
  sourceKind: "file" | "inline";
  sourceLabel: string;
  scriptLength: number;
  statementCount: number;
  ddlKeywords: string[];
  highRiskKeywords: string[];
}

interface StatementConfirmationContext {
  database: LoadedConfig["databases"][number];
  input: StatementConfirmationInput;
  supportsInteractiveConfirmation: boolean;
  elicitConfirmation?: (message: string) => Promise<"yes" | "no">;
}

interface ScriptConfirmationContext {
  database: LoadedConfig["databases"][number];
  input: ScriptConfirmationInput;
  supportsInteractiveConfirmation: boolean;
  elicitConfirmation?: (message: string) => Promise<"yes" | "no">;
}

type StatementConfirmationResult = { status: "confirmed"; databaseFingerprint: string };

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

  const adapter = createClient(database, {
    queryTimeoutMs: config.query.timeoutMs
  });
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
        errorMessage: wrapped.message
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
          errorMessage: wrapped.message,
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

  const server = new Server(
    {
      name: SERVICE_NAME,
      version: SERVICE_VERSION
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
      log("info", "Tool execution started", {
        toolName: tool.name,
        arguments: summarizeToolArguments(request.params.arguments ?? {})
      });

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

          const clientCapabilities = server.getClientCapabilities();
          return confirmStatementExecution({
            database,
            input,
            supportsInteractiveConfirmation: Boolean(clientCapabilities?.elicitation),
            elicitConfirmation: async (message) => {
              const confirmation = await server.elicitInput({
                mode: "form",
                message,
                requestedSchema: {
                  type: "object",
                  properties: {
                    decision: {
                      type: "string",
                      title: "Execute this SQL statement?",
                      description: "Choose yes to execute the exact SQL shown above, or no to reject it.",
                      enum: ["yes", "no"]
                    }
                  },
                  required: ["decision"]
                }
              });

              log("info", "Write statement waiting for interactive confirmation", {
                toolName: "execute_statement",
                databaseKey: input.databaseKey,
                sql: input.sql,
                params: input.params ?? [],
                confirmationMode: "interactive"
              });

              return confirmation.action === "accept" && confirmation.content?.decision === "yes"
                ? "yes"
                : "no";
            }
          });
        },
        async confirmScriptExecution(input) {
          const database = currentConfig.databaseMap.get(input.databaseKey);
          if (!database) {
            throw new ApplicationError("DATABASE_NOT_FOUND", `Database not found: ${input.databaseKey}`);
          }

          const clientCapabilities = server.getClientCapabilities();
          return confirmScriptExecution({
            database,
            input,
            supportsInteractiveConfirmation: Boolean(clientCapabilities?.elicitation),
            elicitConfirmation: async (message) => {
              const confirmation = await server.elicitInput({
                mode: "form",
                message,
                requestedSchema: {
                  type: "object",
                  properties: {
                    decision: {
                      type: "string",
                      title: "Execute this SQL script?",
                      description: "Choose yes to execute the script described above, or no to reject it.",
                      enum: ["yes", "no"]
                    }
                  },
                  required: ["decision"]
                }
              });

              log("info", "Script execution waiting for interactive confirmation", {
                toolName: "execute_script",
                databaseKey: input.databaseKey,
                sourceKind: input.sourceKind,
                statementCount: input.statementCount,
                confirmationMode: "interactive"
              });

              return confirmation.action === "accept" && confirmation.content?.decision === "yes"
                ? "yes"
                : "no";
            }
          });
        }
      });

      log("info", "Tool execution succeeded", {
        toolName: tool.name,
        result: summarizeToolResult(result)
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
        errorMessage: wrapped.message,
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

  let shutdownInFlight: Promise<void> | null = null;
  const shutdown = (): Promise<void> => {
    if (shutdownInFlight) {
      return shutdownInFlight;
    }
    shutdownInFlight = (async () => {
      disposeWatcher();
      await server.close();
    })();
    return shutdownInFlight;
  };
  const handleSignal = (): void => {
    void shutdown()
      .then(() => process.exit(0))
      .catch((error) => {
        log("error", "Failed to shut down MCP database server cleanly", {
          cause: error instanceof Error ? error.name : "UnknownError"
        });
        process.exit(1);
      });
  };
  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);
  return server;
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

function buildInteractiveConfirmationMessage(input: StatementConfirmationInput): string {
  const statement = inspectSqlStatement(input.sql);
  const targetObject = extractSqlTargetObject(statement.firstKeyword, input.sql);
  const riskSummary = buildRiskSummary(statement.riskLevel, statement.riskReasons);
  const params = JSON.stringify(input.params ?? []);

  return (
    `Review this database write operation before execution.\n\n` +
    `Database Key: ${input.databaseKey}\n` +
    `Statement: ${statement.firstKeyword}\n` +
    `Target: ${targetObject}\n` +
    `Risk Level: ${statement.riskLevel.toUpperCase()}\n` +
    `Risk Details: ${riskSummary}\n` +
    `Parameters: ${params}\n\n` +
    `SQL to execute:\n${input.sql}\n\n` +
    `Choose "yes" to execute this exact SQL or "no" to reject it.`
  );
}

export async function confirmStatementExecution(
  context: StatementConfirmationContext
): Promise<StatementConfirmationResult> {
  const {
    database,
    input,
    supportsInteractiveConfirmation,
    elicitConfirmation
  } = context;

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

  const databaseFingerprint = fingerprintDatabaseTarget(database);

  if (!supportsInteractiveConfirmation || !elicitConfirmation) {
    throw new ApplicationError(
      "NOT_SUPPORTED",
      "execute_statement requires interactive elicitation, but the MCP client does not support it. The statement was not executed."
    );
  }

  let decision: "yes" | "no";
  try {
    decision = await elicitConfirmation(buildInteractiveConfirmationMessage(input));
  } catch (error) {
    throw new ApplicationError(
      "NOT_SUPPORTED",
      "Interactive elicitation failed. The statement was not executed.",
      { cause: error instanceof Error ? error.message : String(error) }
    );
  }
  if (decision !== "yes") {
    throw new ApplicationError(
      "USER_DECLINED",
      "The user explicitly rejected this SQL operation. The statement was not executed."
    );
  }

  log("info", "Write statement confirmed through interactive confirmation", {
    toolName: "execute_statement",
    databaseKey: input.databaseKey,
    sql: input.sql,
    params: input.params ?? [],
    confirmationMode: "interactive"
  });
  return { status: "confirmed", databaseFingerprint };
}

function buildScriptConfirmationMessage(input: ScriptConfirmationInput): string {
  const sourceDescription =
    input.sourceKind === "file"
      ? `SQL file: ${input.sourceLabel}`
      : `inline SQL string (${input.scriptLength} chars)`;
  const ddlWarning =
    input.ddlKeywords.length > 0
      ? `\nWARNING: this script contains DDL (${input.ddlKeywords.join(", ")}). DDL causes an implicit commit in MySQL and cannot be rolled back even with a transaction.`
      : "";
  const highRiskWarning =
    input.highRiskKeywords.length > 0
      ? `\nNote: this script contains high-risk keywords (${input.highRiskKeywords.join(", ")}).`
      : "";

  return (
    `Review this SQL script before execution.\n\n` +
    `Database Key: ${input.databaseKey}\n` +
    `Source: ${sourceDescription}\n` +
    `Approximate statements: ${input.statementCount}\n` +
    ddlWarning +
    highRiskWarning +
    `\n\nThe script runs on a single MySQL connection. Session variables such as @var are preserved across statements. ` +
    `Choose "yes" to execute this script or "no" to reject it.`
  );
}

/**
 * 脚本执行确认：与单语句确认共用 elicitation 通道，但展示脚本来源、条数与 DDL 提示。
 */
export async function confirmScriptExecution(
  context: ScriptConfirmationContext
): Promise<StatementConfirmationResult> {
  const {
    database,
    input,
    supportsInteractiveConfirmation,
    elicitConfirmation
  } = context;

  if (database.type === "redis") {
    throw new ApplicationError(
      "NOT_SUPPORTED",
      "Redis does not support SQL script execution"
    );
  }

  if (database.readonly) {
    throw new ApplicationError("NOT_SUPPORTED", `${input.databaseKey} is configured as readonly`);
  }

  const databaseFingerprint = fingerprintDatabaseTarget(database);

  if (!supportsInteractiveConfirmation || !elicitConfirmation) {
    throw new ApplicationError(
      "NOT_SUPPORTED",
      "execute_script requires interactive elicitation, but the MCP client does not support it. The script was not executed."
    );
  }

  let decision: "yes" | "no";
  try {
    decision = await elicitConfirmation(buildScriptConfirmationMessage(input));
  } catch (error) {
    throw new ApplicationError(
      "NOT_SUPPORTED",
      "Interactive elicitation failed. The script was not executed.",
      { cause: error instanceof Error ? error.message : String(error) }
    );
  }
  if (decision !== "yes") {
    throw new ApplicationError(
      "USER_DECLINED",
      "The user explicitly rejected this SQL script. The script was not executed."
    );
  }

  log("info", "Script execution confirmed through interactive confirmation", {
    toolName: "execute_script",
    databaseKey: input.databaseKey,
    sourceKind: input.sourceKind,
    sourceLabel: input.sourceLabel,
    scriptLength: input.scriptLength,
    statementCount: input.statementCount,
    confirmationMode: "interactive"
  });
  return { status: "confirmed", databaseFingerprint };
}

function summarizeToolArguments(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return {};
  }

  const objectArgs = args as Record<string, unknown>;
  const summary: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(objectArgs)) {
    if (key === "sql" && typeof value === "string") {
      summary.sql = value;
      continue;
    }

    if (key === "params") {
      summary.params = value;
      continue;
    }

    summary[key] = value;
  }

  return summary;
}

function summarizeToolResult(result: unknown): Record<string, unknown> {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return {};
  }

  const value = result as Record<string, unknown>;
  const summary: Record<string, unknown> = {};

  for (const key of ["databaseKey", "type", "rowCount", "truncated", "command", "affectedRows", "status", "riskLevel"]) {
    if (key in value) {
      summary[key] = value[key];
    }
  }

  return summary;
}
