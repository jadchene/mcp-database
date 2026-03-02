#!/usr/bin/env node

import { loadConfig } from "./config/loadConfig.js";
import { log } from "./core/logger.js";
import { createServer } from "./server/createServer.js";

/**
 * Main entrypoint: load validated config, start the MCP server, and leave all
 * actual database work to per-request lazy adapters.
 */
async function main(): Promise<void> {
  const config = await loadConfig(process.argv.slice(2), process.env);
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
