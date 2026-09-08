import test from "node:test";
import assert from "node:assert/strict";

import { ApplicationError } from "../core/errors.js";
import { buildToolRegistry } from "../server/toolRegistry.js";

function propertiesFor(toolName: string): Record<string, Record<string, unknown>> {
  const tool = buildToolRegistry().find((item) => item.name === toolName);
  assert.ok(tool, `Missing tool: ${toolName}`);
  return tool.inputSchema.properties as Record<string, Record<string, unknown>>;
}

test("execute_statement does not expose removed fallback confirmation fields", () => {
  assert.equal(propertiesFor("execute_statement").confirmExecution, undefined);
  assert.equal(propertiesFor("execute_statement").confirmationId, undefined);
});

test("query and scan schemas expose integer bounds", () => {
  const maxRows = propertiesFor("execute_query").maxRows;
  assert.deepEqual(
    { type: maxRows?.type, minimum: maxRows?.minimum, maximum: maxRows?.maximum },
    { type: "integer", minimum: 1, maximum: 1000 }
  );

  const count = propertiesFor("redis_scan").count;
  assert.deepEqual(
    { type: count?.type, minimum: count?.minimum, maximum: count?.maximum },
    { type: "integer", minimum: 1, maximum: 1000 }
  );
});

test("metadata schemas expose bounded row limits", () => {
  for (const toolName of ["list_schemas", "list_tables", "describe_table", "list_indexes"]) {
    const maxRows = propertiesFor(toolName).maxRows;
    assert.deepEqual(
      { type: maxRows?.type, minimum: maxRows?.minimum, maximum: maxRows?.maximum },
      { type: "integer", minimum: 1, maximum: 1000 },
      toolName
    );
  }
});

test("execute_script exposes sql and sqlFile but no redundant confirmation fields", () => {
  const props = propertiesFor("execute_script");
  assert.equal(typeof props.sql, "object");
  assert.equal(typeof props.sqlFile, "object");
  assert.equal(typeof props.useTransaction, "object");
  assert.equal(props.confirmExecution, undefined);
});

test("execute_script requires exactly one of sql or sqlFile", async () => {
  const tool = buildToolRegistry().find((item) => item.name === "execute_script");
  assert.ok(tool, "Missing tool: execute_script");

  const schema = tool.inputSchema;
  const required = schema.required as string[] | undefined;
  assert.ok(required?.includes("databaseKey"));

  // 通过 run 校验 superRefine 的二选一约束：两者都缺或都填都会失败。
  // makeTool 在 safeParse 失败时抛出通用 INVALID_ARGUMENT，details.issues 里含具体提示。
  await assert.rejects(
    () => tool.run({ databaseKey: "mysql-write" }, fakeContext()),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.code === "INVALID_ARGUMENT" &&
      /exactly one of sql or sqlfile/i.test(JSON.stringify(error.details?.issues ?? []))
  );
  await assert.rejects(
    () => tool.run({ databaseKey: "mysql-write", sql: "select 1", sqlFile: "x.sql" }, fakeContext()),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.code === "INVALID_ARGUMENT" &&
      /exactly one of sql or sqlfile/i.test(JSON.stringify(error.details?.issues ?? []))
  );
});

function fakeContext(): any {
  return {
    getConfig: () => ({
      configPath: "/tmp/config.json",
      loadedAt: new Date().toISOString(),
      databases: [],
      databaseMap: new Map(),
      logging: { enabled: false, directory: "/tmp" },
      query: { timeoutMs: null }
    }),
    reloadConfig: async () => fakeContext().getConfig(),
    useSqlDatabase: async () => {
      throw new Error("unexpected database call");
    },
    useRedisDatabase: async () => {
      throw new Error("unexpected redis call");
    },
    confirmStatementExecution: async () => ({ status: "confirmed", databaseFingerprint: "" }),
    confirmScriptExecution: async () => ({ status: "confirmed", databaseFingerprint: "" })
  };
}
