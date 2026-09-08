import test from "node:test";
import assert from "node:assert/strict";

import { fingerprintDatabaseTarget } from "../config/databaseFingerprint.js";
import { ApplicationError } from "../core/errors.js";
import { confirmScriptExecution, confirmStatementExecution } from "../server/createServer.js";

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

const writableOracleTarget = {
  key: "oracle-write",
  type: "oracle" as const,
  readonly: false,
  connection: {
    host: "127.0.0.1",
    serviceName: "ORCLPDB1",
    user: "app",
    password: "secret"
  }
};

const redisTarget = {
  key: "redis-main",
  type: "redis" as const,
  readonly: false,
  connection: {
    url: "redis://default:secret@127.0.0.1:6379/0"
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

test("script confirmation fails closed when elicitation is unavailable", async () => {
  await assert.rejects(
    () => confirmScriptExecution({
      database: writableMysqlTarget,
      input: {
        databaseKey: "mysql-write",
        sourceKind: "inline",
        sourceLabel: "inline SQL",
        scriptLength: 12,
        statementCount: 2,
        ddlKeywords: [],
        highRiskKeywords: []
      },
      supportsInteractiveConfirmation: false
    }),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.code === "NOT_SUPPORTED" &&
      /requires interactive elicitation.*not executed/i.test(error.message)
  );
});

test("script confirmation shows DDL warning and reports explicit rejection", async () => {
  await assert.rejects(
    () => confirmScriptExecution({
      database: writableMysqlTarget,
      input: {
        databaseKey: "mysql-write",
        sourceKind: "inline",
        sourceLabel: "inline SQL",
        scriptLength: 30,
        statementCount: 3,
        ddlKeywords: ["CREATE", "ALTER"],
        highRiskKeywords: []
      },
      supportsInteractiveConfirmation: true,
      elicitConfirmation: async (message) => {
        assert.match(message, /WARNING: this script contains DDL \(CREATE, ALTER\)/);
        assert.match(message, /inline SQL string \(30 chars\)/);
        return "no";
      }
    }),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.code === "USER_DECLINED" &&
      /user explicitly rejected this SQL script.*not executed/i.test(error.message)
  );
});

test("script confirmation returns the current target fingerprint after yes", async () => {
  const result = await confirmScriptExecution({
    database: writableMysqlTarget,
    input: {
      databaseKey: "mysql-write",
      sourceKind: "file",
      sourceLabel: "/tmp/migrate.sql",
      scriptLength: 50,
      statementCount: 5,
      ddlKeywords: [],
      highRiskKeywords: []
    },
    supportsInteractiveConfirmation: true,
    elicitConfirmation: async () => "yes"
  });

  assert.deepEqual(result, {
    status: "confirmed",
    databaseFingerprint: fingerprintDatabaseTarget(writableMysqlTarget)
  });
});

test("script confirmation accepts a non-MySQL SQL target (engine support is adapter-specific)", async () => {
  const result = await confirmScriptExecution({
    database: writableOracleTarget,
    input: {
      databaseKey: "oracle-write",
      sourceKind: "inline",
      sourceLabel: "inline SQL",
      scriptLength: 20,
      statementCount: 2,
      ddlKeywords: [],
      highRiskKeywords: []
    },
    supportsInteractiveConfirmation: true,
    elicitConfirmation: async () => "yes"
  });

  assert.deepEqual(result, {
    status: "confirmed",
    databaseFingerprint: fingerprintDatabaseTarget(writableOracleTarget)
  });
});

test("script confirmation rejects Redis targets", async () => {
  await assert.rejects(
    () => confirmScriptExecution({
      database: redisTarget,
      input: {
        databaseKey: "redis-main",
        sourceKind: "inline",
        sourceLabel: "inline SQL",
        scriptLength: 10,
        statementCount: 1,
        ddlKeywords: [],
        highRiskKeywords: []
      },
      supportsInteractiveConfirmation: true,
      elicitConfirmation: async () => "yes"
    }),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.code === "NOT_SUPPORTED" &&
      /Redis does not support SQL script execution/.test(error.message)
  );
});
