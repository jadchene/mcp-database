import test from "node:test";
import assert from "node:assert/strict";

import { ApplicationError } from "../core/errors.js";
import { assertReadonlySql, inspectSqlStatement } from "../db/readonlyGuard.js";

test("readonly guard allows simple select", () => {
  assert.doesNotThrow(() => {
    assertReadonlySql("select * from users");
  });
});

test("readonly guard blocks update", () => {
  assert.throws(
    () => {
      assertReadonlySql("update users set name = 'x'");
    },
    (error: unknown) => error instanceof ApplicationError && error.code === "READONLY_VIOLATION"
  );
});

test("readonly guard blocks multi statements", () => {
  assert.throws(
    () => {
      assertReadonlySql("select 1; delete from users");
    },
    (error: unknown) => error instanceof ApplicationError && error.code === "INVALID_ARGUMENT"
  );
});

for (const sql of [
  "EXPLAIN ANALYZE DELETE FROM users WHERE id = 1",
  "SELECT * INTO backup_users FROM users",
  "SELECT * FROM users FOR UPDATE",
  "SELECT 1 INTO OUTFILE '/tmp/leak'",
  "WITH changed AS (DELETE FROM users RETURNING *) SELECT * FROM changed"
]) {
  test(`readonly guard blocks side-effecting query: ${sql}`, () => {
    assert.throws(
      () => assertReadonlySql(sql),
      (error: unknown) => error instanceof ApplicationError && error.code === "READONLY_VIOLATION"
    );
  });
}

test("readonly guard ignores blocked words inside strings and comments", () => {
  assert.doesNotThrow(() => {
    assertReadonlySql("select 'delete from users' as example /* update users */");
  });
});

test("readonly guard supports PostgreSQL dollar-quoted strings", () => {
  assert.doesNotThrow(() => {
    assertReadonlySql("select $$delete from users$$ as example");
  });
});

test("readonly guard allows MySQL SHOW CREATE TABLE", () => {
  assert.doesNotThrow(() => assertReadonlySql("SHOW CREATE TABLE `users`"));
});

for (const sql of [
  "SELECT 1 /*!50000 INTO OUTFILE '/tmp/mcp-audit' */",
  "SELECT 1 /*!50000 INTO DUMPFILE '/tmp/mcp-audit' */",
  "SELECT * FROM users /*!50000 FOR UPDATE */",
  "SELECT 1 /*M! INTO OUTFILE '/tmp/mariadb-audit' */"
]) {
  test(`readonly guard blocks MySQL executable comments: ${sql}`, () => {
    assert.throws(
      () => assertReadonlySql(sql),
      (error: unknown) => error instanceof ApplicationError && error.code === "READONLY_VIOLATION"
    );
  });
}

test("readonly guard does not treat executable-comment text inside a string as executable", () => {
  assert.doesNotThrow(() => assertReadonlySql("SELECT '/*!50000 DELETE FROM users */' AS example"));
});

test("statement inspection marks update without where as high risk", () => {
  const result = inspectSqlStatement("update users set enabled = 0");

  assert.equal(result.firstKeyword, "UPDATE");
  assert.equal(result.hasWhereClause, false);
  assert.equal(result.riskLevel, "high");
  assert.match(result.riskReasons.join(" "), /without WHERE/i);
});

test("statement inspection marks delete with where as normal risk", () => {
  const result = inspectSqlStatement("delete from users where id = 1");

  assert.equal(result.firstKeyword, "DELETE");
  assert.equal(result.hasWhereClause, true);
  assert.equal(result.riskLevel, "normal");
  assert.deepEqual(result.riskReasons, []);
});

test("statement inspection marks truncate as critical risk", () => {
  const result = inspectSqlStatement("truncate table users");

  assert.equal(result.firstKeyword, "TRUNCATE");
  assert.equal(result.riskLevel, "critical");
  assert.match(result.riskReasons.join(" "), /removes all rows/i);
});
