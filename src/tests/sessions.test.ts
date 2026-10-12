import test from "node:test";
import assert from "node:assert/strict";
import type { DatabaseConfig, LoadedConfig } from "../config/configTypes.js";
import type { DatabaseAdapter } from "../db/types.js";
import { SessionPool } from "../server/sessions.js";
import { ApplicationError } from "../core/errors.js";
import { transactionStatus } from "../db/transaction.js";
import { summarizeLoadedConfig } from "../config/configSummary.js";
import { validateDatabaseConfig } from "../config/configValidation.js";
import { buildToolRegistry } from "../server/toolRegistry.js";
import { readMysqlOkStatus } from "../db/sql/mysqlStatus.js";

const target: DatabaseConfig = { key: "test", type: "mysql", readonly: false, connection: { host: "unused", user: "test", password: "", databaseName: "test" } };

/** 构造只用于会话生命周期的可计数连接夹具。 */
function fixture(idleTimeoutMs = 100) {
  const config: LoadedConfig = { configPath: "unused", loadedAt: "now", databases: [target], databaseMap: new Map([[target.key, target]]), logging: { enabled: false, directory: "unused" }, query: { timeoutMs: null }, sessionIdleTimeoutMs: idleTimeoutMs, maxSessions: 2 };
  const adapters: Array<DatabaseAdapter & { loses: () => void; connects: number; closes: number; status: "none" | "active" }> = [];
  let now = Date.now();
  const pool = new SessionPool(() => config, database => {
    let listener = () => {};
    const adapter = {
      config: database, connects: 0, closes: 0, status: "none" as "none" | "active",
      async connect() { this.connects++; }, async close() { this.closes++; }, async abort() {},
      async ping() { return { ok: true as const, latencyMs: 0 }; },
      onConnectionLost(callback: () => void) { listener = callback; return () => { listener = () => {}; }; },
      loses() { listener(); }, isConnected: () => true,
      async getTransactionStatus() { return transactionStatus(this.status, true); }
    };
    adapters.push(adapter);
    return adapter;
  }, () => now);
  return { config, adapters, pool, advance: (ms: number) => { now += ms; } };
}

/** 验证稳定错误码。 */
const code = (expected: string) => (error: unknown) => error instanceof ApplicationError && error.code === expected;

test("only connect creates connections; operations share state and disconnected IDs never reconnect", async () => {
  const { pool, adapters } = fixture();
  try {
    const first = await pool.connect("test");
    const id = String(first.sessionId);
    await pool.use(id, "sql", async () => { adapters[0]!.status = "active"; return {}; });
    const state = await pool.use(id, "sql", async () => ({}));
    assert.equal((state.transaction as { state: string }).state, "active");
    assert.equal(adapters.length, 1);
    assert.equal(adapters[0]!.connects, 1);
    await pool.disconnect(id);
    assert.equal(adapters[0]!.closes, 1);
    await assert.rejects(() => pool.use(id, "sql", async () => ({})), code("SESSION_EXPIRED"));
    await pool.disconnect(id);
    assert.equal(adapters.length, 1);
  } finally { await pool.close(); }
});

test("expired requests fail even before timer delivery and release the connection", async () => {
  const { pool, adapters, advance } = fixture();
  const { sessionId } = await pool.connect("test");
  advance(101);
  await assert.rejects(() => pool.use(String(sessionId), "sql", async () => ({})), code("SESSION_EXPIRED"));
  await pool.close();
  assert.equal(adapters[0]!.closes, 1);
});

test("idle expiry slides after each completed operation, including SQL errors, instead of expiring at connection age", async () => {
  const { pool, advance } = fixture();
  try {
    const id = String((await pool.connect("test")).sessionId);
    advance(80);
    await pool.use(id, "sql", async () => ({}));
    advance(80);
    await pool.use(id, "sql", async () => ({}));
    advance(80);
    await assert.rejects(() => pool.use(id, "sql", async () => { throw new ApplicationError("QUERY_ERROR", "syntax error"); }), code("QUERY_ERROR"));
    advance(80);
    await pool.use(id, "sql", async () => ({}));
    advance(101);
    await assert.rejects(() => pool.use(id, "sql", async () => ({})), code("SESSION_EXPIRED"));
  } finally { await pool.close(); }
});

