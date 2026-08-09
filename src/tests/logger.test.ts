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

test("structured logs preserve event names and summarize driver error messages", () => {
  const original = console.error;
  const lines: string[] = [];
  console.error = (value?: unknown) => lines.push(String(value));
  try {
    log("error", "Tool execution failed", {
      message: "must-not-overwrite-event",
      errorMessage: "syntax error near 'super-secret-value'",
      details: { error: "another-secret-value" }
    });
  } finally {
    console.error = original;
  }

  const output = lines.join("\n");
  const payload = JSON.parse(output) as Record<string, unknown>;
  assert.equal(payload.message, "Tool execution failed");
  assert.doesNotMatch(output, /must-not-overwrite-event/);
  assert.doesNotMatch(output, /super-secret-value/);
  assert.doesNotMatch(output, /another-secret-value/);
  assert.match(output, /fingerprint/);
});
