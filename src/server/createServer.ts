import { watchFile, unwatchFile } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { fingerprintDatabaseTarget } from "../config/databaseFingerprint.js";
import { FULL_ACCESS_WARNING } from "../core/dangerMode.js";
import { summarizeLoadedConfig } from "../config/configSummary.js";
import { loadConfigFromPath } from "../config/loadConfig.js";
import { inspectSqlStatement } from "../db/readonlyGuard.js";

import type { LoadedConfig } from "../config/configTypes.js";
import { ApplicationError, toApplicationError } from "../core/errors.js";
import { log } from "../core/logger.js";
import { SessionPool } from "./sessions.js";
import { compactErrorDetails, compactToolResult } from "./toolResult.js";
import type { RedisDatabaseAdapter, SqlDatabaseAdapter } from "../db/types.js";
import { buildToolRegistry } from "./toolRegistry.js";
import { SERVICE_NAME, SERVICE_VERSION } from "../version.js";
import { buildCodexApprovalMeta } from "./codexApproval.js";

interface StatementConfirmationInput {
  sessionId?: string;
  sessionStateVersion?: number;
  databaseKey: string;
  sql: string;
  params?: unknown[];
}

interface ScriptConfirmationInput {
  sessionId?: string;
  databaseKey: string;
  /** 文件或内联来源解析后的实际 SQL，用于自动审批。 */
  sql: string;
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

/**
 * The MCP layer is intentionally thin: validate input, route to the correct
 * adapter, and return normalized JSON text for clients.
 */
export async function createServer(config: LoadedConfig): Promise<Server> {
  let currentConfig = config;
  const sessions = new SessionPool(() => currentConfig);
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
        sessions.reconcile();
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
    process.removeListener("exit", disposeWatcher);
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
    const args = request.params.arguments ?? {};
    const target = typeof args.databaseKey === "string" ? currentConfig.databaseMap.get(args.databaseKey) : undefined;
    // 记录本次调用实际使用过的权限配置，避免异步读取或热更新后漏报 Full Access。
    let fullAccess = target?.dangerMode === true;
    const tool = toolsByName.get(request.params.name);

    try {
      if (typeof args.sessionId === "string") {
        try { fullAccess ||= sessions.getDatabase(args.sessionId).dangerMode === true; } catch { /* 工具校验统一返回具体错误。 */ }
      }
      if (!tool) {
        throw new ApplicationError("INVALID_ARGUMENT", `Unknown tool: ${request.params.name}`);
      }
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
        connect: (databaseKey) => sessions.connect(databaseKey),
        disconnect: (sessionId) => sessions.disconnect(sessionId),
        getDatabase: (sessionId) => sessions.getDatabase(sessionId),
        getTransactionStatus: (sessionId) => sessions.use(sessionId, "any", async () => ({}), false, false),
        useSqlDatabase(sessionId, action) {
          fullAccess ||= sessions.getDatabase(sessionId).dangerMode === true;
          return sessions.use(sessionId, "sql", adapter => action(adapter as SqlDatabaseAdapter), ["execute_statement", "execute_script", "commit_transaction"].includes(tool.name));
        },
        useRedisDatabase(sessionId, action) {
          fullAccess ||= sessions.getDatabase(sessionId).dangerMode === true;
          return sessions.use(sessionId, "redis", adapter => action(adapter as RedisDatabaseAdapter));
        },
        async confirmStatementExecution(input) {
          const token = sessions.approvalToken(input.sessionId);
          const database = sessions.getDatabase(input.sessionId);
          if (!database) {
            throw new ApplicationError("DATABASE_NOT_FOUND", `Database not found: ${input.databaseKey}`);
          }
          fullAccess ||= database.dangerMode === true;

          const clientCapabilities = server.getClientCapabilities();
          const confirmation = await confirmStatementExecution({
            database,
            input: { ...input, sessionStateVersion: token.version },
            supportsInteractiveConfirmation: Boolean(clientCapabilities?.elicitation),
            elicitConfirmation: async (message) => {
              const confirmation = await server.elicitInput({
                mode: "form",
                message,
                requestedSchema: {
                  type: "object",
                  properties: {}
                },
                _meta: database.codexAutoReview === true ? buildCodexApprovalMeta(
                  request.params._meta?.["io.modelcontextprotocol/clientInfo"] ?? server.getClientVersion(),
                  tool.name, request.params.arguments ?? {}, message,
                  inspectSqlStatement(input.sql).riskLevel !== "normal"
                ) : undefined
              });

              log("info", "Write statement waiting for interactive confirmation", {
                toolName: "execute_statement",
                databaseKey: input.databaseKey,
                sql: input.sql,
                params: input.params ?? [],
                confirmationMode: "interactive"
              });

              return confirmation.action === "accept"
                ? "yes"
                : "no";
            }
          });
          sessions.validateApproval(token);
          return confirmation;
        },
        async confirmScriptExecution(input) {
          const token = sessions.approvalToken(input.sessionId);
          const database = sessions.getDatabase(input.sessionId);
          if (!database) {
            throw new ApplicationError("DATABASE_NOT_FOUND", `Database not found: ${input.databaseKey}`);
          }
          fullAccess ||= database.dangerMode === true;

          const clientCapabilities = server.getClientCapabilities();
          const confirmation = await confirmScriptExecution({
            database,
            input,
            supportsInteractiveConfirmation: Boolean(clientCapabilities?.elicitation),
            elicitConfirmation: async (message) => {
              const confirmation = await server.elicitInput({
                mode: "form",
                message,
                requestedSchema: {
                  type: "object",
                  properties: {}
                },
                _meta: database.codexAutoReview === true ? buildCodexApprovalMeta(
                  request.params._meta?.["io.modelcontextprotocol/clientInfo"] ?? server.getClientVersion(), tool.name,
                  { ...request.params.arguments, resolvedSql: input.sql }, message,
                  input.ddlKeywords.length > 0 || input.highRiskKeywords.length > 0
                ) : undefined
              });

              log("info", "Script execution waiting for interactive confirmation", {
                toolName: "execute_script",
                databaseKey: input.databaseKey,
                sourceKind: input.sourceKind,
                statementCount: input.statementCount,
                confirmationMode: "interactive"
              });

              return confirmation.action === "accept"
                ? "yes"
                : "no";
            }
          });
          sessions.validateApproval(token);
          return confirmation;
        }
      });

