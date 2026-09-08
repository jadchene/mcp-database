/**
 * 脚本风险扫描：统计顶层语句数，识别 DDL 与危险写入。
 *
 * 与 readonlyGuard 不同，这里只做词法层面的提示，不拆分脚本、不判断语句边界，
 * 因此不会影响 @var 等会话变量、存储过程或字符串内容。扫描结果仅用于确认提示。
 */

const DDL_KEYWORDS = new Set([
  "CREATE",
  "ALTER",
  "DROP",
  "TRUNCATE",
  "RENAME"
]);

const HIGH_RISK_KEYWORDS = new Set([
  "GRANT",
  "REVOKE",
  "LOAD",
  "OUTFILE",
  "DUMPFILE"
]);

export interface ScriptGuardResult {
  /** 顶层语句数量（按分号粗估，忽略字符串与注释内的分号）。 */
  statementCount: number;
  /** 检测到的 DDL 关键词列表，用于提示"DDL 无法随事务回滚"。 */
  ddlKeywords: string[];
  /** 检测到的危险写入关键词列表，例如 INTO OUTFILE / LOAD DATA。 */
  highRiskKeywords: string[];
}

/**
 * 扫描脚本，返回面向确认提示的安全信息。
 * 不拆分、不执行，只看词法层面出现的关键词与顶层分号。
 */
export function scanScriptRisk(sql: string): ScriptGuardResult {
  const words = readScriptWords(sql);
  const ddlKeywords: string[] = [];
  const highRiskKeywords: string[] = [];

  for (const word of words) {
    if (DDL_KEYWORDS.has(word) && !ddlKeywords.includes(word)) {
      ddlKeywords.push(word);
    }
    if (HIGH_RISK_KEYWORDS.has(word) && !highRiskKeywords.includes(word)) {
      highRiskKeywords.push(word);
    }
  }

  return {
    statementCount: countTopLevelStatements(sql),
    ddlKeywords,
    highRiskKeywords
  };
}

/**
 * 粗略统计顶层分号数量，字符串、注释、反引号、美元引号内的分号不计入。
 * 仅用于提示"约 N 条"，不用于执行拆分。
 */
function countTopLevelStatements(sql: string): number {
  const upper = sql.toUpperCase();
  let count = 0;
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let i = 0;

  while (i < upper.length) {
    const current = upper[i]!;
    const next = upper[i + 1];
    const prev = upper[i - 1];

    if (current === "-" && next === "-") {
      const end = upper.indexOf("\n", i + 2);
      i = end === -1 ? upper.length : end + 1;
      continue;
    }

    if (current === "/" && next === "*") {
      const end = upper.indexOf("*/", i + 2);
      if (end === -1) {
        break;
      }
      i = end + 2;
      continue;
    }

    if (current === "#") {
      const end = upper.indexOf("\n", i + 1);
      i = end === -1 ? upper.length : end + 1;
      continue;
    }

    if (current === "'" && prev !== "\\" && !inDouble && !inBacktick) {
      inSingle = !inSingle;
      i += 1;
      continue;
    }

    if (current === "\"" && prev !== "\\" && !inSingle && !inBacktick) {
      inDouble = !inDouble;
      i += 1;
      continue;
    }

    if (current === "`" && !inSingle && !inDouble) {
      inBacktick = !inBacktick;
      i += 1;
      continue;
    }

    if (current === "$" && !inSingle && !inDouble && !inBacktick) {
      const tagMatch = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(upper.slice(i));
      if (tagMatch) {
        const tag = tagMatch[0];
        const end = upper.indexOf(tag, i + tag.length);
        i = end === -1 ? upper.length : end + tag.length;
        continue;
      }
    }

    if (inSingle || inDouble || inBacktick) {
      i += 1;
      continue;
    }

    if (current === "(") {
      depth += 1;
      i += 1;
      continue;
    }

    if (current === ")") {
      depth = Math.max(0, depth - 1);
      i += 1;
      continue;
    }

    if (current === ";" && depth === 0) {
      count += 1;
    }

    i += 1;
  }

  return count;
}

/**
 * 提取脚本中无引号、无注释的 SQL 关键词，用于识别 DDL 与危险词。
 */
function readScriptWords(sql: string): string[] {
  const words: string[] = [];
  let i = 0;

  while (i < sql.length) {
    const current = sql[i]!;
    const next = sql[i + 1];

    if (current === "-" && next === "-") {
      const end = sql.indexOf("\n", i + 2);
      i = end === -1 ? sql.length : end + 1;
      continue;
    }

    if (current === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      continue;
    }

    if (current === "#") {
      const end = sql.indexOf("\n", i + 1);
      i = end === -1 ? sql.length : end + 1;
      continue;
    }

    if (current === "'" || current === "\"" || current === "`") {
      const quote = current;
      i += 1;
      while (i < sql.length) {
        if (sql[i] === "\\") {
          i += 2;
          continue;
        }
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }

    if (current === "$") {
      const tagMatch = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(i));
      if (tagMatch) {
        const tag = tagMatch[0];
        const end = sql.indexOf(tag, i + tag.length);
        i = end === -1 ? sql.length : end + tag.length;
        continue;
      }
    }

    if (/[A-Za-z_]/.test(current)) {
      const match = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(sql.slice(i));
      if (match) {
        words.push(match[0].toUpperCase());
        i += match[0].length;
        continue;
      }
    }

    i += 1;
  }

  return words;
}
