---
name: database-mcp
description: Use the database MCP service for routine database work across MySQL, Oracle, PostgreSQL, Redis, and openGauss. Trigger this skill when the task involves querying data, inspecting schemas, locating database names from project config, preparing SQL, checking indexes, reading Redis keys, or handling any database write request that requires the mandatory two-step confirmation flow.
---

# Database MCP

Use the database MCP service proactively for database-related work.

## Scope

- Use this skill for routine database tasks such as querying data, inspecting schemas, locating database names from project config, preparing SQL, reading Redis keys, and handling write-safety confirmation flow.

## Required workflow

1. Start with `list_databases` to discover available targets.
2. Inspect table structure before writing business queries when the schema is not already clear.
3. Use `databaseKey` for MCP tool calls.
4. Use `list_databases.databaseName` only when SQL needs an explicit database name.
5. Default to query-only access unless the user explicitly asks for a write.

## Query and inspection rules

- Limit query results to 10 rows by default unless the task clearly requires a different size.
- Avoid `SELECT *` by default. Prefer selecting only the columns needed for the task.
- Avoid selecting very long text/blob-like fields unless they are necessary for the task, so token usage does not explode.
- Use `describe_table`, `list_indexes`, `get_table_statistics`, `explain_query`, and `analyze_query` when the task needs schema or performance analysis.
- Use `explain_query` instead of `analyze_query` for Oracle.
- For Redis, use the Redis MCP tools instead of SQL tools.

## Write safety rules

- Treat database writes as blocked until the user explicitly requests them.
- Any `UPDATE` must be confirmed by the user a second time before execution.
- Apply the same second-confirmation rule to `DELETE`, `DROP`, `TRUNCATE`, `INSERT INTO ... SELECT`, and other destructive or bulk-changing statements.
- If a write tool returns a `confirmationId`, treat that as an intermediate step only.
- After receiving `confirmationId`, ask the user again for a second explicit confirmation before calling the final execution step.
- Never treat the user's original write request as the second confirmation.
- Never call the final execution step with `confirmExecution=true` until that second confirmation is received.

## Database name discovery

- Check Spring configuration files to locate the actual database name when needed.
- Ask the user directly if the database information is still unclear after checking the project config.
