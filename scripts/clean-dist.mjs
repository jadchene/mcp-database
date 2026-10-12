import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 编译前只清理本项目的生成目录，避免已删除适配器遗留在发布包。
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(projectRoot, "dist");
if (dirname(output) !== projectRoot || output !== resolve(projectRoot, "dist")) {
  throw new Error("Refusing to clean outside project dist directory");
}
await rm(output, { recursive: true, force: true });
