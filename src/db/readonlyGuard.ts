import { ApplicationError } from "../core/errors.js";

const ALLOWED_DIRECT_KEYWORDS = new Set(["SELECT", "SHOW", "DESCRIBE", "DESC", "EXPLAIN"]);
const BLOCKED_KEYWORDS = new Set([
  "INSERT",
  "UPDATE",
  "DELETE",
  "MERGE",
  "ALTER",
  "DROP",
  "CREATE",
  "TRUNCATE",
  "GRANT",
  "REVOKE",
  "CALL",
  "DO",
  "REPLACE"
]);

export interface SqlStatementInfo {
  normalizedSql: string;
  firstKeyword: string;
  isReadonlyQuery: boolean;
  hasWhereClause: boolean;
  riskLevel: "normal" | "high" | "critical";
  riskReasons: string[];
}

/**
 * SQL validation is intentionally conservative. The service is for read-only
 * access, so a false negative is safer than accidentally allowing a write.
 */
export function assertReadonlySql(sql: string): void {
  const info = inspectSqlStatement(sql);
  const firstKeyword = info.firstKeyword;
  const stripped = info.normalizedSql;

  if (BLOCKED_KEYWORDS.has(firstKeyword)) {
    throw new ApplicationError("READONLY_VIOLATION", `Blocked SQL statement type: ${firstKeyword}`);
  }

  if (ALLOWED_DIRECT_KEYWORDS.has(firstKeyword)) {
    return;
  }

  if (firstKeyword === "WITH") {
    const downstreamKeyword = readMainKeywordAfterWith(stripped);
    if (downstreamKeyword === "SELECT") {
      return;
    }

    throw new ApplicationError("READONLY_VIOLATION", "WITH queries must resolve to SELECT");
  }

  throw new ApplicationError("READONLY_VIOLATION", `Unsupported SQL statement type: ${firstKeyword}`);
}

export function inspectSqlStatement(sql: string): SqlStatementInfo {
  const normalized = sql.trim();
  if (!normalized) {
    throw new ApplicationError("INVALID_ARGUMENT", "SQL must not be empty");
  }

  if (containsMultiStatementTerminator(normalized)) {
    throw new ApplicationError("INVALID_ARGUMENT", "Multiple SQL statements are not allowed");
  }

  const stripped = stripLeadingComments(normalized);
  const firstKeyword = readFirstKeyword(stripped);
  if (!firstKeyword) {
    throw new ApplicationError("INVALID_ARGUMENT", "Unable to determine SQL statement type");
  }

  const isReadonlyQuery =
    ALLOWED_DIRECT_KEYWORDS.has(firstKeyword) ||
    (firstKeyword === "WITH" && readMainKeywordAfterWith(stripped) === "SELECT");
  const hasWhereClause = hasTopLevelKeyword(stripped, "WHERE");
  const riskReasons = collectRiskReasons(firstKeyword, hasWhereClause);
  const riskLevel = determineRiskLevel(firstKeyword, riskReasons);

  return {
    normalizedSql: stripped,
    firstKeyword,
    isReadonlyQuery,
    hasWhereClause,
    riskLevel,
    riskReasons
  };
}

function collectRiskReasons(firstKeyword: string, hasWhereClause: boolean): string[] {
  const reasons: string[] = [];

  if ((firstKeyword === "UPDATE" || firstKeyword === "DELETE") && !hasWhereClause) {
    reasons.push(`${firstKeyword} without WHERE may affect all rows`);
  }

  if (firstKeyword === "TRUNCATE") {
    reasons.push("TRUNCATE usually removes all rows from the target table");
  }

  if (firstKeyword === "DROP") {
    reasons.push("DROP removes database objects and is difficult to recover");
  }

  if (firstKeyword === "ALTER") {
    reasons.push("ALTER changes schema structure and may be disruptive");
  }

  return reasons;
}

function determineRiskLevel(
  firstKeyword: string,
  riskReasons: string[]
): "normal" | "high" | "critical" {
  if (firstKeyword === "DROP" || firstKeyword === "TRUNCATE") {
    return "critical";
  }

  if (riskReasons.length > 0) {
    return "high";
  }

  return "normal";
}

