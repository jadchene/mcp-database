English | [简体中文](./README.zh-CN.md)

# MCP Database Service

An MCP server for MySQL, PostgreSQL, Oracle, and Redis with explicit persistent connections and SQL session continuity.

## Install

```powershell
npm install -g @jadchene/mcp-database-service
mcp-database-service --config ./config/databases.json
```

The config path can also be supplied through `MCP_DATABASE_CONFIG`.

## Configuration

```json
{
  "sessionIdleTimeoutMs": 1800000,
  "maxSessions": 32,
  "query": {
    "timeoutMs": 5000
  },
  "logging": {
    "enabled": false
  },
  "databases": [
    {
      "key": "main-mysql",
      "type": "mysql",
      "enable": true,
      "readonly": true,
      "connection": {
        "host": "127.0.0.1",
        "port": 3306,
        "databaseName": "app_db",
        "user": "app_reader",
        "password": "replace-with-password"
      }
    }
  ]
}
```

`enable` defaults to `true`. Disabled targets remain in the file, are hidden from discovery/config summaries, and cannot connect. Config reload is automatic; `reload_config` also reloads manually. Invalid updates keep the last valid configuration. Disabling a target or changing connection/permission settings invalidates its sessions.

`sessionIdleTimeoutMs` is an idle duration (30 minutes by default), restarted when each valid database operation finishes; it is not a fixed lifetime from connect. `maxSessions` defaults to 32. Each connection attempt counts toward the limit. Query timeouts are separate from idle expiry. Logging is off by default; when enabled, the default directory is the system temporary directory. Relative logging paths resolve from the config file.

## Supported Databases

| Database | SQL Query | SQL Write | Runtime Analysis | SQL Script |
| --- | --- | --- | --- | --- |
| MySQL | ✓ | ✓ | ✓ | ✓ |
| PostgreSQL | ✓ | ✓ | ✓ | — |
| Oracle | ✓ | ✓ | — | — |
| Redis | — | — | — | — |

SQL writes require target authorization. Redis supports GET, HGETALL, SCAN, and connectivity checks.

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

Only `connect` establishes connections. All other database operations require `sessionId`; passing `databaseKey` to them is rejected. Reuse the same ID for variables, temporary tables, current schema, and transactions. Independent calls preserve state, so scripts are optional.

```text
connect({ databaseKey: "main-mysql" }) → sessionId = S
execute_statement({ sessionId: S, sql: "SET @x = 123" })
execute_query({ sessionId: S, sql: "SELECT @x" }) → 123
get_transaction_status({ sessionId: S })
disconnect({ sessionId: S })
```

The SET example requires a target with `readonly: false` or `dangerMode: true`.

Same-session concurrent operations and disconnect during execution return `SESSION_BUSY`; separate sessions can run concurrently. Idle expiry, network loss, or service restart invalidates IDs. Call `connect` explicitly again; there is no automatic reconnect or SQL replay. Long-running operations do not expire from idleness.

Start transactions with engine-native SQL through `execute_statement`; finish with the commit/rollback tools or native SQL. Query tools do not secretly begin, commit, or roll back transactions. Results are returned once in `structuredContent`. Ordinary SQL includes only `transaction.state`; SQL errors retain the observed state. `get_transaction_status` adds `autoCommit`. States are `none`, `active`, `failed`, or `unknown`; explicit Redis status inspection returns `not_supported`, while Redis reads omit SQL transaction metadata. Session IDs and idle duration are returned by connect, without repeating internal versions, timestamps, or deadlines.

`execute_script` participates in the existing transaction by default. `useTransaction: true` explicitly requests a script-owned transaction; it is rejected if the session already has a transaction or the script controls transactions/autocommit. On failure only the script-owned transaction is rolled back. DDL implicit commits follow engine rules. A lost connection or timed-out write can return `EXECUTION_OUTCOME_UNKNOWN`; do not replay automatically.

## Writes and Approval

SQL targets keep the existing `readonly` setting. On writable targets, statements, scripts, and non-empty transaction commits require interactive Accept / Decline / Cancel approval. Rollback does not require write approval. Approval is bound to the target and session version; expiry or state changes while waiting prevent execution. Clients without elicitation cannot perform approval-required operations.

`dangerMode: true` enables Full Access for that target: it overrides readonly and bypasses manual/automatic approval. Results include a Full Access warning. `codexAutoReview: true` adds Codex approval metadata in normal mode; both fields default to false. SQL validation and database account permissions still apply.

`execute_query` rejects non-query, locking, file-output, and multi-statement SQL. Query protection does not replace restricted database credentials, especially for functions or procedures with side effects. Discovery never returns passwords; logs retain SQL fingerprints and parameter counts instead of SQL text or values.

## Oracle

Thin mode is the default. For Thick mode set `connection.clientMode: "thick"` and `connection.clientLibDir` to Oracle Instant Client. Enabled Oracle targets in one process must share the mode and library directory. Oracle DML uses manual commit; use `commit_transaction` or `rollback_transaction`. `analyze_query` is unsupported. `explain_query` requires an active transaction and cleans up its plan with a savepoint without ending the outer transaction.

## Development

```powershell
npm install
npm run build
npm test
npm run verify:reload
npm run verify:package
```

Agent skill: [database-mcp](./skills/database-mcp/SKILL.md).
