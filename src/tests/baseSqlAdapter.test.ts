import test from "node:test";
import assert from "node:assert/strict";

import type { MysqlDatabaseConfig } from "../config/configTypes.js";
import { BaseSqlAdapter } from "../db/sql/baseSqlAdapter.js";

const config: MysqlDatabaseConfig = {
  key: "writable",
  type: "mysql",
  readonly: false,
  connection: {
    host: "127.0.0.1",
    databaseName: "test",
    user: "test",
    password: "test"
  }
};

test("executeQuery uses a read-only transaction and adapter-side row limiting", async () => {
  const adapter = new FakeSqlAdapter(config);
  const result = await adapter.executeQuery("select * from users", [], 2);

  assert.deepEqual(adapter.events, ["begin-readonly", "limited-query:2", "rollback"]);
  assert.equal(result.rowCount, 2);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.rows, [{ id: 1 }, { id: 2 }]);
});

test("write timeout cancels the operation and reports an unknown outcome", async () => {
  const adapter = new FakeSqlAdapter(config, 5, 50);

  await assert.rejects(
    () => adapter.executeStatement("update users set enabled = 0 where id = 1"),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "EXECUTION_OUTCOME_UNKNOWN"
  );
  assert.ok(adapter.events.includes("cancel"));
});

class FakeSqlAdapter extends BaseSqlAdapter {
  public readonly events: string[] = [];

  public constructor(
    configValue: MysqlDatabaseConfig,
    timeoutMs: number | null = null,
    private readonly statementDelayMs = 0
  ) {
    super(configValue, timeoutMs);
  }

  public async connect(): Promise<void> {}
  public async close(): Promise<void> {}

  protected async executeRaw(): Promise<Record<string, unknown>[]> { return []; }
  protected async executeStatementRaw(): Promise<{ affectedRows: number | null }> {
    if (this.statementDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.statementDelayMs));
    }
    return { affectedRows: 0 };
  }
  protected async executeLimitedQueryRaw(
    _sql: string,
    _params: unknown[] | undefined,
    maxRows: number
  ): Promise<{ rows: Record<string, unknown>[]; truncated: boolean }> {
    this.events.push(`limited-query:${maxRows}`);
    return { rows: [{ id: 1 }, { id: 2 }], truncated: true };
  }
  protected async beginReadonlyTransaction(): Promise<void> { this.events.push("begin-readonly"); }
  protected async rollbackReadonlyTransaction(): Promise<void> { this.events.push("rollback"); }
  protected async cancelCurrentOperation(): Promise<void> { this.events.push("cancel"); }
  protected async explainQueryRows(): Promise<{ rows: Record<string, unknown>[]; truncated: boolean }> {
    return { rows: [], truncated: false };
  }
  protected async analyzeQueryRows(): Promise<{ rows: Record<string, unknown>[]; truncated: boolean }> {
    return { rows: [], truncated: false };
  }
  protected pingSql(): string { return "select 1"; }
  protected listSchemasSql(): string { return "select 1"; }
  protected listTablesSql(): { sql: string } { return { sql: "select 1" }; }
  protected describeTableSql(): { sql: string } { return { sql: "select 1" }; }
  protected listIndexesSql(): { sql: string } { return { sql: "select 1" }; }
  protected tableStatisticsSql(): { sql: string } { return { sql: "select 1" }; }
}
