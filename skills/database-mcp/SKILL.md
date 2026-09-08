---
name: database-mcp
description: Use the database MCP service for routine database work across MySQL, Oracle, PostgreSQL, Redis, and openGauss. Trigger this skill when the task involves querying data, inspecting schemas, locating database names from project config, preparing SQL, checking indexes, reading Redis keys, or handling database writes through interactive yes/no confirmation.
---

# Database MCP

Use the database MCP service proactively for database-related work.

## Workflow

1. Start with `list_databases` to discover available targets.
2. Use `databaseKey` for tool calls. Use the returned `databaseName` only when SQL needs an explicit database name; inspect project configuration when that name is still unclear.
3. Limit query results to 10 rows by default and avoid unnecessary large text or binary fields.
4. Use the dedicated Redis tools. For Oracle plans, use `explain_query` instead of `analyze_query`.
5. Default to reads unless the user explicitly requests a write.
6. To run a script on one connection that relies on session variables (for example `SET @var = 1`), stored procedures, or a series of DML, use `execute_script`. It accepts either a full SQL string or a local `.sql` file. Only pass a file path the operator trusts, because the server reads it from the machine where the MCP server runs.

## Write Safety

- Let the user review the exact SQL, parameters, and risk level through the server's elicitation prompt.
- Stop after rejection, cancellation, or elicitation failure; never attempt a fallback write.
- `execute_script` uses the server's confirmation prompt. Set `useTransaction: true` only when the whole DML batch must roll back as one; DDL cannot be rolled back once it runs.
