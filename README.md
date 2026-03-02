# MCP Database Service

A standalone multi-database MCP server written in TypeScript. The server reads a JSON configuration file, exposes mostly read-oriented database tools, and uses lazy short-lived connections so database sessions are opened only when a specific tool call needs them. Optional write execution is supported only for targets configured with `readonly: false`, and every write statement requires explicit manual confirmation from the MCP client.

## Supported Databases
- MySQL
- Oracle
- PostgreSQL
- openGauss (via PostgreSQL protocol compatibility)
- Redis

## Features
- Multiple named database targets in a single config file
- Manual config reload without restarting the MCP server
- Automatic config reload when the JSON file changes on disk
- Strict read-only enforcement for query tools
- Optional write execution with explicit MCP confirmation for writable targets
- Lazy connections with guaranteed cleanup after each request
- Metadata discovery tools for SQL databases
- Dedicated read tools for Redis

## Configuration
Provide the config path by one of these methods:

1. `node dist/index.js --config ./config/databases.json`
2. Set `MCP_DATABASE_CONFIG=/absolute/path/to/databases.json`

The configuration file must be a JSON array. Example:

```json
[
  {
    "key": "main-mysql",
    "type": "mysql",
    "readonly": true,
    "connection": {
      "host": "127.0.0.1",
      "port": 3306,
      "databaseName": "app_db",
      "user": "root",
      "password": "secret",
      "connectTimeoutMs": 5000
    }
  }
]
```

Oracle supports both Thin and Thick mode. Thick mode uses the same `oracledb` package, but requires Oracle Instant Client on the host machine. Example:

```json
{
  "key": "oracle-thick-example",
  "type": "oracle",
  "readonly": true,
  "connection": {
    "host": "127.0.0.1",
    "port": 1521,
    "serviceName": "XEPDB1",
    "user": "system",
    "password": "secret",
    "clientMode": "thick",
    "clientLibDir": "C:\\oracle\\instantclient_19_25"
  }
}
```

## Available MCP Tools
- `show_loaded_config`: show the current in-memory config path, load time, and all configured database targets
- `reload_config`: reload the JSON config file currently in use and atomically replace the in-memory configuration on success
- `list_databases`: list all configured target keys and logical database names without opening database connections
- `ping_database`: test connectivity for one configured target
- `list_schemas`: list schemas for one SQL target
- `list_tables`: list tables/views under one SQL schema or the default schema
- `describe_table`: inspect columns before writing joins, reports, or optimization SQL
- `list_indexes`: inspect table indexes for performance analysis
- `get_table_statistics`: inspect approximate row counts, storage metrics, and database-specific table statistics
- `execute_query`: run one read-only SQL query; pass the original query SQL, not write SQL
- `explain_query`: get the static execution plan for one read-only SQL query; pass the original query SQL, not `EXPLAIN ...`
- `analyze_query`: get runtime analysis for one read-only SQL query; pass the original query SQL, not `EXPLAIN ANALYZE ...`
- `execute_statement`: run one non-query SQL statement on a writable target after explicit manual confirmation
- `redis_get`: read one Redis string key
- `redis_hgetall`: read one Redis hash key
- `redis_scan`: cursor-scan Redis keys safely with an optional pattern

## Development

```bash
npm install
npm run build
node dist/index.js --config ./config/databases.example.json
```

## Global Installation

This project exposes a CLI command named `mcp-database-service` through the package `bin` field.

Recommended options:

1. Use the helper script:

```powershell
pwsh -File .\scripts\install-global.ps1
```

The helper script installs dependencies, builds the project, creates a tarball with `npm pack`, installs that tarball globally with `npm install -g <tarball>`, and then deletes the temporary tarball. It does not use `npm link`.

2. Or install the packed tarball manually:

```powershell
npm pack
npm install -g .\mcp-database-service-0.1.0.tgz
```

The package only publishes runtime files through the `files` field, so packaged installation includes `dist` and the runtime README/config example, not the whole source tree.

After installation, the command can be used like this:

```powershell
mcp-database-service --config .\config\databases.example.json
```

If you publish this package to npm later, the install form becomes:

```powershell
npm install -g mcp-database-service
```

Example MCP server configuration:

```json
{
  "mcpServers": {
    "database": {
      "command": "mcp-database-service",
      "args": [
        "--config",
        "C:\\path\\to\\databases.json"
      ]
    }
  }
}
```

## Config Reload

- The server loads the JSON config file at startup and keeps a validated in-memory snapshot.
- The server also watches the same JSON file and automatically reloads it after on-disk changes are detected.
- Automatic reload is debounced to avoid reloading half-written files too aggressively.
- You can still use `reload_config` to force a manual reload without restarting the process.
- Reload is atomic: if the new file is invalid, the old in-memory configuration remains active.
- `show_loaded_config` can be used to inspect the current config path, load time, and configured database targets.
- `show_loaded_config` also includes a sanitized connection summary for each target, such as host, port, databaseName or serviceName, user name, and Oracle client mode, but it never exposes passwords.

## Oracle Notes
- Thin mode is the default when `clientMode` is omitted.
- Thick mode requires `clientMode: "thick"` and a valid `clientLibDir`.
- All Oracle targets in one process must use the same client mode. Thick mode targets must also share the same `clientLibDir`.
- `analyze_query` is currently not supported for Oracle and will return `NOT_SUPPORTED`.

## Write Statements
- `execute_query` remains read-only and blocks non-query SQL.
- `execute_statement` is intended for writable SQL targets only.
- `execute_statement` requires `readonly: false` on the target database config.
- Before executing a non-query SQL statement, the server asks the MCP client for explicit user confirmation through MCP elicitation when the client supports it.
- If the MCP client does not support elicitation, `execute_statement` automatically falls back to a two-step confirmation flow: the first call returns confirmation details and a `confirmationId`, and the second call must resend the same SQL with `confirmationId` and `confirmExecution: true` after the user confirms.
- `execute_statement` confirmation includes SQL type, target object, SQL preview, parameter preview, and risk hints for dangerous statements.
