English | [简体中文](./README.zh-CN.md)

# MCP Database Service

MCP Database Service is a TypeScript MCP server that lets AI agents inspect and query multiple database targets through one MCP service.

It supports MySQL, PostgreSQL, openGauss, Oracle, and Redis. SQL targets are read-only by default, connections are opened lazily for each request, and writable SQL requires explicit confirmation unless Full Access is enabled for the target.

> [!IMPORTANT]
> Starting with **v0.3.0**, the non-elicitation two-step confirmation fallback has been removed. Outside `dangerMode`, `execute_statement` returns an error without executing when the MCP client does not support elicitation or when the elicitation request fails. Use an MCP client with elicitation support for database writes.

## Features

- Multiple named database targets in one JSON config file.
- MySQL, PostgreSQL, openGauss, Oracle, and Redis support.
- Read-only query tools that block write SQL.
- Metadata tools for schemas, tables, columns, indexes, variables, locks, and sessions.
- Static plan inspection through `explain_query`.
- Runtime query analysis through `analyze_query` where supported.
- Guarded non-query SQL through `execute_statement` on explicitly writable targets.
- Manual and automatic config reload with atomic fallback to the last valid config.
- Optional file logging with paths resolved from the config file location.
- Lazy short-lived connections with cleanup after each request.

## Why Use It

- Give agents database visibility without exposing credentials or ad hoc SQL scripts in prompts.
- Keep most database work read-only while still allowing controlled writes when a target is configured for it.
- Use the same discovery and query workflow across different SQL engines.
- Inspect performance and locking information before changing SQL or indexes.

## Quick Start

Install from npm:

```powershell
npm install -g @jadchene/mcp-database-service
mcp-database-service --config ./config/databases.example.json
```

Run from source:

```bash
npm install
npm run build
node dist/index.js --config ./config/databases.example.json
```

The published CLI command is:

```text
mcp-database-service
```

## Configuration

Pass the config file by CLI argument:

```bash
mcp-database-service --config ./config/databases.json
```

Or by environment variable:

```bash
MCP_DATABASE_CONFIG=./config/databases.json mcp-database-service
```

Minimal SQL target example:

```json
{
  "logging": {
    "enabled": true,
    "directory": "./logs"
  },
  "query": {
    "timeoutMs": 5000
  },
  "databases": [
    {
      "key": "main-mysql",
      "type": "mysql",
      "readonly": true,
      "codexAutoReview": false,
      "dangerMode": false,
      "connection": {
        "host": "127.0.0.1",
        "port": 3306,
        "databaseName": "app_db",
        "user": "app_reader",
        "password": "replace-with-password",
        "connectTimeoutMs": 5000
      }
    }
  ]
}
```

`logging.enabled` defaults to `false`. When enabled, logs are written to the system temporary directory unless `logging.directory` is set. Relative log directories are resolved from the config file location.

`query.timeoutMs` is optional. When set, the server applies that timeout to database operations and interrupts the active connection after expiry. A timed-out write returns `EXECUTION_OUTCOME_UNKNOWN`, so callers can verify the result instead of retrying blindly.

## Supported Databases

| Database | Query | Metadata | `explain_query` | `analyze_query` | Writes | `execute_script` |
| --- | --- | --- | --- | --- | --- | --- |
| MySQL | Yes | Yes | Yes | Yes | Yes | Yes |
| PostgreSQL | Yes | Yes | Yes | Yes | Yes | No |
| openGauss | Yes | Yes | Yes | Yes | Yes | No |
| Oracle | Yes | Yes | Yes | No | Yes | No |
| Redis | Yes | Limited | No | No | No | No |

Operational tools such as `show_variables`, `find_long_running_queries`, `find_blocking_sessions`, and `show_locks` depend on the visibility and privileges of the configured database account.

## MCP Tools

Configuration and discovery:

| Tool | Purpose |
| --- | --- |
| `show_loaded_config` | Show the active config path, load time, logging state, query timeout, and sanitized connection summaries. |
| `reload_config` | Reload the current JSON config file and replace the in-memory config only if validation succeeds. |
| `list_databases` | List configured target keys, database names, types, and readonly flags without opening connections. |
| `ping_database` | Test connectivity for one configured database target. |

