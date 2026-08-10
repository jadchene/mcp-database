import test from "node:test";
import assert from "node:assert/strict";

import { fingerprintDatabaseTarget } from "../config/databaseFingerprint.js";
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

test("two-step confirmation rejects a changed database target", async () => {
  const pendingConfirmations = new Map();

  await confirmStatementExecutionWithFallback({
    database: writableMysqlTarget,
    input: {
      databaseKey: "mysql-write",
      sql: "delete from users where id = ?",
      params: [1]
    },
    pendingConfirmations,
    supportsInteractiveConfirmation: false,
    createId: () => "confirm-target"
  });

  await assert.rejects(
    () => confirmStatementExecutionWithFallback({
      database: {
        ...writableMysqlTarget,
        connection: {
          ...writableMysqlTarget.connection,
          host: "production.example.internal",
          databaseName: "production"
        }
      },
      input: {
        databaseKey: "mysql-write",
        sql: "delete from users where id = ?",
        params: [1],
        confirmationId: "confirm-target",
        confirmExecution: true
      },
      pendingConfirmations,
      supportsInteractiveConfirmation: false
    }),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.code === "INVALID_ARGUMENT" &&
      /configuration changed after confirmation/i.test(error.message)
  );
  assert.equal(pendingConfirmations.size, 0);
});

test("two-step confirmation enforces a maximum number of pending requests", async () => {
  const pendingConfirmations = new Map([
    [
      "confirm-existing",
      {
        databaseKey: "mysql-write",
        databaseFingerprint: fingerprintDatabaseTarget(writableMysqlTarget),
        requiresUserToken: false,
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

test("user-token confirmation rejects confirmationId alone and accepts a user token", async () => {
  const pendingConfirmations = new Map();
  let preparedId = "";
  let preparedExpiresAt = 0;
  const confirmationId = "123e4567-e89b-42d3-a456-426614174000";

  const firstResult = await confirmStatementExecutionWithFallback({
    database: writableMysqlTarget,
    input: {
      databaseKey: "mysql-write",
      sql: "delete from users where id = ?",
      params: [1]
    },
    pendingConfirmations,
    supportsInteractiveConfirmation: true,
    requireUserToken: true,
    elicitConfirmation: async () => true,
    createId: () => confirmationId,
    prepareUserToken: async (id, expiresAt) => {
      preparedId = id;
      preparedExpiresAt = expiresAt;
    }
  });

  assert.equal(firstResult.status, "pending");
  assert.equal(firstResult.confirmationMode, "user_token");
  assert.equal(preparedId, confirmationId);
  assert.ok(preparedExpiresAt > Date.now());

  await assert.rejects(
    () => confirmStatementExecutionWithFallback({
      database: writableMysqlTarget,
      input: {
        databaseKey: "mysql-write",
        sql: "delete from users where id = ?",
        params: [1],
        confirmationId,
        confirmExecution: true
      },
      pendingConfirmations,
      supportsInteractiveConfirmation: false,
      requireUserToken: true,
      verifyUserToken: async () => true
    }),
    (error: unknown) =>
      error instanceof ApplicationError &&
      /user-provided authorization token is required/i.test(error.message)
  );

  const confirmed = await confirmStatementExecutionWithFallback({
    database: writableMysqlTarget,
    input: {
      databaseKey: "mysql-write",
      sql: "delete from users where id = ?",
      params: [1],
      confirmationId,
      confirmExecution: true,
      userToken: "provided-by-user"
    },
    pendingConfirmations,
    supportsInteractiveConfirmation: false,
    requireUserToken: true,
    verifyUserToken: async (id, token) => id === confirmationId && token === "provided-by-user"
  });

  assert.equal(confirmed.status, "confirmed");
  assert.equal(pendingConfirmations.size, 0);
});

test("user-token confirmation rejects an invalid token without consuming the pending request", async () => {
  const pendingConfirmations = new Map();
  const confirmationId = "123e4567-e89b-42d3-a456-426614174001";

  await confirmStatementExecutionWithFallback({
    database: writableMysqlTarget,
    input: {
      databaseKey: "mysql-write",
      sql: "update users set enabled = 0 where id = 1"
    },
    pendingConfirmations,
    supportsInteractiveConfirmation: false,
    requireUserToken: true,
    createId: () => confirmationId,
    prepareUserToken: async () => undefined
  });

  await assert.rejects(
    () => confirmStatementExecutionWithFallback({
      database: writableMysqlTarget,
      input: {
        databaseKey: "mysql-write",
        sql: "update users set enabled = 0 where id = 1",
        confirmationId,
        confirmExecution: true,
        userToken: "wrong-token"
      },
      pendingConfirmations,
      supportsInteractiveConfirmation: false,
      requireUserToken: true,
      verifyUserToken: async () => false
    }),
    (error: unknown) =>
      error instanceof ApplicationError && /authorization token is invalid or expired/i.test(error.message)
  );

  assert.equal(pendingConfirmations.size, 1);
});

test("a pending write is invalidated when the user-token confirmation mode changes", async () => {
  const pendingConfirmations = new Map();
  const confirmationId = "123e4567-e89b-42d3-a456-426614174002";

  await confirmStatementExecutionWithFallback({
    database: writableMysqlTarget,
    input: {
      databaseKey: "mysql-write",
      sql: "delete from users where id = 1"
    },
    pendingConfirmations,
    supportsInteractiveConfirmation: false,
    createId: () => confirmationId
  });

  await assert.rejects(
    () => confirmStatementExecutionWithFallback({
      database: writableMysqlTarget,
      input: {
        databaseKey: "mysql-write",
        sql: "delete from users where id = 1",
        confirmationId,
        confirmExecution: true,
        userToken: "x".repeat(43)
      },
      pendingConfirmations,
      supportsInteractiveConfirmation: false,
      requireUserToken: true,
      verifyUserToken: async () => true
    }),
    (error: unknown) =>
      error instanceof ApplicationError && /confirmation settings changed/i.test(error.message)
  );

  assert.equal(pendingConfirmations.size, 0);
});
