import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { OracleAdapter } from "../db/sql/oracleClient.js";
import { PostgresAdapter } from "../db/sql/postgresClient.js";

test("Oracle DML is not automatically committed or rolled back and native status remains observable", async () => {
  const adapter = new OracleAdapter({ key: "oracle", type: "oracle", readonly: false, connection: { host: "unused", serviceName: "unused", user: "test", password: "" } }, null);
  const calls: string[] = [];
  const connection = {
    transactionInProgress: false,
    async ping() {},
    async execute(sql: string) {
      calls.push(sql);
      if (sql.startsWith("UPDATE")) this.transactionInProgress = true;
      if (sql === "COMMIT" || sql === "ROLLBACK") this.transactionInProgress = false;
      if (sql.startsWith("INSERT")) throw new Error("constraint violation");
      return { rowsAffected: 1 };
    },
    async commit() { throw new Error("hidden commit"); }, async rollback() { throw new Error("hidden rollback"); }
  };
  (adapter as any).connection = connection;
  await adapter.executeStatement("UPDATE t SET value = 1 WHERE id = 1");
  assert.equal((await adapter.getTransactionStatus()).state, "active");
  await assert.rejects(() => adapter.executeStatement("INSERT INTO t VALUES (1)"), /constraint violation/);
  assert.equal((await adapter.getTransactionStatus()).state, "active");
  assert.deepEqual(await adapter.rollbackTransaction(), { outcome: "rolled_back" });
  assert.equal((await adapter.getTransactionStatus()).state, "none");
  await adapter.executeStatement("UPDATE t SET value = 2 WHERE id = 1");
  assert.deepEqual(await adapter.commitTransaction(), { outcome: "committed" });
  assert.deepEqual(calls, ["UPDATE t SET value = 1 WHERE id = 1", "INSERT INTO t VALUES (1)", "ROLLBACK", "UPDATE t SET value = 2 WHERE id = 1", "COMMIT"]);
});

test("PostgreSQL failed transaction state is read from ReadyForQuery and cannot be misreported as committed", async () => {
  const adapter = new PostgresAdapter({ key: "pg", type: "postgresql", readonly: false, connection: { host: "unused", databaseName: "unused", user: "test", password: "" } }, null);
  let status = "E";
  const calls: string[] = [];
  const events = new EventEmitter();
  const client = {
    readyForQuery: true, connection: events,
    getTransactionStatus: () => status,
    async query(sql: string) { calls.push(sql); if (sql === "ROLLBACK") status = "I"; return { rows: [], rowCount: 0, command: sql }; }
  };
  (adapter as any).client = client;
  assert.equal((await adapter.getTransactionStatus()).state, "failed");
  await assert.rejects(() => adapter.commitTransaction(), /roll back/);
  assert.deepEqual(calls, []);
  await adapter.rollbackTransaction();
  assert.equal((await adapter.getTransactionStatus()).state, "none");
  client.readyForQuery = false;
  const pending = adapter.getTransactionStatus();
  status = "T";
  client.readyForQuery = true;
  events.emit("readyForQuery");
  assert.equal((await pending).state, "active");
});

test("Oracle explain uses short unique plan IDs and isolated savepoints without ending the user transaction", async () => {
  const adapter = new OracleAdapter({ key: "oracle", type: "oracle", readonly: false, connection: { host: "unused", serviceName: "unused", user: "test", password: "" } }, null);
  const calls: string[] = [];
  (adapter as any).connection = {
    transactionInProgress: true, async ping() {},
    async execute(sql: string) { calls.push(sql); return { rows: [] }; }
  };
  await adapter.explainQuery("SELECT 1 FROM dual", [], 10);
  await adapter.explainQuery("SELECT 2 FROM dual", [], 10);
  const plans = calls.filter(sql => sql.startsWith("EXPLAIN PLAN"));
  const identifiers = plans.map(sql => /STATEMENT_ID = '([^']+)'/.exec(sql)![1]!);
  assert.ok(identifiers.every(value => value.length <= 30));
  assert.notEqual(identifiers[0], identifiers[1]);
  for (const identifier of identifiers) {
    assert.ok(calls.includes(`SAVEPOINT ${identifier.toUpperCase()}`));
    assert.ok(calls.includes(`ROLLBACK TO SAVEPOINT ${identifier.toUpperCase()}`));
  }
  assert.equal(calls.includes("ROLLBACK"), false);
  assert.equal((await adapter.getTransactionStatus()).state, "active");
});