test("background idle cleanup extends with use and closes forgotten sessions without another request", async () => {
  const { pool, adapters } = fixture(120);
  try {
    const id = String((await pool.connect("test")).sessionId);
    await new Promise(resolve => setTimeout(resolve, 75));
    await pool.use(id, "sql", async () => ({}));
    await new Promise(resolve => setTimeout(resolve, 75));
    await pool.use(id, "sql", async () => ({}));
    assert.equal(adapters[0]!.closes, 0);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(adapters[0]!.closes, 1);
    await assert.rejects(() => pool.use(id, "sql", async () => ({})), code("SESSION_EXPIRED"));
  } finally { await pool.close(); }
});

test("invalid operation arguments cannot extend idle lifetime", async () => {
  const { pool, advance } = fixture();
  try {
    const id = String((await pool.connect("test")).sessionId);
    advance(80);
    await assert.rejects(() => pool.use(id, "sql", async () => { throw new ApplicationError("INVALID_ARGUMENT", "invalid option"); }), code("INVALID_ARGUMENT"));
    advance(21);
    await assert.rejects(() => pool.use(id, "sql", async () => ({})), code("SESSION_EXPIRED"));
  } finally { await pool.close(); }
});

test("failure to observe connection state after a SQL error invalidates the session", async () => {
  const { pool, adapters } = fixture();
  try {
    const id = String((await pool.connect("test")).sessionId);
    (adapters[0] as any).getTransactionStatus = async () => { throw new ApplicationError("CONNECTION_ERROR", "status unavailable"); };
    await assert.rejects(() => pool.use(id, "sql", async () => { throw new ApplicationError("QUERY_ERROR", "syntax error"); }), code("QUERY_ERROR"));
    await assert.rejects(() => pool.use(id, "sql", async () => ({})), code("SESSION_EXPIRED"));
  } finally { await pool.close(); }
});

test("long operations suspend idle expiry; same-session concurrency is rejected", async () => {
  const { pool, advance } = fixture();
  try {
    const id = String((await pool.connect("test")).sessionId);
    let release!: () => void;
    const running = pool.use(id, "sql", () => new Promise<Record<string, unknown>>(resolve => { release = () => resolve({}); }));
    advance(1000);
    await assert.rejects(() => pool.use(id, "sql", async () => ({})), code("SESSION_BUSY"));
    await assert.rejects(() => pool.disconnect(id), code("SESSION_BUSY"));
    release();
    await running;
    await pool.use(id, "sql", async () => ({}));
  } finally { await pool.close(); }
});

test("disabled targets never connect; hot disable expires active IDs and enable does not revive them", async () => {
  const { pool, config, adapters } = fixture();
  try {
    const id = String((await pool.connect("test")).sessionId);
    config.databases = [{ ...target, enable: false }];
    config.databaseMap.set("test", config.databases[0]!);
    pool.reconcile();
    await assert.rejects(() => pool.connect("test"), code("DATABASE_DISABLED"));
    await assert.rejects(() => pool.use(id, "sql", async () => ({})), code("SESSION_EXPIRED"));
    assert.equal(adapters.length, 1);
    config.databaseMap.set("test", target);
    await pool.connect("test");
    await assert.rejects(() => pool.use(id, "sql", async () => ({})), code("SESSION_EXPIRED"));
  } finally { await pool.close(); }
});

test("connection loss rejects waiting operations; write outcome is unknown without replay", async () => {
  const { pool, adapters } = fixture();
  const id = String((await pool.connect("test")).sessionId);
  const running = pool.use(id, "sql", () => new Promise(() => {}), true);
  adapters[0]!.loses();
  await assert.rejects(() => running, code("EXECUTION_OUTCOME_UNKNOWN"));
  await pool.close();
  assert.equal(adapters.length, 1);
});