function stripLeadingComments(sql: string): string {
  let index = 0;
  while (index < sql.length) {
    while (index < sql.length && /\s/.test(sql[index]!)) {
      index += 1;
    }

    if (sql.startsWith("--", index)) {
      const nextLine = sql.indexOf("\n", index);
      index = nextLine === -1 ? sql.length : nextLine + 1;
      continue;
    }

    if (sql.startsWith("/*", index)) {
      const end = sql.indexOf("*/", index + 2);
      if (end === -1) {
        throw new ApplicationError("READONLY_VIOLATION", "Unclosed SQL comment");
      }

      index = end + 2;
      continue;
    }

    break;
  }

  return sql.slice(index);
}

function readFirstKeyword(sql: string): string | null {
  const match = /^\s*([a-zA-Z]+)/.exec(sql);
  return match?.[1]?.toUpperCase() ?? null;
}

function containsMultiStatementTerminator(sql: string): boolean {
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inBacktick = false;

  for (let index = 0; index < sql.length; index += 1) {
    const current = sql[index]!;
    const previous = sql[index - 1];

    if (current === "'" && !inDoubleQuote && !inBacktick && previous !== "\\") {
      inSingleQuote = !inSingleQuote;
      continue;
    }

    if (current === "\"" && !inSingleQuote && !inBacktick && previous !== "\\") {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    if (current === "`" && !inSingleQuote && !inDoubleQuote) {
      inBacktick = !inBacktick;
      continue;
    }

    if (current === ";" && !inSingleQuote && !inDoubleQuote && !inBacktick) {
      for (let lookahead = index + 1; lookahead < sql.length; lookahead += 1) {
        if (!/\s/.test(sql[lookahead]!)) {
          return true;
        }
      }
    }
  }

  return false;
}

function hasTopLevelKeyword(sql: string, keyword: string): boolean {
  const upperKeyword = keyword.toUpperCase();
  const upperSql = sql.toUpperCase();
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inBacktick = false;
  let depth = 0;

  for (let index = 0; index < upperSql.length; index += 1) {
    const current = upperSql[index]!;
    const previous = upperSql[index - 1];

    if (current === "'" && !inDoubleQuote && !inBacktick && previous !== "\\") {
      inSingleQuote = !inSingleQuote;
      continue;
    }

    if (current === "\"" && !inSingleQuote && !inBacktick && previous !== "\\") {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    if (current === "`" && !inSingleQuote && !inDoubleQuote) {
      inBacktick = !inBacktick;
      continue;
    }

    if (inSingleQuote || inDoubleQuote || inBacktick) {
      continue;
    }

    if (current === "(") {
      depth += 1;
      continue;
    }

    if (current === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }

    if (depth > 0) {
      continue;
    }

    if (upperSql.startsWith(upperKeyword, index)) {
      const before = index === 0 ? " " : upperSql[index - 1]!;
      const after = upperSql[index + upperKeyword.length] ?? " ";
      if (!/[A-Z0-9_]/.test(before) && !/[A-Z0-9_]/.test(after)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * WITH parsing is lightweight but aware of strings and parentheses. The goal is
 * to locate the outer query keyword after all CTE definitions are consumed.
 */
function readMainKeywordAfterWith(sql: string): string | null {
  const upperSql = sql.toUpperCase();
  let index = upperSql.indexOf("WITH");
  if (index < 0) {
    return null;
  }

  let depth = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (index += 4; index < upperSql.length; index += 1) {
    const current = upperSql[index]!;
    const previous = upperSql[index - 1];

    if (current === "'" && !inDoubleQuote && previous !== "\\") {
      inSingleQuote = !inSingleQuote;
      continue;
    }

    if (current === "\"" && !inSingleQuote && previous !== "\\") {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    if (inSingleQuote || inDoubleQuote) {
      continue;
    }

    if (current === "(") {
      depth += 1;
      continue;
    }

    if (current === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }

    if (depth === 0 && /[A-Z]/.test(current)) {
      const remaining = upperSql.slice(index);
      const match = /^([A-Z]+)/.exec(remaining);
      if (!match) {
        continue;
      }

      const keyword = match[1] ?? null;
      if (!keyword) {
        continue;
      }

      if (keyword === "RECURSIVE" || keyword === "AS") {
        continue;
      }

      if (keyword === "SELECT") {
        return keyword;
      }

      if (BLOCKED_KEYWORDS.has(keyword)) {
        return keyword;
      }
    }
  }

  return null;
}
