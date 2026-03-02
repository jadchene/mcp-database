import { appendFileSync, mkdirSync } from "node:fs";
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
  const payload = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...(fields ?? {})
  };

  const line = JSON.stringify(payload);

  console.error(line);

  if (loggerState.enabled) {
    appendFileSync(loggerState.filePath, `${formatFileLog(payload)}\n`, "utf8");
  }
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
