/**
 * 工具响应仅保留业务结果及必要事务状态，隐藏内部会话诊断字段。
 * @author chenjd
 * @created 2026-10-12 15:10:00
 */
const sessionFields = ["sessionId", "databaseKey", "type", "sessionStateVersion", "idleTimeoutMs", "expiresAt"];
const configTools = new Set(["list_databases", "show_loaded_config", "reload_config"]);

/** 普通 SQL 返回状态；专用状态工具额外返回自动提交设置。 */
function compactTransaction(value: unknown, includeAutoCommit: boolean): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const status = value as Record<string, unknown>;
  if (typeof status.state !== "string") return undefined;
  return { state: status.state, ...(includeAutoCommit ? { autoCommit: status.autoCommit ?? null } : {}) };
}

/** 连接返回绑定信息，其余调用不重复调用方已经持有的会话信息。 */
export function compactToolResult(toolName: string, value: unknown): Record<string, unknown> {
  const result = { ...(value as Record<string, unknown>) };
  if (configTools.has(toolName)) return result;
  const transaction = compactTransaction(result.transaction, toolName === "get_transaction_status");
  for (const field of sessionFields) {
    if (toolName === "connect" && ["sessionId", "databaseKey", "type", "idleTimeoutMs"].includes(field)) continue;
    delete result[field];
  }
  if (transaction && (transaction.state !== "not_supported" || toolName === "get_transaction_status")) result.transaction = transaction;
  else delete result.transaction;
  return result;
}

/** 错误保留原因、参数问题及必要状态，不返回整份会话快照。 */
export function compactErrorDetails(details?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!details) return undefined;
  const result = { ...details };
  for (const field of sessionFields) delete result[field];
  const transaction = compactTransaction(result.transaction, false);
  if (transaction) result.transaction = transaction;
  else delete result.transaction;
  return Object.keys(result).length ? result : undefined;
}
