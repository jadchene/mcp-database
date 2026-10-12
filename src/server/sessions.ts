import { randomUUID } from "node:crypto";
import type { DatabaseConfig, LoadedConfig } from "../config/configTypes.js";
import { fingerprintDatabaseTarget } from "../config/databaseFingerprint.js";
import { ApplicationError, toApplicationError } from "../core/errors.js";
import { createClient } from "../db/clientFactory.js";
import type { DatabaseAdapter, SqlDatabaseAdapter } from "../db/types.js";
import { transactionStatus, type TransactionStatus } from "../db/transaction.js";

/**
 * 会话持有一个适配器，生命周期内禁止隐式建连或重放操作。
 * @author chenjd
 * @created 2026-10-12 15:00:00
 */
interface Session {
  id: string;
  database: DatabaseConfig;
  fingerprint: string;
  adapter: DatabaseAdapter;
  busy: boolean;
  connecting: boolean;
  version: number;
  expiresAt: number;
  timer?: ReturnType<typeof setTimeout>;
  unsubscribe?: () => void;
  lost: Promise<never>;
  rejectLost: (error: ApplicationError) => void;
  transaction: TransactionStatus;
}

/**
 * 显式会话池，负责容量、空闲超时、并发占用和配置变更。
 * @author chenjd
 * @created 2026-10-12 15:00:00
 */
export class SessionPool {
  private readonly sessions = new Map<string, Session>();
  private readonly expired = new Map<string, { reason: string; at: number }>();
  private readonly closing = new Set<Promise<void>>();
  private stopped = false;

  public constructor(
    private readonly getConfig: () => LoadedConfig,
    private readonly factory: typeof createClient = createClient,
    private readonly now: () => number = Date.now
  ) {}

