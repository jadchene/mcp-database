import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function main() {
  const tmpRoot = path.join(os.tmpdir(), "mcp-database-reload-");
  const tempDir = await mkdtemp(tmpRoot);
  const configPath = path.join(tempDir, "reload-config.json");
  const serverPath = path.resolve("dist/index.js");

  const initialConfig = {
    logging: {
      enabled: true
    },
    query: {
      timeoutMs: 3000
    },
    databases: [
      {
        key: "mysql-alpha",
        type: "mysql",
        readonly: true,
        connection: {
          host: "127.0.0.1",
          port: 3306,
          databaseName: "alpha_db",
          user: "root",
          password: "secret"
        }
      }
    ]
  };

  const watchedConfig = {
    logging: {
      enabled: true,
      directory: "./logs"
    },
    query: {
      timeoutMs: 4500
    },
    databases: [
      ...initialConfig.databases,
      {
        key: "redis-beta",
        type: "redis",
        readonly: true,
        connection: {
          url: "redis://default:secret@127.0.0.1:6379/0"
        }
      }
    ]
  };

  const manualReloadConfig = {
    logging: {
      enabled: false
    },
    query: {
      timeoutMs: 2000
    },
    databases: [
      {
        key: "oracle-gamma",
        type: "oracle",
        readonly: true,
        connection: {
          host: "127.0.0.1",
          port: 1521,
          serviceName: "XEPDB1",
          user: "system",
          password: "secret",
          clientMode: "thin"
        }
      }
    ]
  };

  await mkdir(tempDir, { recursive: true });
  await writeJson(configPath, initialConfig);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath, "--config", configPath],
    cwd: process.cwd(),
    stderr: "pipe"
  });

  const stderrChunks = [];
  transport.stderr?.on("data", (chunk) => {
    stderrChunks.push(String(chunk));
  });

  const client = new Client(
    { name: "reload-verifier", version: "1.0.0" },
    { capabilities: {} }
  );

  try {
    await client.connect(transport);

    const initialSummary = await callJsonTool(client, "show_loaded_config", {});
    assert.equal(initialSummary.databaseCount, 1);
    assert.equal(initialSummary.logging?.enabled, true);
    assert.equal(initialSummary.query?.timeoutMs, 3000);
    assert.equal(initialSummary.items[0]?.key, "mysql-alpha");
    assert.equal(initialSummary.items[0]?.connection?.databaseName, "alpha_db");

    await writeJson(configPath, watchedConfig);
    const watchedSummary = await waitForConfig(client, (summary) => summary.databaseCount === 2);
    assert.equal(watchedSummary.logging?.enabled, true);
    assert.match(String(watchedSummary.logging?.directory), /logs/i);
    assert.equal(watchedSummary.query?.timeoutMs, 4500);
    assert.equal(watchedSummary.items[1]?.key, "redis-beta");
    assert.match(String(watchedSummary.items[1]?.connection?.url), /\*\*\*/);

    await writeFile(configPath, '{"broken": true', "utf8");
    await delay(1800);
    const afterInvalidSummary = await callJsonTool(client, "show_loaded_config", {});
    assert.equal(afterInvalidSummary.databaseCount, 2);
    assert.equal(afterInvalidSummary.items[1]?.key, "redis-beta");

    await writeJson(configPath, manualReloadConfig);
    const manualSummary = await callJsonTool(client, "reload_config", {});
    assert.equal(manualSummary.databaseCount, 1);
    assert.equal(manualSummary.logging?.enabled, false);
    assert.equal(manualSummary.query?.timeoutMs, 2000);
    assert.equal(manualSummary.items[0]?.key, "oracle-gamma");
    assert.equal(manualSummary.items[0]?.connection?.serviceName, "XEPDB1");
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }

  const stderrText = stderrChunks.join("");
  const output = {
    ok: true,
    checked: [
      "show_loaded_config initial snapshot",
      "automatic config reload after valid file change",
      "logging summary in show_loaded_config",
      "query timeout summary in show_loaded_config",
      "sanitized connection summary in show_loaded_config",
      "invalid auto-reload keeps previous in-memory config",
      "manual reload_config replaces in-memory config"
    ],
    stderrLogLines: stderrText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 20)
  };

  console.log(JSON.stringify(output, null, 2));
}

async function callJsonTool(client, name, args) {
  const result = await client.callTool({
    name,
    arguments: args
  });

  const textPart = result.content.find((item) => item.type === "text");
  if (!textPart || typeof textPart.text !== "string") {
    throw new Error(`Tool ${name} did not return text content`);
  }

  return JSON.parse(textPart.text);
}

async function waitForConfig(client, predicate, timeoutMs = 6000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const summary = await callJsonTool(client, "show_loaded_config", {});
    if (predicate(summary)) {
      return summary;
    }

    await delay(250);
  }

  throw new Error("Timed out waiting for config reload");
}

async function writeJson(filePath, value) {
  await writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch(async (error) => {
  const diagnostic = {
    ok: false,
    error: error instanceof Error ? error.message : String(error)
  };

  console.error(JSON.stringify(diagnostic, null, 2));
  process.exitCode = 1;
});
