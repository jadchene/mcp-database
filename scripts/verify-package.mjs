import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const result = spawnSync("npm", [
  "pack",
  "--dry-run",
  "--json",
  "--cache",
  path.join(os.tmpdir(), "mcp-database-npm-cache")
], {
  encoding: "utf8",
  shell: process.platform === "win32"
});

if (result.status !== 0) {
  process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}

const packages = JSON.parse(result.stdout);
const paths = new Set(packages[0]?.files?.map((file) => file.path) ?? []);
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
