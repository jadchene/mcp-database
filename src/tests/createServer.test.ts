import test from "node:test";
import assert from "node:assert/strict";

import { ApplicationError } from "../core/errors.js";
import { confirmStatementExecutionWithFallback } from "../server/createServer.js";

const writableMysqlTarget = {
  key: "mysql-write",
  type: "mysql" as const,
  readonly: false,
  connection: {
    host: "127.0.0.1",
    databaseName: "app_db",
    user: "root",
    password: "secret"
  }
};

test("two-step confirmation returns pending when interactive confirmation is unavailable", async () => {
  const pendingConfirmations = new Map();

  const result = await confirmStatementExecutionWithFallback({
    database: writableMysqlTarget,
    input: {
      databaseKey: "mysql-write",
      sql: "update users set enabled = ? where id = ?",
      params: [0, 1]
    },
    pendingConfirmations,
    supportsInteractiveConfirmation: false,
    createId: () => "confirm-1"
  });

  assert.equal(result.status, "pending");
  assert.equal(result.confirmationId, "confirm-1");
  assert.equal(pendingConfirmations.size, 1);
});

test("interactive confirmation falls back to two-step when elicitation throws", async () => {
  const pendingConfirmations = new Map();

  const result = await confirmStatementExecutionWithFallback({
    database: writableMysqlTarget,
    input: {
      databaseKey: "mysql-write",
      sql: "delete from users where id = ?",
      params: [1]
    },
    pendingConfirmations,
    supportsInteractiveConfirmation: true,
    elicitConfirmation: async () => {
      throw new Error("Host claimed elicitation support but failed");
    },
    createId: () => "confirm-2"
  });

  assert.equal(result.status, "pending");
  assert.equal(result.confirmationId, "confirm-2");
  assert.equal(pendingConfirmations.size, 1);
});

test("two-step confirmation rejects changed SQL or params on second call", async () => {
  const pendingConfirmations = new Map();

  const firstResult = await confirmStatementExecutionWithFallback({
    database: writableMysqlTarget,
    input: {
      databaseKey: "mysql-write",
      sql: "update users set enabled = ? where id = ?",
      params: [0, 1]
    },
    pendingConfirmations,
    supportsInteractiveConfirmation: false,
    createId: () => "confirm-3"
  });

  assert.equal(firstResult.status, "pending");

  await assert.rejects(
    () =>
      confirmStatementExecutionWithFallback({
        database: writableMysqlTarget,
        input: {
          databaseKey: "mysql-write",
          sql: "update users set enabled = ? where id = ?",
          params: [0, 2],
          confirmationId: "confirm-3",
          confirmExecution: true
        },
        pendingConfirmations,
        supportsInteractiveConfirmation: false
      }),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.code === "INVALID_ARGUMENT" &&
      /does not match the pending SQL request/i.test(error.message)
  );
});

test("two-step confirmation enforces a maximum number of pending requests", async () => {
  const pendingConfirmations = new Map([
    [
      "confirm-existing",
      {
        databaseKey: "mysql-write",
        sql: "update users set enabled = 1 where id = 1",
        params: [],
        expiresAt: Date.now() + 60_000
      }
    ]
  ]);

  await assert.rejects(
    () =>
      confirmStatementExecutionWithFallback({
        database: writableMysqlTarget,
        input: {
          databaseKey: "mysql-write",
          sql: "update users set enabled = ? where id = ?",
          params: [0, 1]
        },
        pendingConfirmations,
        supportsInteractiveConfirmation: false,
        maxPendingConfirmations: 1
      }),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.code === "TIMEOUT" &&
      /Too many pending write confirmations/i.test(error.message)
  );
});
