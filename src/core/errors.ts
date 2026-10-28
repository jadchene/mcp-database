type ErrorCode =
  | "CONFIG_ERROR"
  | "DATABASE_NOT_FOUND"
  | "DATABASE_DISABLED"
  | "SESSION_EXPIRED"
  | "SESSION_BUSY"
  | "SESSION_LIMIT_REACHED"
  | "TRANSACTION_FAILED"
  | "UNSUPPORTED_DATABASE_TYPE"
  | "READONLY_VIOLATION"
  | "INVALID_ARGUMENT"
  | "USER_DECLINED"
  | "NOT_SUPPORTED"
  | "CONNECTION_ERROR"
  | "QUERY_ERROR"
  | "TIMEOUT"
  | "EXECUTION_OUTCOME_UNKNOWN";

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
    const driverError = error as Error & { code?: string; fatal?: boolean };
    if (driverError.fatal === true || /^(?:ECONNRESET|ECONNREFUSED|EPIPE|PROTOCOL_CONNECTION_LOST|NJS-500|NJS-501|ORA-03113|ORA-03114)/.test(driverError.code ?? driverError.message)) {
      return new ApplicationError("CONNECTION_ERROR", error.message, { cause: driverError.code ?? error.name });
    }
    if (/^(?:57014|ER_QUERY_TIMEOUT|PROTOCOL_SEQUENCE_TIMEOUT|DPI-1067|ORA-01013)/.test(driverError.code ?? driverError.message)) {
      return new ApplicationError("TIMEOUT", error.message, { cause: driverError.code ?? error.name });
    }
    return new ApplicationError(fallbackCode, error.message, { cause: error.name });
  }

  return new ApplicationError(fallbackCode, "Unknown error", { error });
}
