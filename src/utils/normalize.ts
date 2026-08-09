/**
 * Normalization converts driver-specific values into plain JSON-safe objects.
 * This keeps MCP responses stable regardless of which driver produced the data.
 */
export function normalizeValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value ?? null;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Buffer.isBuffer(value)) {
    return value.toString("base64");
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeValue(item));
  }

  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, normalizeValue(item)])
    );
  }

  return value;
}

export function normalizeRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) => normalizeValue(row) as Record<string, unknown>);
}

export function normalizeDatabaseBoolean(value: unknown, defaultValue = false): boolean {
  if (value === null || value === undefined || value === "") {
    return defaultValue;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }

  const normalized = String(value).trim().toUpperCase();
  if (["Y", "YES", "TRUE", "1"].includes(normalized)) {
    return true;
  }
  if (["N", "NO", "FALSE", "0"].includes(normalized)) {
    return false;
  }
  return defaultValue;
}
