import test from "node:test";
import assert from "node:assert/strict";

import { scanScriptRisk } from "../db/scriptGuard.js";

test("script guard ignores keywords and semicolons inside strings and comments", () => {
  const result = scanScriptRisk(`
    SELECT '123 set @aaa=1; drop table users' AS text_value;
    -- update users set enabled = 1;
    /* alter table t add column c int; */
    SET @x := 1;
  `);

  assert.deepEqual(result.ddlKeywords, []);
  assert.deepEqual(result.highRiskKeywords, []);
  // 顶层只有两条真实语句（SELECT 与 SET），字符串与注释内的分号不计入。
  assert.equal(result.statementCount, 2);
});

test("script guard detects DDL and high-risk keywords outside strings", () => {
  const result = scanScriptRisk(`
    CREATE TABLE t (id int);
    ALTER TABLE t ADD COLUMN name varchar(20);
    GRANT SELECT ON db.* TO 'u'@'h';
    INSERT INTO t (id) VALUES (1);
  `);

  assert.deepEqual(result.ddlKeywords, ["CREATE", "ALTER"]);
  assert.deepEqual(result.highRiskKeywords, ["GRANT"]);
  assert.equal(result.statementCount, 4);
});

test("script guard reports an empty script as zero statements", () => {
  const result = scanScriptRisk("   ");
  assert.equal(result.statementCount, 0);
  assert.deepEqual(result.ddlKeywords, []);
});
