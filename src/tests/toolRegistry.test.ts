import test from "node:test";
import assert from "node:assert/strict";

import { buildToolRegistry } from "../server/toolRegistry.js";

function propertiesFor(toolName: string): Record<string, Record<string, unknown>> {
  const tool = buildToolRegistry().find((item) => item.name === toolName);
  assert.ok(tool, `Missing tool: ${toolName}`);
  return tool.inputSchema.properties as Record<string, Record<string, unknown>>;
}

test("execute_statement does not expose removed fallback confirmation fields", () => {
  assert.equal(propertiesFor("execute_statement").confirmExecution, undefined);
  assert.equal(propertiesFor("execute_statement").confirmationId, undefined);
});

test("query and scan schemas expose integer bounds", () => {
  const maxRows = propertiesFor("execute_query").maxRows;
  assert.deepEqual(
    { type: maxRows?.type, minimum: maxRows?.minimum, maximum: maxRows?.maximum },
    { type: "integer", minimum: 1, maximum: 1000 }
  );

  const count = propertiesFor("redis_scan").count;
  assert.deepEqual(
    { type: count?.type, minimum: count?.minimum, maximum: count?.maximum },
    { type: "integer", minimum: 1, maximum: 1000 }
  );
});
