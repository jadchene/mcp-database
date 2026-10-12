import test from "node:test";
import assert from "node:assert/strict";
import { compactErrorDetails, compactToolResult } from "../server/toolResult.js";

const metadata = { sessionId: "known", databaseKey: "known-target", type: "mysql", sessionStateVersion: 3, expiresAt: "later", idleTimeoutMs: 1800000, transaction: { state: "active", autoCommit: true, observedAt: "now" } };

test("ordinary results contain business data and minimal transaction state, preserving similarly named row columns", () => {
  const rows = [{ type: "customer", sessionId: "row-value" }];
  assert.deepEqual(compactToolResult("execute_query", { ...metadata, rows, rowCount: 1, truncated: false }), { rows, rowCount: 1, truncated: false, transaction: { state: "active" } });
});

test("only connect returns session binding and idle policy; state inspection adds autocommit", () => {
  assert.deepEqual(compactToolResult("connect", metadata), { sessionId: "known", databaseKey: "known-target", type: "mysql", idleTimeoutMs: 1800000, transaction: { state: "active" } });
  assert.deepEqual(compactToolResult("get_transaction_status", metadata), { transaction: { state: "active", autoCommit: true } });
  assert.deepEqual(compactToolResult("disconnect", { sessionId: "known", status: "disconnected" }), { status: "disconnected" });
});

test("errors retain useful causes and state without internal session diagnostics", () => {
  assert.deepEqual(compactErrorDetails({ ...metadata, reason: "connection_lost" }), { reason: "connection_lost", transaction: { state: "active" } });
  assert.equal(compactErrorDetails({}), undefined);
});

test("Redis reads omit SQL transaction boilerplate, while explicit state inspection reports unsupported", () => {
  const value = { ...metadata, transaction: { state: "not_supported", autoCommit: null }, value: "data" };
  assert.deepEqual(compactToolResult("redis_get", value), { value: "data" });
  assert.deepEqual(compactToolResult("get_transaction_status", { ...metadata, transaction: { state: "not_supported", autoCommit: null } }), { transaction: { state: "not_supported", autoCommit: null } });
});
