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
