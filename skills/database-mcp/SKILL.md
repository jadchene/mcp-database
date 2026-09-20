---
name: database-mcp
description: Use database MCP tools for SQL and Redis inspection, queries, scripts, and confirmed writes.
---

# Database MCP

Use the database MCP service proactively for database-related work.

## Workflow

1. Reuse a target confirmed in the current session; call `list_databases` when the target is unknown or stale.
2. Use `databaseKey` for tool calls. Use the returned `databaseName` only when SQL needs an explicit database name; inspect project configuration when that name is still unclear.
3. Limit query results to 10 rows by default and avoid unnecessary large text or binary fields.
4. Use the dedicated Redis tools. For Oracle plans, use `explain_query` instead of `analyze_query`.
5. Default to reads unless the user explicitly requests a write.
6. Use `execute_script` for scripts requiring one connection and shared session state. File paths refer to the MCP server machine.

## Write Safety

- Let the user review the exact SQL, parameters, and risk level through the server's elicitation prompt.
- Stop after rejection, cancellation, or elicitation failure; never attempt a fallback write.
- `execute_script` uses the server's confirmation prompt. Set `useTransaction: true` only when the whole DML batch must roll back as one; DDL cannot be rolled back once it runs.
