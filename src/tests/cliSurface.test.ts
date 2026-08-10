import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { consumeUserAuthorization, prepareUserAuthorization } from "../core/userAuthorization.js";

const cliPath = fileURLToPath(new URL("../index.js", import.meta.url));

test("CLI help output does not reveal the private authorization command", () => {
  const result = spawnSync(process.execPath, [cliPath, "--help"], {
    encoding: "utf8",
    env: {
      ...process.env,
      MCP_DATABASE_CONFIG: ""
    }
  });
  const output = `${result.stdout}${result.stderr}`;

  assert.notEqual(result.status, 0);
  assert.equal(output.includes("mcp-database-service gen"), false);
  assert.equal(/\bgen\s+<.*confirmation/i.test(output), false);
});

test("private authorization command rejects a password supplied as an argument", () => {
  const password = "must-not-appear-in-output";
  const result = spawnSync(
    process.execPath,
    [cliPath, "gen", "123e4567-e89b-42d3-a456-426614174000", password],
    {
      encoding: "utf8"
    }
  );
  const output = `${result.stdout}${result.stderr}`;

  assert.notEqual(result.status, 0);
  assert.equal(output.includes(password), false);
  assert.equal(output.includes("Password:"), false);
});

test("private authorization command reads the password from hidden stdin and prints only the token", async () => {
  const homeDirectory = await mkdtemp(path.join(os.tmpdir(), "mcp-database-cli-home-"));
  const authorizationDirectory = path.join(homeDirectory, ".mcp-database-service", "authorizations");
  const confirmationId = "123e4567-e89b-42d3-a456-426614174010";
  const password = "private-confirmation-password";
  try {
    await prepareUserAuthorization(confirmationId, password, Date.now() + 60_000, {
      directory: authorizationDirectory
    });

    const result = spawnSync(process.execPath, [cliPath, "gen", confirmationId], {
      encoding: "utf8",
      input: `${password}\n`,
      env: {
        ...process.env,
        HOME: homeDirectory,
        USERPROFILE: homeDirectory
      }
    });
    const token = result.stdout.trim();

    assert.equal(result.status, 0);
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(result.stderr, "Password: \n");
    assert.equal(`${result.stdout}${result.stderr}`.includes(password), false);
    assert.equal(
      await consumeUserAuthorization(confirmationId, token, { directory: authorizationDirectory }),
      true
    );
  } finally {
    await rm(homeDirectory, { recursive: true, force: true });
  }
});
