import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("server exits cleanly after one SIGINT", { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mcp-database-shutdown-"));
  const configPath = path.join(directory, "databases.json");
  await writeFile(configPath, JSON.stringify({
    databases: [{
      key: "unused",
      type: "mysql",
      readonly: true,
      connection: {
        host: "127.0.0.1",
        databaseName: "unused",
        user: "unused",
        password: "unused"
      }
    }]
  }), "utf8");

  const child = spawn(process.execPath, [path.resolve("dist/index.js"), "--config", configPath], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"]
  });

  try {
    await waitForOutput(child.stderr, "MCP database server started", 5_000);
    const exitPromise = waitForExit(child, 3_000);
    assert.equal(child.kill("SIGINT"), true);
    const exit = await exitPromise;
    assert.equal(exit.signal, null);
    assert.equal(exit.code, 0);
  } finally {
    child.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
  }
});

async function waitForOutput(stream: NodeJS.ReadableStream, text: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for output: ${output}`)), timeoutMs);
    stream.on("data", (chunk) => {
      output += String(chunk);
      if (output.includes(text)) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

async function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for child process exit")), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}