      log("info", "Tool execution succeeded", {
        toolName: tool.name,
        result: summarizeToolResult(result)
      });

      return {
        content: [],
        structuredContent: {
          ...compactToolResult(tool.name, result),
          ...(fullAccess ? { warning: FULL_ACCESS_WARNING } : {})
        }
      };
    } catch (error) {
      const wrapped = toApplicationError(error, "QUERY_ERROR");
      log("error", "Tool execution failed", {
        toolName: request.params.name,
        code: wrapped.code,
        errorMessage: wrapped.message,
        details: wrapped.details
      });

      return {
        isError: true,
        content: [],
        structuredContent: {
          ...(fullAccess ? { warning: FULL_ACCESS_WARNING } : {}),
          error: {
            code: wrapped.code,
            message: wrapped.message,
            ...(compactErrorDetails(wrapped.details) ? { details: compactErrorDetails(wrapped.details) } : {})
          }
        }
      };
    }
  });

  const transport = new StdioServerTransport();
  try { await server.connect(transport); }
  catch (error) { disposeWatcher(); await sessions.close(); throw error; }

  let shutdownInFlight: Promise<void> | null = null;
  const shutdown = (): Promise<void> => {
    if (shutdownInFlight) {
      return shutdownInFlight;
    }
    shutdownInFlight = (async () => {
      disposeWatcher();
      await sessions.close();
      await server.close();
    })();
    return shutdownInFlight;
  };
  const dispose = (): void => {
    disposeWatcher();
    process.removeListener("SIGINT", handleSignal);
    process.removeListener("SIGTERM", handleSignal);
  };
  server.onclose = () => { dispose(); void sessions.close(); };
  const originalClose = server.close.bind(server);
  server.close = async () => { dispose(); await sessions.close(); await originalClose(); };
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
    (input.sessionId ? `Session ID: ${input.sessionId}\n` : "") +
    (input.sessionStateVersion !== undefined ? `Session State Version: ${input.sessionStateVersion}\n` : "") +
    `Statement: ${statement.firstKeyword}\n` +
    `Target: ${targetObject}\n` +
    `Risk Level: ${statement.riskLevel.toUpperCase()}\n` +
    `Risk Details: ${riskSummary}\n` +
    `Parameters: ${params}\n\n` +
    `SQL to execute:\n${input.sql}\n\n` +
    `Accept to execute this exact SQL; decline or cancel to leave it unexecuted.`
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

  if (database.readonly && database.dangerMode !== true) {
    throw new ApplicationError("NOT_SUPPORTED", `${input.databaseKey} is configured as readonly`);
  }

  const statement = inspectSqlStatement(input.sql);
  if (statement.isReadonlyQuery) {
    throw new ApplicationError("INVALID_ARGUMENT", "Use execute_query for query SQL");
  }

  const databaseFingerprint = fingerprintDatabaseTarget(database);

  // Full Access 仍绑定准确的目标配置，但不请求人工或自动审批。
  if (database.dangerMode === true) {
    return { status: "confirmed", databaseFingerprint };
  }

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
    `\n\nSQL to execute:\n${input.sql}` +
    `\n\nThe script runs on a single MySQL connection. Session variables such as @var are preserved across statements. ` +
    `Accept to execute this script; decline or cancel to leave it unexecuted.`
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

  if (database.readonly && database.dangerMode !== true) {
    throw new ApplicationError("NOT_SUPPORTED", `${input.databaseKey} is configured as readonly`);
  }

  const databaseFingerprint = fingerprintDatabaseTarget(database);

  // Full Access 优先于 Codex 自动审批与客户端 elicitation 能力。
  if (database.dangerMode === true) {
    return { status: "confirmed", databaseFingerprint };
  }

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
