import test from "node:test";
import assert from "node:assert/strict";

import { normalizeDatabaseBoolean } from "../utils/normalize.js";

test("database boolean normalization handles supported dialect values", () => {
  for (const value of [true, 1, "1", "Y", "YES", "TRUE"]) {
    assert.equal(normalizeDatabaseBoolean(value), true);
  }
  for (const value of [false, 0, "0", "N", "NO", "FALSE"]) {
    assert.equal(normalizeDatabaseBoolean(value, true), false);
  }
});

test("database boolean normalization uses the requested default", () => {
  assert.equal(normalizeDatabaseBoolean(undefined, true), true);
  assert.equal(normalizeDatabaseBoolean("unknown", false), false);
});
