#!/usr/bin/env node

import { loadConfig } from "./config/loadConfig.js";
import { readHiddenLine } from "./core/hiddenInput.js";
import { log } from "./core/logger.js";
import { generateUserAuthorization } from "./core/userAuthorization.js";
import { createServer } from "./server/createServer.js";
import { SERVICE_NAME, SERVICE_VERSION } from "./version.js";

function shouldPrintVersion(argv: string[]): boolean {
  return argv.includes("-v") || argv.includes("--version");
}

function printVersion(): void {
  process.stdout.write(`${SERVICE_NAME} ${SERVICE_VERSION}\n`);
}

async function handlePrivateAuthorizationRequest(argv: string[]): Promise<boolean> {
  if (argv[0] !== "gen") {
    return false;
  }

  if (argv.length !== 2 || !argv[1]) {
    throw new Error("Invalid authorization request");
  }

  const password = await readHiddenLine("Password: ");
  if (!password) {
    throw new Error("Authorization password is required");
  }
  const token = await generateUserAuthorization(argv[1], password);
  process.stdout.write(`${token}\n`);
  return true;
}

/**
 * Main entrypoint: load validated config, start the MCP server, and leave all
 * actual database work to per-request lazy adapters.
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (await handlePrivateAuthorizationRequest(argv)) {
    return;
  }

  if (shouldPrintVersion(argv)) {
    printVersion();
    return;
  }

  const config = await loadConfig(argv, process.env);
  await createServer(config);
  log("info", "MCP database server started", {
    databaseCount: config.databases.length
  });
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  log("error", "Failed to start MCP database server", { message });
  process.exitCode = 1;
});
