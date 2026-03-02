export type ErrorCode =
  | "CONFIG_ERROR"
  | "DATABASE_NOT_FOUND"
  | "UNSUPPORTED_DATABASE_TYPE"
  | "READONLY_VIOLATION"
  | "INVALID_ARGUMENT"
  | "NOT_SUPPORTED"
  | "CONNECTION_ERROR"
  | "QUERY_ERROR"
  | "TIMEOUT";

/**
 * ApplicationError is the single normalized error type used across the service.
 * Wrapping driver-specific exceptions early keeps the MCP layer predictable.
 */
export class ApplicationError extends Error {
  public readonly code: ErrorCode;

  public readonly details?: Record<string, unknown>;

  public constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ApplicationError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Any unexpected thrown value is converted into ApplicationError before it crosses
 * a service boundary. This keeps responses stable and easier to debug.
 */
export function toApplicationError(error: unknown, fallbackCode: ErrorCode): ApplicationError {
  if (error instanceof ApplicationError) {
    return error;
  }

  if (error instanceof Error) {
    return new ApplicationError(fallbackCode, error.message, { cause: error.name });
  }

  return new ApplicationError(fallbackCode, "Unknown error", { error });
}
