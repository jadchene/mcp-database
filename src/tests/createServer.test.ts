import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, unwatchFile } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ElicitRequestSchema, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";

import { fingerprintDatabaseTarget } from "../config/databaseFingerprint.js";
import { ApplicationError } from "../core/errors.js";
import { MysqlAdapter } from "../db/sql/mysqlClient.js";
import { createServer, confirmScriptExecution, confirmStatementExecution } from "../server/createServer.js";

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

for (const clientName of ["confirmation-test", "codex-mcp-client"]) {
  test(`MCP SQL confirmation executes only on accept for ${clientName}`, async (t) => {
    const configPath = path.resolve("config/databases.example.json");
    const exitListeners = process.listeners("exit");
    const signals = ["SIGINT", "SIGTERM"] as const;
    const listeners = new Map(signals.map(signal => [signal, process.listeners(signal)]));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const connect = Server.prototype.connect;
    t.mock.method(Server.prototype, "connect", function (this: Server) {
      return connect.call(this, serverTransport);
    });
    const databaseConnect = t.mock.method(MysqlAdapter.prototype, "connect", async () => undefined);
    t.mock.method(MysqlAdapter.prototype, "close", async () => undefined);
    const statement = t.mock.method(MysqlAdapter.prototype, "executeStatement", async () => ({
      command: "UPDATE", affectedRows: 1
    }));
    const script = t.mock.method(MysqlAdapter.prototype, "executeScript", async () => ({
      command: "SCRIPT", statementCount: 1, statements: [], totalAffectedRows: 1,
      transaction: { enabled: false, outcome: "not_applied" as const }
    }));
    const server = await createServer({
      configPath, loadedAt: new Date().toISOString(),
      databases: [writableMysqlTarget], databaseMap: new Map([[writableMysqlTarget.key, writableMysqlTarget]]),
      logging: { enabled: false, directory: process.cwd() }, query: { timeoutMs: null }
    });
    const client = new Client({ name: clientName, version: "1.0.0" }, {
      capabilities: { elicitation: { form: {} } }
    });
    t.after(async () => {
      await client.close();
      await server.close();
      unwatchFile(configPath);
      for (const listener of process.listeners("exit")) {
        if (!exitListeners.includes(listener)) process.removeListener("exit", listener);
      }
      for (const signal of signals) {
        for (const listener of process.listeners(signal)) {
          if (!listeners.get(signal)?.includes(listener)) process.removeListener(signal, listener);
        }
      }
    });
    let response: ElicitResult = { action: "accept", content: {} };
    let failConfirmation = false;
    let confirmationCalls = 0;
    let expectedToolName = "";
    let expectedArguments: Record<string, unknown> = {};
    let expectedSql = "";
    let expectedSensitive = false;
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      confirmationCalls += 1;
      assert.equal(request.params.mode, "form");
      assert.ok("requestedSchema" in request.params);
      assert.deepEqual(request.params.requestedSchema.properties, {});
      assert.equal(request.params.requestedSchema.required, undefined);
      assert.match(request.params.message, /Database Key: mysql-write/);
      assert.ok(request.params.message.includes(expectedSql));
      assert.match(request.params.message, /Accept to execute.*decline or cancel/);
      if (clientName === "codex-mcp-client") {
        assert.deepEqual(request.params._meta, {
          codex_request_type: "approval_request", codex_approval_kind: "mcp_tool_call",
          codex_strict_auto_review: true, tool_name: expectedToolName,
          ...(expectedSensitive ? { codex_sensitive_action: true } : {}),
          tool_description: request.params.message,
          tool_params: {
            ...expectedArguments,
            ...(expectedToolName === "execute_script" ? { resolvedSql: expectedSql } : {})
          }
        });
      } else {
        assert.equal(request.params._meta, undefined);
      }
      if (failConfirmation) throw new Error("Confirmation unavailable");
      return response;
    });
    await client.connect(clientTransport);
    const responses: ElicitResult[] = [
      { action: "accept", content: {} }, { action: "accept" }, { action: "decline" }, { action: "cancel" }
    ];
    for (const name of ["execute_statement", "execute_script"]) {
      expectedToolName = name;
      const sql = "update users set enabled = 0 where id = 1";
      expectedSql = sql;
      expectedArguments = { databaseKey: "mysql-write", sql };
      const execution = name === "execute_statement" ? statement : script;
      for (response of responses) {
        const before = execution.mock.calls.length;
        const connectionsBefore = databaseConnect.mock.calls.length;
        const result = await client.callTool({ name, arguments: { databaseKey: "mysql-write", sql } });
        const accepted = response.action === "accept";
        assert.equal(result.isError === true, !accepted);
        assert.equal(execution.mock.calls.length - before, accepted ? 1 : 0);
        assert.equal(databaseConnect.mock.calls.length - connectionsBefore, accepted ? 1 : 0);
        if (accepted) assert.equal(execution.mock.calls.at(-1)?.arguments[0], sql);
      }
      failConfirmation = true;
      const result = await client.callTool({ name, arguments: { databaseKey: "mysql-write", sql } });
      assert.equal(result.isError, true);
      assert.equal(execution.mock.calls.length, 2);
      failConfirmation = false;
    }
    expectedSql = "DROP TABLE auto_review_test";
    expectedArguments = { databaseKey: "mysql-write", sql: expectedSql };
    expectedToolName = "execute_statement";
    expectedSensitive = true;
    const highRiskResponses: ElicitResult[] = [
      { action: "decline" }, { action: "cancel" }, { action: "accept", content: {} }
    ];
    for (response of highRiskResponses) {
      const executionsBefore = statement.mock.calls.length;
      const connectionsBefore = databaseConnect.mock.calls.length;
      const result = await client.callTool({ name: expectedToolName, arguments: expectedArguments });
      const accepted = response.action === "accept";
      assert.equal(result.isError === true, !accepted);
      assert.equal(statement.mock.calls.length - executionsBefore, accepted ? 1 : 0);
      assert.equal(databaseConnect.mock.calls.length - connectionsBefore, accepted ? 1 : 0);
    }
    const sqlFile = path.resolve("src/tests/fixtures/approval.sql");
    expectedSql = readFileSync(sqlFile, "utf8");
    expectedArguments = { databaseKey: "mysql-write", sqlFile, useTransaction: true };
    expectedToolName = "execute_script";
    expectedSensitive = true;
    response = { action: "accept", content: {} };
    const fileResult = await client.callTool({ name: "execute_script", arguments: expectedArguments });
    assert.notEqual(fileResult.isError, true);
    assert.equal(script.mock.calls.at(-1)?.arguments[0], expectedSql);
    assert.deepEqual(script.mock.calls.at(-1)?.arguments[1], { useTransaction: true });
    assert.equal(confirmationCalls, 14);
    assert.equal(databaseConnect.mock.calls.length, 6);
  });
}

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
        sql: "update users set enabled = 0 where id = 1;",
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
        sql: "create table demo (id int); alter table demo add name varchar(20);",
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
      sql: "update users set enabled = 0 where id = 1;",
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
      sql: "update users set enabled = 0 where id = 1;",
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
        sql: "update users set enabled = 0 where id = 1;",
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
