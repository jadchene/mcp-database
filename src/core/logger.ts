import { appendFile, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

type LogLevel = "info" | "warn" | "error";

/**
 * The service uses very small structured logs so operators can inspect what
 * happened without leaking credentials or query payloads.
 */
const loggerState: {
  enabled: boolean;
  directory: string;
  filePath: string;
} = {
  enabled: false,
  directory: "",
  filePath: ""
};

export function configureLogger(config: { enabled: boolean; directory: string }): void {
  loggerState.enabled = config.enabled;
  loggerState.directory = config.directory;
  loggerState.filePath = path.join(config.directory, "mcp-database-service.log");

  if (config.enabled) {
    mkdirSync(config.directory, { recursive: true });
  }
}

export function log(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
  const sanitizedFields = sanitizeRecord(fields ?? {});
  delete sanitizedFields.timestamp;
  delete sanitizedFields.level;
  delete sanitizedFields.message;

  const payload = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...sanitizedFields
  };

  const line = JSON.stringify(payload);

  console.error(line);

  if (loggerState.enabled) {
    appendFile(loggerState.filePath, `${formatFileLog(payload)}\n`, "utf8", (error) => {
      if (error) {
        console.error(JSON.stringify({
          timestamp: new Date().toISOString(),
          level: "error",
          message: "Failed to append application log",
          cause: error.name
        }));
      }
    });
  }
}

function sanitizeRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, sanitizeLogValue(key, item)])
  );
}

function sanitizeLogValue(key: string, value: unknown): unknown {
  const normalizedKey = key.toLowerCase();
  if (
    normalizedKey === "error" ||
    normalizedKey === "message" ||
    normalizedKey.endsWith("message") ||
    normalizedKey.endsWith("reason")
  ) {
    return summarizeSensitiveText(value);
  }

  if (normalizedKey === "sql") {
    const sql = typeof value === "string" ? value : String(value ?? "");
    return {
      length: sql.length,
      fingerprint: createHash("sha256").update(sql).digest("hex").slice(0, 16)
    };
  }

  if (normalizedKey === "params" || normalizedKey === "parameters") {
    return {
      count: Array.isArray(value) ? value.length : value && typeof value === "object" ? Object.keys(value).length : 0
    };
  }

  if (["password", "secret", "token", "authorization", "apikey", "api_key"].some((part) => normalizedKey.includes(part))) {
    return "[REDACTED]";
  }

  if (Array.isArray(value)) {
    return value.map((item) => item && typeof item === "object" ? sanitizeRecord(item as Record<string, unknown>) : item);
  }

  if (value && typeof value === "object") {
    return sanitizeRecord(value as Record<string, unknown>);
  }

  return value;
}

function summarizeSensitiveText(value: unknown): { length: number; fingerprint: string } {
  const text = typeof value === "string" ? value : String(value ?? "");
  return {
    length: text.length,
    fingerprint: createHash("sha256").update(text).digest("hex").slice(0, 16)
  };
}

function formatFileLog(payload: Record<string, unknown>): string {
  const timestamp = String(payload.timestamp ?? "");
  const level = String(payload.level ?? "info").toUpperCase();
  const message = String(payload.message ?? "");
  const extraEntries = Object.entries(payload).filter(
    ([key]) => key !== "timestamp" && key !== "level" && key !== "message"
  );

  const lines = [`[${timestamp}] ${level} ${message}`];

  for (const [key, value] of extraEntries) {
    if (value === undefined) {
      continue;
    }

    if (typeof value === "string" && value.includes("\n")) {
      lines.push(`  ${key}:`);
      for (const line of value.split(/\r?\n/)) {
        lines.push(`    ${line}`);
      }
      continue;
    }

    lines.push(`  ${key}: ${formatFieldValue(value)}`);
  }

  return lines.join("\n");
}

function formatFieldValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return String(value);
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
