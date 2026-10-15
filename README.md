English | [简体中文](./README.zh-CN.md)

# MCP Database Service

An MCP server for MySQL, PostgreSQL, Oracle, and Redis with explicit persistent connections and SQL session continuity.

## Quick Start

Use Node.js 24 or later and install the service:

```powershell
npm install -g @jadchene/mcp-database-service
```

Save the configuration below as `databases.json` and replace the connection details. Use the absolute path to that file when adding the service.

Codex:

```powershell
codex mcp add database -- mcp-database-service --config /absolute/path/databases.json
```

Claude Code:

```powershell
claude mcp add database -- mcp-database-service --config /absolute/path/databases.json
```

On Windows, a path such as `C:/mcp/database/databases.json` works. The client starts the stdio service; no separate background process or HTTP port is needed. The config path can also be supplied through `MCP_DATABASE_CONFIG`; there is no default config path.

To use multiple MCP services through one entry point, connect through [MCP Gateway](https://github.com/jadchene/mcp-gateway).

## Configuration

```json
{
  "sessionIdleTimeoutMs": 1800000,
  "maxSessions": 32,
  "query": {
    "timeoutMs": 5000
  },
  "logging": {
    "enabled": false,
    "directory": "./logs"
  },
  "databases": [
    {
      "key": "main-mysql",
      "type": "mysql",
      "enable": true,
      "readonly": true,
      "dangerMode": false,
      "codexAutoReview": false,
      "connection": {
        "host": "127.0.0.1",
        "port": 3306,
        "databaseName": "app_db",
        "user": "app_reader",
        "password": "replace-with-password",
        "connectTimeoutMs": 5000,
        "ssl": false
      }
    },
    {
      "key": "main-postgresql",
      "type": "postgresql",
      "enable": false,
      "readonly": true,
      "dangerMode": false,
      "codexAutoReview": false,
      "connection": {
        "host": "127.0.0.1",
        "port": 5432,
        "databaseName": "app_db",
        "user": "app_reader",
        "password": "replace-with-password",
        "connectTimeoutMs": 5000,
        "ssl": false
      }
    },
    {
      "key": "oracle-thick-example",
      "type": "oracle",
      "enable": false,
      "readonly": true,
      "dangerMode": false,
      "codexAutoReview": false,
      "connection": {
        "host": "127.0.0.1",
        "port": 1521,
        "serviceName": "XEPDB1",
        "user": "app_reader",
        "password": "replace-with-password",
        "connectTimeoutMs": 5000,
        "clientMode": "thick",
        "clientLibDir": "C:/oracle/instantclient_19_25"
      }
    },
    {
      "key": "cache-redis",
      "type": "redis",
      "enable": false,
      "readonly": true,
      "dangerMode": false,
      "codexAutoReview": false,
      "connection": {
        "host": "127.0.0.1",
        "port": 6379,
        "databaseName": 0,
        "username": "default",
        "password": "replace-with-password",
        "connectTimeoutMs": 5000
      }
    }
  ]
}
```

The same configuration is available in [databases.example.json](config/databases.example.json). Keep the targets you need, replace their connection details, and set `enable` to `true`. Oracle Thin mode uses `"clientMode": "thin"` without `clientLibDir`; Redis without authentication can omit `username` and `password`. Config values are literal; `${VAR}` placeholders are not expanded.

`enable: false` hides a target and closes its sessions. Configuration reloads automatically or through `reload_config`; invalid updates keep the last valid config. Connection or permission changes invalidate existing sessions.

Timeouts are in milliseconds. Idle time restarts after each operation, and `maxSessions` includes connections being established. Logging is off by default; relative log directories resolve from the config directory.

## Supported Databases

| Database | SQL Query | SQL Write | Runtime Analysis | SQL Script |
| --- | --- | --- | --- | --- |
| MySQL | ✓ | ✓ | ✓ | ✓ |
| PostgreSQL | ✓ | ✓ | ✓ | — |
| Oracle | ✓ | ✓ | — | — |
| Redis | — | — | — | — |

Redis supports GET, HGETALL, SCAN, and connectivity checks.

## Tools

| Tool | Purpose |
| --- | --- |
| `list_databases` / `show_loaded_config` / `reload_config` | List enabled targets; inspect or reload sanitized configuration. |
| `connect` | Open an independent connection for an enabled `databaseKey`; return `sessionId`. |
| `disconnect` | Close an idle session; uncommitted work is rolled back. |
| `get_transaction_status` | Read actual transaction state without changing it. |
| `commit_transaction` | Commit the current SQL transaction. |
| `rollback_transaction` | Roll back the whole current SQL transaction. |
| `list_schemas` / `list_tables` / `describe_table` | Inspect schemas, tables, and columns. |
| `list_indexes` / `get_table_statistics` / `show_create_table` | Inspect indexes, statistics, and DDL. |
| `list_views` / `search_tables` / `search_columns` | List views or search table/column names. |
| `show_variables` / `find_long_running_queries` | Inspect settings and slow activity. |
| `find_blocking_sessions` / `show_locks` | Inspect blocking and locks, subject to engine support and privileges. |
| `execute_query` | Execute one read-only SQL statement with parameters and a row limit. |
| `explain_query` / `analyze_query` | Inspect a static plan or run runtime analysis; pass the original SQL. |
| `execute_statement` | Execute one non-query statement, including SET, USE, transaction control, DML, or DDL. |
| `execute_script` | Execute a whole MySQL script from `sql` or server-local `sqlFile` (UTF-8, at most 2 MiB). |
| `redis_get` / `redis_hgetall` / `redis_scan` | Read strings/hashes or cursor-scan Redis keys. |

## Sessions and Transactions

Call `connect` with a `databaseKey`, reuse the returned `sessionId` for subsequent operations, and call `disconnect` when finished. Variables, temporary tables, the current schema, and transactions persist within that session.

Run same-session operations sequentially. Reconnect after idle expiry, connection loss, or a service restart. If a write times out or loses its connection, check the result before retrying.

Start SQL transactions with native SQL through `execute_statement`; use `commit_transaction`, `rollback_transaction`, and `get_transaction_status` to manage them. Queries do not automatically commit or roll back transactions. `execute_script` uses the current transaction by default; use `useTransaction: true` for a script-owned transaction without an existing transaction or transaction-control statements in the script. DDL follows the database's own commit rules.

## Writes and Approval

Set the target's `readonly` to `false` to allow writes. Statements, scripts, and non-empty transaction commits require a client that supports interactive approval; rollback does not require approval.

Optional `codexAutoReview: true` allows compatible Codex clients to review operations automatically. `dangerMode: true` overrides readonly and skips approval. Both are disabled by default; database account permissions still apply.

## Oracle

Enabled Oracle targets in one process must share the client mode and library directory. DML requires manual commit, and `explain_query` requires an active transaction.

## Development

```powershell
npm install
npm run build
npm test
npm run verify:reload
npm run verify:package
```

Agent skill: [database-mcp](./skills/database-mcp/SKILL.md).

## License

[MIT](LICENSE)
