import { createHash } from "node:crypto";

import type { DatabaseConfig } from "./configTypes.js";

/**
 * Bind a write confirmation to the exact target configuration without exposing
 * credentials. Stable key ordering prevents harmless config formatting changes
 * from invalidating a confirmation.
 */
export function fingerprintDatabaseTarget(database: DatabaseConfig): string {
  return createHash("sha256")
    .update(stableSerialize(database))
    .digest("hex");
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`);
    return `{${entries.join(",")}}`;
  }

  return JSON.stringify(value) ?? "null";
}
