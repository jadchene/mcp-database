import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ApplicationError } from "../core/errors.js";
import {
  consumeUserAuthorization,
  generateUserAuthorization,
  prepareUserAuthorization
} from "../core/userAuthorization.js";

const confirmationId = "123e4567-e89b-42d3-a456-426614174000";

test("a password-protected user authorization is short-lived and single-use", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mcp-database-auth-"));
  const now = 1_000_000;
  try {
    await prepareUserAuthorization(confirmationId, "correct-password", now + 60_000, {
      directory,
      now: () => now
    });

    await assert.rejects(
      () => generateUserAuthorization(confirmationId, "wrong-password", { directory, now: () => now }),
      (error: unknown) =>
        error instanceof ApplicationError && /password is incorrect/i.test(error.message)
    );

    const token = await generateUserAuthorization(confirmationId, "correct-password", {
      directory,
      now: () => now
    });
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);

    const challengeText = await readFile(path.join(directory, `${confirmationId}.challenge.json`), "utf8");
    assert.equal(challengeText.includes("correct-password"), false);
    assert.equal(await consumeUserAuthorization(confirmationId, "x".repeat(43), { directory, now: () => now }), false);
    assert.equal(await consumeUserAuthorization(confirmationId, token, { directory, now: () => now }), true);
    assert.equal(await consumeUserAuthorization(confirmationId, token, { directory, now: () => now }), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an expired challenge cannot generate a user authorization", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mcp-database-auth-expired-"));
  try {
    await prepareUserAuthorization(confirmationId, "correct-password", 2_000, {
      directory,
      now: () => 1_000
    });

    await assert.rejects(
      () => generateUserAuthorization(confirmationId, "correct-password", {
        directory,
        now: () => 2_001
      }),
      (error: unknown) =>
        error instanceof ApplicationError && /unknown or expired/i.test(error.message)
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