SQL metadata:

| Tool | Purpose |
| --- | --- |
| `list_schemas` | List schemas available on one SQL target. |
| `list_tables` | List tables and views under a schema or default schema. |
| `list_views` | List views under a schema or default schema. |
| `describe_table` | Inspect table columns and types before writing joins, reports, or update statements. |
| `show_create_table` | Return database-side DDL where supported. |
| `search_tables` | Search tables and views by partial name. |
| `search_columns` | Search columns by partial name across a schema. |
| `list_indexes` | Inspect indexes for one table. |
| `get_table_statistics` | Return approximate row counts, storage metrics, or database-specific table statistics. |
| `show_variables` | Inspect database runtime variables where supported and permitted. |
| `find_long_running_queries` | Find currently running sessions above a duration threshold. |
| `find_blocking_sessions` | Inspect blocking relationships between database sessions. |
| `show_locks` | Show lock rows exposed by the database engine. |

SQL execution and performance:

| Tool | Purpose |
| --- | --- |
| `execute_query` | Run one read-only SQL query. It rejects writes and multi-statement SQL. |
| `explain_query` | Return the static execution plan for a read-only SQL query. Pass the original SQL, not `EXPLAIN ...`. |
| `analyze_query` | Return runtime analysis for a read-only SQL query where supported. Pass the original SQL, not `EXPLAIN ANALYZE ...`. |
| `execute_statement` | Run one non-query SQL statement such as INSERT, UPDATE, DELETE, or DDL. |
| `execute_script` | Run one whole MySQL script on a single connection, optionally inside a transaction. |

Redis:

| Tool | Purpose |
| --- | --- |
| `redis_get` | Read one Redis string key. |
| `redis_hgetall` | Read one Redis hash key. |
| `redis_scan` | Cursor-scan Redis keys with an optional pattern. |

## Typical Workflow

1. Call `list_databases` to choose a configured target.
2. Call `list_schemas`, `search_tables`, or `list_tables` to find the relevant objects.
3. Call `describe_table` and `list_indexes` before writing joins or optimization SQL.
4. Use `execute_query` for read-only SQL.
5. Use `explain_query` or `analyze_query` for performance work.
6. Use `execute_statement` for non-query SQL changes.
7. Use `execute_script` when a script must run on one connection and relies on session variables (for example `SET @var = 1`), stored procedures, or a series of DML.

## Safety Model

- Read tools are separated from write tools. Use `execute_query` for read-only SQL and `execute_statement` for non-query SQL.
- `execute_query` runs through a read-only SQL guard and always executes in a database read-only transaction, even for writable targets. It rejects writes, data-modifying CTEs, `SELECT INTO`, file output, locking queries, unsupported statement types, and multi-statement SQL.
- Outside `dangerMode`, SQL targets are controlled by the per-target `readonly` flag. `execute_statement` is rejected when the selected target has `readonly: true`.
- `execute_statement` accepts non-query SQL only. It rejects `SELECT` and other read-only SQL so read and write workflows stay separate.
- Writable SQL is supported only for MySQL, Oracle, PostgreSQL, and openGauss targets configured with `readonly: false` or `dangerMode: true`.
- `execute_script` runs a whole script on one connection (so session variables such as `@var` are preserved) and requires interactive confirmation unless `dangerMode` is enabled. With `useTransaction: true` it commits on success and rolls back on failure, but DDL such as `CREATE`/`ALTER`/`DROP`/`TRUNCATE`/`GRANT` causes an implicit commit and cannot be rolled back. Outside `dangerMode`, it also blocks scripts that write to a server-side file (`INTO OUTFILE`/`DUMPFILE`).
- Redis tools are read-oriented and do not expose write operations.
- `show_loaded_config` and discovery tools return sanitized summaries. Passwords are never returned to the MCP client.
- Runtime logs store only SQL length, a fingerprint, and parameter count; SQL text and parameter values are not logged.
- Config reload is atomic. If a new config file is invalid, the previous validated in-memory config remains active.
- Connections are opened lazily for each request and cleaned up after the request finishes.

