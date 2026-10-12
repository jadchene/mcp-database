#!/usr/bin/env node

import { loadConfig } from "./config/loadConfig.js";
import { log } from "./core/logger.js";
import { createServer } from "./server/createServer.js";
import { SERVICE_NAME, SERVICE_VERSION } from "./version.js";

function shouldPrintVersion(argv: string[]): boolean {
  return argv.includes("-v") || argv.includes("--version");
}

function printVersion(): void {
  process.stdout.write(`${SERVICE_NAME} ${SERVICE_VERSION}\n`);
}

/**
 * 加载配置并启动显式会话服务，仅 connect 工具建立数据库连接。
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (shouldPrintVersion(argv)) {
    printVersion();
    return;
  }

  const config = await loadConfig(argv, process.env);
  await createServer(config);
  log("info", "MCP database server started", {
    databaseCount: config.databases.filter(database => database.enable !== false).length
  });
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  log("error", "Failed to start MCP database server", { message });
  process.exitCode = 1;
});