  /** 创建独立会话；连接中的条目也占用容量。 */
  public async connect(databaseKey: string): Promise<Record<string, unknown>> {
    if (this.stopped) throw new ApplicationError("SESSION_EXPIRED", "Database service is closing");
    const config = this.getConfig();
    const database = config.databaseMap.get(databaseKey);
    if (!database) throw new ApplicationError("DATABASE_NOT_FOUND", `Database not found: ${databaseKey}`);
    if (database.enable === false) throw new ApplicationError("DATABASE_DISABLED", "Database target is disabled");
    if (this.sessions.size >= (config.maxSessions ?? 32)) {
      throw new ApplicationError("SESSION_LIMIT_REACHED", "Database session limit reached; disconnect an unused session");
    }
    const adapter = this.factory(database, { queryTimeoutMs: config.query.timeoutMs });
    let rejectLost!: Session["rejectLost"];
    const lost = new Promise<never>((_resolve, reject) => { rejectLost = reject; });
    // 连接空闲期间的失效也需要处理拒绝，避免未处理 Promise。
    void lost.catch(() => undefined);
    const session: Session = {
      id: randomUUID(), database, fingerprint: this.fingerprint(database), adapter,
      busy: true, connecting: true, version: 0, expiresAt: Infinity, lost, rejectLost,
      transaction: transactionStatus(database.type === "redis" ? "not_supported" : "unknown")
    };
    this.sessions.set(session.id, session);
    session.unsubscribe = adapter.onConnectionLost?.(() => this.invalidate(session, "connection_lost"));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ApplicationError("CONNECTION_ERROR", "Database connection initialization timed out")), (database.connection.connectTimeoutMs ?? 10000) + 5000);
      });
      const establish = adapter.connect().then(async () => {
        // 超时/配置失效时驱动可能稍后才返回连接，不能遗留半建立资源。
        if (!this.sessions.has(session.id)) { await adapter.close(); throw this.expiredError(session.id); }
      });
      await Promise.race([establish, session.lost, deadline]);
      this.validateConfiguration(session);
      await this.observe(session);
      session.connecting = false;
      session.busy = false;
      this.arm(session);
      return this.snapshot(session);
    } catch (error) {
      this.invalidate(session, "connection_failed");
      throw toApplicationError(error, "CONNECTION_ERROR");
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** 从会话取得最新目标配置，仅用于校验和审批，不建立连接。 */
  public getDatabase(id: string): DatabaseConfig {
    const session = this.get(id);
    return this.getConfig().databaseMap.get(session.database.key)!;
  }

  /** 审批绑定当前会话版本，审批等待期间不暂停空闲期限。 */
  public approvalToken(id: string): { id: string; version: number } {
    const session = this.get(id);
    if (session.busy) throw new ApplicationError("SESSION_BUSY", "Session is executing another operation");
    return { id, version: session.version };
  }

  /** 审批完成后防止批准另一份已被修改的事务或会话状态。 */
  public validateApproval(token: { id: string; version: number }): void {
    const session = this.get(token.id);
    if (session.busy || session.version !== token.version) {
      throw new ApplicationError("INVALID_ARGUMENT", "Session state changed while awaiting approval; request approval again");
    }
  }

  /** 同一会话一次执行一个操作；执行及协议收尾完成后刷新空闲期限。 */
  public async use<T>(id: string, expectedType: "sql" | "redis" | "any", action: (adapter: DatabaseAdapter) => Promise<T>, writeOperation = false, updatesVersion = true): Promise<T & Record<string, unknown>> {
    const session = this.get(id);
    if (session.busy) throw new ApplicationError("SESSION_BUSY", "Session is executing another operation");
    if ((expectedType === "sql" && session.database.type === "redis") || (expectedType === "redis" && session.database.type !== "redis")) {
      throw new ApplicationError("NOT_SUPPORTED", `This tool requires a ${expectedType} session`);
    }
    session.busy = true;
    if (updatesVersion) session.version++;
    const previousTransaction = session.transaction;
    if (session.timer) clearTimeout(session.timer);
    const timeoutMs = this.getConfig().query.timeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const operation = (async () => {
        const result = await action(session.adapter);
        this.validateConfiguration(session);
        await this.observe(session);
        // 单纯查看状态不改变审批版本；发现实际事务状态变化时仍使旧审批失效。
        if (!updatesVersion && (session.transaction.state !== previousTransaction.state || session.transaction.autoCommit !== previousTransaction.autoCommit)) session.version++;
        if (!this.sessions.has(id)) throw this.expiredError(id);
        return result;
      })();
      const timeout = new Promise<never>((_resolve, reject) => {
        if (!timeoutMs) return;
        timer = setTimeout(() => {
          // 生命周期统一收尾；不能在超时后继续使用可能仍在执行 SQL 的连接。
          reject(new ApplicationError(writeOperation ? "EXECUTION_OUTCOME_UNKNOWN" : "TIMEOUT", "Database operation timed out; session invalidated", { timeoutMs }));
          this.invalidate(session, "operation_timeout");
        }, timeoutMs + 100);
      });
      const result = await Promise.race([operation, session.lost, timeout]);
      this.arm(session);
      return { ...result, ...this.snapshot(session) };
    } catch (error) {
      let wrapped = toApplicationError(error, "QUERY_ERROR");
      if (writeOperation && ["CONNECTION_ERROR", "TIMEOUT", "SESSION_EXPIRED"].includes(wrapped.code)) {
        wrapped = new ApplicationError("EXECUTION_OUTCOME_UNKNOWN", "Connection lost while executing SQL; execution outcome is unknown", wrapped.details);
      }
      if (["TIMEOUT", "EXECUTION_OUTCOME_UNKNOWN", "CONNECTION_ERROR"].includes(wrapped.code)) {
        this.invalidate(session, wrapped.code === "CONNECTION_ERROR" ? "connection_lost" : "operation_timeout");
      }
      if (this.sessions.has(id)) {
        try { await this.observe(session); }
        catch (statusError) {
          session.transaction = transactionStatus("unknown");
          const failure = toApplicationError(statusError, "CONNECTION_ERROR");
          if (["CONNECTION_ERROR", "TIMEOUT"].includes(failure.code)) this.invalidate(session, "connection_lost");
        }
      } else {
        session.transaction = transactionStatus("unknown");
      }
      if (this.sessions.has(id)) this.arm(session, !["INVALID_ARGUMENT", "NOT_SUPPORTED", "READONLY_VIOLATION"].includes(wrapped.code));
      throw new ApplicationError(wrapped.code, wrapped.message, { ...wrapped.details, ...this.snapshot(session) });
    } finally {
      if (timer) clearTimeout(timer);
      session.busy = false;
    }
  }

  /** 显式关闭空闲会话；关闭后的旧 ID 永久失效。 */
  public async disconnect(id: string): Promise<Record<string, unknown>> {
    if (this.expired.get(id)?.reason === "disconnected") return { sessionId: id, status: "disconnected" };
    const session = this.get(id);
    if (session.busy) throw new ApplicationError("SESSION_BUSY", "Session is executing another operation");
    this.invalidate(session, "disconnected");
    await Promise.all([...this.closing]);
    return { sessionId: id, status: "disconnected" };
  }

  /** 热更新使禁用、删除或权限/连接身份变化的旧会话失效。 */
  public reconcile(): void {
    for (const session of [...this.sessions.values()]) {
      try { this.validateConfiguration(session); } catch { /* 已统一失效并关闭。 */ }
    }
  }

  /** 服务和传输关闭时释放全部连接和定时器。 */
  public async close(): Promise<void> {
    this.stopped = true;
    for (const session of [...this.sessions.values()]) this.invalidate(session, "service_closed");
    await Promise.all([...this.closing]);
  }

  private get(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw this.expiredError(id);
    this.validateConfiguration(session);
    if (!session.busy && this.now() >= session.expiresAt) {
      this.invalidate(session, "idle_timeout");
      throw this.expiredError(id);
    }
    if (session.adapter.isConnected?.() === false && !session.connecting) {
      this.invalidate(session, "connection_lost");
      throw this.expiredError(id);
    }
    return session;
  }

  private fingerprint(database: DatabaseConfig): string {
    return `${fingerprintDatabaseTarget(database)}:${this.getConfig().query.timeoutMs}`;
  }

  private validateConfiguration(session: Session): void {
    const database = this.getConfig().databaseMap.get(session.database.key);
    if (!database || database.enable === false || this.fingerprint(database) !== session.fingerprint || !this.sessions.has(session.id)) {
      this.invalidate(session, database?.enable === false ? "database_disabled" : "configuration_changed");
      throw this.expiredError(session.id);
    }
  }

  private async observe(session: Session): Promise<void> {
    if (session.database.type === "redis") { session.transaction = transactionStatus("not_supported"); return; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      session.transaction = await Promise.race([
        (session.adapter as SqlDatabaseAdapter).getTransactionStatus(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new ApplicationError("CONNECTION_ERROR", "Database transaction status could not be synchronized")), 5000);
        })
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }

  private snapshot(session: Session): Record<string, unknown> {
    return {
      sessionId: session.id, databaseKey: session.database.key, type: session.database.type,
      transaction: session.transaction, sessionStateVersion: session.version,
      idleTimeoutMs: this.getConfig().sessionIdleTimeoutMs ?? 1800000,
      expiresAt: Number.isFinite(session.expiresAt) ? new Date(session.expiresAt).toISOString() : null
    };
  }

  private arm(session: Session, refresh = true): void {
    if (session.timer) clearTimeout(session.timer);
    if (refresh) session.expiresAt = this.now() + (this.getConfig().sessionIdleTimeoutMs ?? 1800000);
    session.timer = setTimeout(() => {
      if (!session.busy) this.invalidate(session, "idle_timeout");
    }, Math.max(1, session.expiresAt - this.now()));
    session.timer.unref();
  }

  private expiredError(id: string): ApplicationError {
    return new ApplicationError("SESSION_EXPIRED", "Database session expired; call connect explicitly", {
      reason: this.expired.get(id)?.reason ?? "unknown_session", sessionId: id, transaction: transactionStatus("unknown")
    });
  }

  private invalidate(session: Session, reason: string): void {
    if (!this.sessions.delete(session.id)) return;
    if (session.timer) clearTimeout(session.timer);
    session.unsubscribe?.();
    this.expired.set(session.id, { reason, at: this.now() });
    for (const [id, record] of this.expired) {
      if (this.expired.size > 1024 || this.now() - record.at > 3600000) this.expired.delete(id);
    }
    session.rejectLost(this.expiredError(session.id));
    const cleanup = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          (async () => {
            if (session.busy) await session.adapter.abort?.().catch(() => undefined);
            await session.adapter.close();
          })(),
          new Promise<void>((resolve) => { timer = setTimeout(() => { void session.adapter.abort?.().catch(() => undefined); resolve(); }, 5000); })
        ]);
      } catch { /* 断线后的关闭错误不掩盖原操作结果。 */ }
      finally { if (timer) clearTimeout(timer); }
    })();
    this.closing.add(cleanup);
    void cleanup.finally(() => this.closing.delete(cleanup));
  }
}