test("capacity includes connecting sessions and failed connects release capacity", async () => {
  const { pool } = fixture();
  try {
    await pool.connect("test");
    await pool.connect("test");
    await assert.rejects(() => pool.connect("test"), code("SESSION_LIMIT_REACHED"));
  } finally { await pool.close(); }
  const state = fixture();
  state.config.maxSessions = 1;
  const delayed = new SessionPool(() => state.config, config => ({
    config, async connect() { throw new Error("failed"); }, async close() {}, async ping() { return { ok: true, latencyMs: 0 }; }
  }));
  await assert.rejects(() => delayed.connect("test"), code("CONNECTION_ERROR"));
  await assert.rejects(() => delayed.connect("test"), code("CONNECTION_ERROR"));
  await delayed.close();
  await state.pool.close();
});

test("approval wait does not extend lifetime; changed session versions invalidate approval", async () => {
  const { pool, advance } = fixture();
  try {
    const id = String((await pool.connect("test")).sessionId);
    const token = pool.approvalToken(id);
    await pool.use(id, "sql", async () => ({}));
    assert.throws(() => pool.validateApproval(token), code("INVALID_ARGUMENT"));
    const fresh = pool.approvalToken(id);
    advance(101);
    assert.throws(() => pool.validateApproval(fresh), code("SESSION_EXPIRED"));
  } finally { await pool.close(); }
});

test("inspecting unchanged transaction state preserves approval, while detecting actual change invalidates it", async () => {
  const { pool, adapters } = fixture();
  try {
    const id = String((await pool.connect("test")).sessionId);
    const token = pool.approvalToken(id);
    await pool.use(id, "any", async () => ({}), false, false);
    pool.validateApproval(token);
    adapters[0]!.status = "active";
    await pool.use(id, "any", async () => ({}), false, false);
    assert.throws(() => pool.validateApproval(token), code("INVALID_ARGUMENT"));
  } finally { await pool.close(); }
});

test("disabled configurations are omitted from every AI summary and defaults remain enabled", () => {
  const parsed = validateDatabaseConfig({ databases: [target, { ...target, key: "hidden", enable: false }] });
  assert.equal(parsed.databases[0]!.enable, true);
  const state = fixture();
  state.config.databases = parsed.databases;
  const summary = summarizeLoadedConfig(state.config);
  assert.equal(summary.databaseCount, 1);
  assert.equal(JSON.stringify(summary).includes("hidden"), false);
  assert.throws(() => validateDatabaseConfig({ databases: [{ ...target, enable: "false" }] }), code("CONFIG_ERROR"));
  for (const enable of [true, false]) {
    assert.throws(() => validateDatabaseConfig({ databases: [{ ...target, type: "opengauss", enable }] }), code("CONFIG_ERROR"));
  }
});

test("all database operations reject the old target contract; five management tools are present", () => {
  const tools = buildToolRegistry();
  assert.equal(tools.length, 30);
  for (const tool of tools) {
    if (["connect", "list_databases", "show_loaded_config", "reload_config"].includes(tool.name)) continue;
    const properties = tool.inputSchema.properties as Record<string, unknown>;
    assert.ok(properties.sessionId, tool.name);
    assert.equal(properties.databaseKey, undefined, tool.name);
    assert.ok((tool.inputSchema.required as string[]).includes("sessionId"), tool.name);
  }
});

test("MySQL OK state parsing distinguishes transaction and autocommit without modifying packet offset", () => {
  for (const flags of [0, 1, 2, 3]) {
    const buffer = Buffer.from([0, 0, 0, flags, 0, 0, 0]);
    const packet = { buffer, offset: 0, end: buffer.length };
    assert.equal(readMysqlOkStatus(packet), flags);
    assert.equal(packet.offset, 0);
  }
  assert.equal(readMysqlOkStatus({ buffer: Buffer.from([0]), offset: 0, end: 1 }), null);
});
