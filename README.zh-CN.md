[English](./README.md) | 简体中文

# MCP Database Service

支持 MySQL、PostgreSQL、Oracle 和 Redis 的 MCP 服务，提供显式持久连接与跨调用 SQL 状态连续性。

## 快速开始

准备 Node.js 24 或更高版本，安装服务：

```powershell
npm install -g @jadchene/mcp-database-service
```

将下方配置保存为 `databases.json`，修改连接信息，接入时使用该文件的绝对路径。

Codex：

```powershell
codex mcp add database -- mcp-database-service --config /absolute/path/databases.json
```

Claude Code：

```powershell
claude mcp add database -- mcp-database-service --config /absolute/path/databases.json
```

Windows 可使用 `C:/mcp/database/databases.json` 这样的路径。客户端会启动 stdio 服务，无需单独运行后台进程或配置 HTTP 端口。也可通过 `MCP_DATABASE_CONFIG` 指定配置文件；服务没有默认配置路径。

需要统一接入多个 MCP 服务时，可通过 [MCP Gateway](https://github.com/jadchene/mcp-gateway) 连接。

## 配置

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

同一份配置也提供于 [databases.example.json](config/databases.example.json)。保留需要的目标，修改连接信息后将 `enable` 设为 `true`。Oracle Thin 模式使用 `"clientMode": "thin"` 并移除 `clientLibDir`；Redis 无需认证时可省略 `username` 和 `password`。配置值按原文读取，不会展开 `${VAR}` 占位符。

`enable: false` 隐藏目标并关闭其会话。配置自动重载，也可调用 `reload_config`；无效更新保留上一份配置，连接或权限变更会使已有会话失效。

超时字段单位为毫秒；空闲期限在操作结束后重新计时，`maxSessions` 包含连接中的会话。日志默认关闭，相对日志目录以配置目录为基准。

## 支持的数据库

| 数据库 | SQL 查询 | SQL 写入 | 运行时分析 | SQL 脚本 |
| --- | --- | --- | --- | --- |
| MySQL | ✓ | ✓ | ✓ | ✓ |
| PostgreSQL | ✓ | ✓ | ✓ | — |
| Oracle | ✓ | ✓ | — | — |
| Redis | — | — | — | — |

Redis 支持 GET、HGETALL、SCAN 和连接探测。

## 工具

| 工具 | 用途 |
| --- | --- |
| `list_databases` / `show_loaded_config` / `reload_config` | 列出启用目标，查看或重载脱敏配置。 |
| `connect` | 通过启用目标的 databaseKey 建立独立连接，返回 sessionId。 |
| `disconnect` | 关闭空闲会话，回滚未提交工作。 |
| `get_transaction_status` | 读取实际事务状态，不改变事务。 |
| `commit_transaction` | 提交当前 SQL 事务。 |
| `rollback_transaction` | 回滚当前整个 SQL 事务。 |
| `list_schemas` / `list_tables` / `describe_table` | 查询 schema、表和列。 |
| `list_indexes` / `get_table_statistics` / `show_create_table` | 查询索引、统计和 DDL。 |
| `list_views` / `search_tables` / `search_columns` | 列出视图或搜索表、列。 |
| `show_variables` / `find_long_running_queries` | 查看变量和长耗时查询。 |
| `find_blocking_sessions` / `show_locks` | 查看阻塞和锁，受引擎及账号权限限制。 |
| `execute_query` | 执行单条只读 SQL，支持参数与返回行数上限。 |
| `explain_query` / `analyze_query` | 查看静态计划或执行运行时分析；传原始 SQL。 |
| `execute_statement` | 执行单条非查询 SQL，包括 SET、USE、事务控制、DML 或 DDL。 |
| `execute_script` | 整段执行 MySQL 脚本，来源为 sql 或服务端 sqlFile（UTF-8，最大 2 MiB）。 |
| `redis_get` / `redis_hgetall` / `redis_scan` | 读取 string/hash 或用游标扫描 Redis key。 |

## 会话与事务

先用 `databaseKey` 调用 `connect`，后续操作复用返回的 `sessionId`，完成后调用 `disconnect`。同一会话保留变量、临时表、当前 schema 和事务。

同一会话按顺序调用；空闲过期、断线或服务重启后需重新连接。写入超时或断线时，先核实执行结果再重试。

通过 `execute_statement` 执行原生 SQL 开启事务，使用 `commit_transaction`、`rollback_transaction` 和 `get_transaction_status` 管理事务。查询不会自动提交或回滚事务。`execute_script` 默认沿用当前事务；无已有事务且脚本不含事务控制语句时，可用 `useTransaction: true` 单独开启脚本事务。DDL 遵循数据库自身的提交规则。

## 写入与审批

写入需将目标的 `readonly` 设为 `false`。语句、脚本及非空事务提交需由支持交互确认的客户端审批，回滚无需审批。

可选的 `codexAutoReview: true` 允许兼容的 Codex 客户端自动审查；`dangerMode: true` 覆盖只读限制并跳过审批。两项默认关闭，数据库账号权限始终有效。

## Oracle

同一进程中启用的 Oracle 目标须使用相同的客户端模式和库目录。DML 需手动提交；`explain_query` 要求已有活动事务。

## 开发

```powershell
npm install
npm run build
npm test
npm run verify:reload
npm run verify:package
```

Agent Skill: [database-mcp](./skills/database-mcp/SKILL.md).

## 许可证

[MIT](LICENSE)
