import test from "node:test";
import assert from "node:assert/strict";

import { fingerprintDatabaseTarget } from "../config/databaseFingerprint.js";
import { ApplicationError } from "../core/errors.js";
import { confirmStatementExecution } from "../server/createServer.js";

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

test("write confirmation fails closed when elicitation is unavailable", async () => {
  await assert.rejects(
    () => confirmStatementExecution({
      database: writableMysqlTarget,
      input: {
        databaseKey: "mysql-write",
        sql: "update users set enabled = ? where id = ?",
        params: [0, 1]
      },
      supportsInteractiveConfirmation: false
    }),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.code === "NOT_SUPPORTED" &&
      /requires interactive elicitation.*not executed/i.test(error.message)
  );
});

test("write confirmation fails closed when elicitation throws", async () => {
  await assert.rejects(
    () => confirmStatementExecution({
      database: writableMysqlTarget,
      input: {
        databaseKey: "mysql-write",
        sql: "delete from users where id = ?",
        params: [1]
      },
      supportsInteractiveConfirmation: true,
      elicitConfirmation: async () => {
        throw new Error("Host claimed elicitation support but failed");
      }
    }),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.code === "NOT_SUPPORTED" &&
      /elicitation failed.*not executed/i.test(error.message)
  );
});

test("interactive confirmation reports an explicit user rejection", async () => {
  await assert.rejects(
    () => confirmStatementExecution({
      database: writableMysqlTarget,
      input: {
        databaseKey: "mysql-write",
        sql: "delete from users where id = ?",
        params: [1]
      },
      supportsInteractiveConfirmation: true,
      elicitConfirmation: async (message) => {
        assert.match(message, /Risk Level: NORMAL/);
        assert.match(message, /SQL to execute:\ndelete from users where id = \?/);
        return "no";
      }
    }),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.code === "USER_DECLINED" &&
      /user explicitly rejected.*not executed/i.test(error.message)
  );
});

test("interactive confirmation returns the current target fingerprint after yes", async () => {
  const result = await confirmStatementExecution({
    database: writableMysqlTarget,
    input: {
      databaseKey: "mysql-write",
      sql: "update users set enabled = ? where id = ?",
      params: [0, 1]
    },
    supportsInteractiveConfirmation: true,
    elicitConfirmation: async () => "yes"
  });

  assert.deepEqual(result, {
    status: "confirmed",
    databaseFingerprint: fingerprintDatabaseTarget(writableMysqlTarget)
  });
});