### Write Confirmation

- `dangerMode` defaults to `false`. Set `"dangerMode": true` in the selected `databases[]` block for Full Access. It takes precedence over `codexAutoReview`: all tools supported by the database type execute without manual or automatic operation approval, overriding `readonly` and allowing server-side file writes through scripts. Input validation, tool SQL semantics, and database account permissions still apply. Other databases remain independent. Read, success, and failure JSON responses include `warning`; discovery and config summaries also warn on enabled target entries.

Warning text:

```text
FULL ACCESS: Danger mode is enabled for this target. All available tools can execute without operation approval. Calls may modify or delete data immediately. Use caution.
```

- Outside `dangerMode`, `execute_statement` and `execute_script` require approval before execution. Confirmation shows the actual SQL, parameters, target, and risk level.
- Codex automatic-review integration is disabled by default. Set `"codexAutoReview": true` in the selected `databases[]` block to enable approval metadata for Codex clients. Codex uses automatic review when `approvals_reviewer = "auto_review"` is enabled; otherwise, use normal Accept / Decline / Cancel confirmation. Approval remains subject to Codex policy.
- Accept executes the operation; decline or cancel leaves it unexecuted.
- Outside `dangerMode`, when elicitation is unavailable or fails, the server returns an explicit error and does not execute the SQL.

## Config Reload

- The server loads and validates the JSON config at startup.
- The config file is watched and reloaded after on-disk changes.
- Reload is debounced to avoid reading half-written files.
- Reload is atomic: if the new config is invalid, the previous in-memory config remains active.
- `reload_config` forces a manual reload.
- `show_loaded_config` reports the current config path, load time, logging status, query timeout, and sanitized connection summaries. Passwords are never returned.

## Oracle Notes

Oracle supports Thin and Thick mode. Thin mode is the default when `clientMode` is omitted.

Thick mode requires Oracle Instant Client:

```json
{
  "key": "oracle-thick-example",
  "type": "oracle",
  "readonly": true,
  "codexAutoReview": false,
  "dangerMode": false,
  "connection": {
    "host": "127.0.0.1",
    "port": 1521,
    "serviceName": "XEPDB1",
    "user": "app_reader",
    "password": "replace-with-password",
    "clientMode": "thick",
    "clientLibDir": "C:\\oracle\\instantclient_19_25"
  }
}
```

All Oracle targets in one process must use the same client mode. Thick mode targets must also share the same `clientLibDir`.

`analyze_query` is not supported for Oracle and returns `NOT_SUPPORTED`.

## Skill Integration

This repository includes an agent skill for safer database workflows:

- Skill path: `skills/database-mcp/SKILL.md`

Use it when your agent supports skills. It standardizes database discovery, result-size discipline, read-first defaults, and tool selection.

## MCP Client Configuration

Codex:

```toml
[mcp_servers.database]
command = "mcp-database-service"
args = ["--config", "./config/databases.json"]
```

Gemini CLI:

```json
{
  "mcpServers": {
    "database": {
      "type": "stdio",
      "command": "mcp-database-service",
      "args": ["--config", "./config/databases.json"]
    }
  }
}
```

Claude Code:

```json
{
  "mcpServers": {
    "database": {
      "type": "stdio",
      "command": "mcp-database-service",
      "args": ["--config", "./config/databases.json"]
    }
  }
}
```

## Development

```bash
npm install
npm run build
node dist/index.js --config ./config/databases.example.json
```

Run tests after building:

```bash
npm test
```

## Global Installation From Source

Windows:

```powershell
pwsh -File .\scripts\install-global.ps1
```

Linux/macOS:

```bash
sh ./scripts/install-global.sh
```

The helper scripts install dependencies, build the project, create a tarball with `npm pack`, install that tarball globally, and delete the temporary tarball. They do not use `npm link`.

## License

MIT. See [LICENSE](LICENSE).
