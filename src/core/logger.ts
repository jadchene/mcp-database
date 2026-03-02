type LogLevel = "info" | "warn" | "error";

/**
 * The service uses very small structured logs so operators can inspect what
 * happened without leaking credentials or query payloads.
 */
export function log(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
  const payload = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...(fields ?? {})
  };

  const line = JSON.stringify(payload);

  console.error(line);
}
