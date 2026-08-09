import test from "node:test";
import assert from "node:assert/strict";

import type { MysqlDatabaseConfig, PostgresDatabaseConfig } from "../config/configTypes.js";
import { MysqlAdapter } from "../db/sql/mysqlClient.js";
import { PostgresAdapter } from "../db/sql/postgresClient.js";

const mysqlHost = process.env.TEST_MYSQL_HOST;
const postgresHost = process.env.TEST_POSTGRES_HOST;

test("MySQL adapter enforces read transactions and driver-side row limits", {
  skip: !mysqlHost,
  timeout: 20_000
}, async () => {
  const config: MysqlDatabaseConfig = {
    key: "mysql-integration",
    type: "mysql",
    readonly: false,
    connection: {
      host: mysqlHost!,
      port: Number(process.env.TEST_MYSQL_PORT ?? 3306),
      databaseName: process.env.TEST_MYSQL_DATABASE ?? "mcp_test",
      user: process.env.TEST_MYSQL_USER ?? "mcp",
      password: process.env.TEST_MYSQL_PASSWORD ?? "mcp-test-password",
      connectTimeoutMs: 5_000
    }
  };
  const adapter = new MysqlAdapter(config, 5_000);

  await adapter.connect();
  try {
    const result = await adapter.executeQuery(
      "SELECT 1 AS id UNION ALL SELECT 2 AS id UNION ALL SELECT 3 AS id",
      [],
      2
    );
    assert.equal(result.rowCount, 2);
    assert.equal(result.truncated, true);
    assert.deepEqual(result.rows.map((row) => row.id), [1, 2]);
  } finally {
    await adapter.close();
  }
});

test("PostgreSQL adapter enforces read transactions and cursor row limits", {
  skip: !postgresHost,
  timeout: 20_000
}, async () => {
  const config: PostgresDatabaseConfig = {
    key: "postgres-integration",
    type: "postgresql",
    readonly: false,
    connection: {
      host: postgresHost!,
      port: Number(process.env.TEST_POSTGRES_PORT ?? 5432),
      databaseName: process.env.TEST_POSTGRES_DATABASE ?? "mcp_test",
      user: process.env.TEST_POSTGRES_USER ?? "mcp",
      password: process.env.TEST_POSTGRES_PASSWORD ?? "mcp-test-password",
      connectTimeoutMs: 5_000
    }
  };
  const adapter = new PostgresAdapter(config, 5_000);

  await adapter.connect();
  try {
    const result = await adapter.executeQuery("SELECT generate_series(1, 3) AS id", [], 2);
    assert.equal(result.rowCount, 2);
    assert.equal(result.truncated, true);
    assert.deepEqual(result.rows.map((row) => row.id), [1, 2]);
  } finally {
    await adapter.close();
  }
});
