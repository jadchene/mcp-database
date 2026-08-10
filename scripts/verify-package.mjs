import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const npmCli = process.env.npm_execpath;
if (!npmCli) {
  throw new Error("npm CLI path is unavailable");
}

const result = spawnSync(process.execPath, [
  npmCli,
  "pack",
  "--dry-run",
  "--json",
  "--cache",
  path.join(os.tmpdir(), "mcp-database-npm-cache")
], {
  encoding: "utf8"
});

if (result.status !== 0) {
  process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}

const packOutput = JSON.parse(result.stdout);
const packageReport = Array.isArray(packOutput)
  ? packOutput[0]
  : Object.values(packOutput)[0];
const paths = new Set(packageReport?.files?.map((file) => file.path) ?? []);
const required = [
  "dist/index.js",
  "README.md",
  "README.zh-CN.md",
  "LICENSE",
  "config/databases.example.json",
  "skills/database-mcp/SKILL.md"
];
const missing = required.filter((path) => !paths.has(path));

if (missing.length > 0) {
  throw new Error(`npm package is missing required files: ${missing.join(", ")}`);
}

process.stdout.write(`Verified ${paths.size} package files.\n`);
