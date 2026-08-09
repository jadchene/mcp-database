import { ApplicationError } from "../core/errors.js";

const ALLOWED_DIRECT_KEYWORDS = new Set(["SELECT", "SHOW", "DESCRIBE", "DESC"]);
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
    if (!info.isReadonlyQuery) {
      throw new ApplicationError("READONLY_VIOLATION", "The query contains a construct with write or lock side effects");
    }
    return;
  }

  if (firstKeyword === "WITH") {
    const downstreamKeyword = readMainKeywordAfterWith(stripped);
    if (downstreamKeyword === "SELECT" && info.isReadonlyQuery) {
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

  const hasUnsafeReadonlyConstruct = containsUnsafeReadonlyConstruct(stripped);
  const isReadonlyQuery =
    !hasUnsafeReadonlyConstruct &&
    (ALLOWED_DIRECT_KEYWORDS.has(firstKeyword) ||
      (firstKeyword === "WITH" && readMainKeywordAfterWith(stripped) === "SELECT"));
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

function containsUnsafeReadonlyConstruct(sql: string): boolean {
  const words = readSqlWords(sql);

  if (words[0] === "SHOW" || words[0] === "DESCRIBE" || words[0] === "DESC") {
    return false;
  }

  if (words.some((word) => BLOCKED_KEYWORDS.has(word))) {
    return true;
  }

  for (let index = 0; index < words.length; index += 1) {
    const current = words[index];
    const next = words[index + 1];
    const afterNext = words[index + 2];

    // PostgreSQL SELECT INTO creates a table. MySQL INTO OUTFILE/DUMPFILE
    // writes on the database host. INTO variables are also stateful, so the
    // read tool rejects every SELECT INTO form conservatively.
    if (current === "SELECT" && words.slice(index + 1).includes("INTO")) {
      return true;
    }

    if (current === "INTO" && (next === "OUTFILE" || next === "DUMPFILE")) {
      return true;
    }

    if (current === "FOR" && (next === "UPDATE" || next === "SHARE")) {
      return true;
    }

    if (current === "LOCK" && next === "IN" && afterNext === "SHARE") {
      return true;
    }
  }

  return false;
}

/**
 * Extract unquoted SQL words while ignoring comments and the common quoting
 * forms used by the supported dialects. This is deliberately conservative;
 * database-level read-only transactions remain the authoritative boundary.
 */
function readSqlWords(sql: string): string[] {
  const words: string[] = [];
  let index = 0;

  while (index < sql.length) {
    const current = sql[index]!;
    const next = sql[index + 1];

    if (current === "-" && next === "-") {
      const end = sql.indexOf("\n", index + 2);
      index = end === -1 ? sql.length : end + 1;
      continue;
    }

    if (current === "/" && next === "*") {
      const end = sql.indexOf("*/", index + 2);
      if (end === -1) {
        throw new ApplicationError("READONLY_VIOLATION", "Unclosed SQL comment");
      }
      index = end + 2;
      continue;
    }

    if (current === "'") {
      index = skipQuoted(sql, index, "'");
      continue;
    }

    if (current === "\"") {
      index = skipQuoted(sql, index, "\"");
      continue;
    }

    if (current === "`") {
      index = skipQuoted(sql, index, "`");
      continue;
    }

    if (current === "[") {
      const end = sql.indexOf("]", index + 1);
      index = end === -1 ? sql.length : end + 1;
      continue;
    }

    if (current === "$") {
      const tagMatch = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(index));
      if (tagMatch) {
        const tag = tagMatch[0];
        const end = sql.indexOf(tag, index + tag.length);
        index = end === -1 ? sql.length : end + tag.length;
        continue;
      }
    }

    if (/[A-Za-z_]/.test(current)) {
      const match = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(sql.slice(index));
      if (match) {
        words.push(match[0].toUpperCase());
        index += match[0].length;
        continue;
      }
    }

    index += 1;
  }

  return words;
}

function skipQuoted(sql: string, start: number, quote: "'" | "\"" | "`"): number {
  let index = start + 1;
  while (index < sql.length) {
    if (sql[index] !== quote) {
      index += 1;
      continue;
    }

    if (sql[index + 1] === quote) {
      index += 2;
      continue;
    }

    return index + 1;
  }

  return sql.length;
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
