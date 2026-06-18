English | [简体中文](./README.zh-CN.md)

# MCP Database Service

MCP Database Service is a TypeScript MCP server that lets AI agents inspect and query multiple database targets through one MCP service.

It supports MySQL, PostgreSQL, openGauss, Oracle, and Redis. SQL targets are read-only by default, connections are opened lazily for each request, and writable SQL requires explicit confirmation.

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

`query.timeoutMs` is optional. When set, the server applies that timeout to database operations.

## Supported Databases

| Database | Query | Metadata | `explain_query` | `analyze_query` | Writes |
| --- | --- | --- | --- | --- | --- |
| MySQL | Yes | Yes | Yes | Yes | Yes |
| PostgreSQL | Yes | Yes | Yes | Yes | Yes |
| openGauss | Yes | Yes | Yes | Yes | Yes |
| Oracle | Yes | Yes | Yes | No | Yes |
| Redis | Yes | Limited | No | No | No |

`show_create_table` currently supports MySQL and Oracle. PostgreSQL and openGauss return `NOT_SUPPORTED`.

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
| `execute_statement` | Run one non-query SQL statement on a writable target after explicit confirmation. |

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
6. Use `execute_statement` only when the target is writable and the user has approved the exact change.

## Safety Model

- Read tools are separated from write tools. Use `execute_query` for read-only SQL and `execute_statement` for non-query SQL.
- `execute_query` runs through a read-only SQL guard. It rejects writes, unsupported statement types, and multi-statement SQL.
- SQL targets are controlled by the per-target `readonly` flag. `execute_statement` is rejected when the selected target has `readonly: true`.
- `execute_statement` accepts non-query SQL only. It rejects `SELECT` and other read-only SQL so read and write workflows stay separate.
- Writable SQL is supported only for MySQL, Oracle, PostgreSQL, and openGauss targets configured with `readonly: false`.
- Redis tools are read-oriented and do not expose write operations.
- `show_loaded_config` and discovery tools return sanitized summaries. Passwords are never returned to the MCP client.
- Config reload is atomic. If a new config file is invalid, the previous validated in-memory config remains active.
- Connections are opened lazily for each request and cleaned up after the request finishes.

### Write Confirmation and Two-Step Fallback

- Manual user confirmation is always required before `execute_statement` executes.
- When the MCP client supports elicitation, the server asks for confirmation directly through the client.
- When elicitation is not available, the server uses the same explicit two-step confirmation model as other high-risk MCP tools: the first call returns confirmation details and a `confirmationId`; the second call must repeat the same `databaseKey`, `sql`, and `params`, then pass that `confirmationId` with `confirmExecution: true`.
- The server verifies that the second call matches the original pending request before execution.
- Confirmation details include SQL type, target object, SQL preview, parameter preview, risk level, and risk hints for dangerous statements such as `UPDATE` or `DELETE` without `WHERE`.

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

Use it when your agent supports skills. It standardizes database discovery, result-size discipline, read-first defaults, and write confirmation behavior.

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
