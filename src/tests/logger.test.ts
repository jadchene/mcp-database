import test from "node:test";
import assert from "node:assert/strict";

import { log } from "../core/logger.js";

test("structured logs redact SQL text, parameters, and secrets", () => {
  const original = console.error;
  const lines: string[] = [];
  console.error = (value?: unknown) => lines.push(String(value));
  try {
    log("info", "test", {
      sql: "select * from users where password = ?",
      params: ["super-secret-value"],
      password: "database-password"
    });
  } finally {
    console.error = original;
  }

  const output = lines.join("\n");
  assert.doesNotMatch(output, /select \*/i);
  assert.doesNotMatch(output, /super-secret-value/);
  assert.doesNotMatch(output, /database-password/);
  assert.match(output, /fingerprint/);
  assert.match(output, /REDACTED/);
});
