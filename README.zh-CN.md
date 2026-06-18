[English](./README.md) | 简体中文

# MCP Database Service

MCP Database Service 是一个 TypeScript 编写的 MCP 服务，让 AI Agent 可以通过一个 MCP 服务检查和查询多个数据库目标。

它支持 MySQL、PostgreSQL、openGauss、Oracle 和 Redis。SQL 目标默认只读，每次请求按需建立短连接，写入 SQL 必须经过明确确认。

## 功能

- 在一个 JSON 配置文件中管理多个命名数据库目标。
- 支持 MySQL、PostgreSQL、openGauss、Oracle 和 Redis。
- 只读查询工具会阻止写入 SQL。
- 提供 schema、表、列、索引、变量、锁和会话等元数据工具。
- 通过 `explain_query` 查看静态执行计划。
- 在支持的数据库上通过 `analyze_query` 查看运行时分析。
- 仅在显式配置为可写的目标上，通过 `execute_statement` 执行受控非查询 SQL。
- 支持手动和自动配置刷新，刷新失败时保留上一份有效配置。
- 支持可选文件日志，路径按配置文件位置解析。
- 每次请求使用短连接并在请求结束后清理。

## 为什么使用它

- 给 Agent 提供数据库可见性，不需要把凭据或临时 SQL 脚本散落在提示词里。
- 默认保持数据库操作只读，同时在目标显式允许时支持受控写入。
- 对不同 SQL 数据库使用一致的发现和查询流程。
- 在修改 SQL 或索引前先检查执行计划、锁和会话信息。

## 快速开始

从 npm 安装：

```powershell
npm install -g @jadchene/mcp-database-service
mcp-database-service --config ./config/databases.example.json
```

从源码运行：

```bash
npm install
npm run build
node dist/index.js --config ./config/databases.example.json
```

发布后的 CLI 命令是：

```text
mcp-database-service
```

## 配置

通过 CLI 参数指定配置文件：

```bash
mcp-database-service --config ./config/databases.json
```

或通过环境变量指定：

```bash
MCP_DATABASE_CONFIG=./config/databases.json mcp-database-service
```

最小 SQL 目标示例：

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

`logging.enabled` 默认为 `false`。启用后，如果没有设置 `logging.directory`，日志会写入系统临时目录。相对日志目录会按配置文件所在目录解析。

`query.timeoutMs` 是可选项。设置后，服务会把该超时时间应用到数据库操作上。

## 支持的数据库

| 数据库 | 查询 | 元数据 | `explain_query` | `analyze_query` | 写入 |
| --- | --- | --- | --- | --- | --- |
| MySQL | 支持 | 支持 | 支持 | 支持 | 支持 |
| PostgreSQL | 支持 | 支持 | 支持 | 支持 | 支持 |
| openGauss | 支持 | 支持 | 支持 | 支持 | 支持 |
| Oracle | 支持 | 支持 | 支持 | 不支持 | 支持 |
| Redis | 支持 | 有限支持 | 不支持 | 不支持 | 不支持 |

`show_create_table` 当前支持 MySQL 和 Oracle。PostgreSQL 与 openGauss 返回 `NOT_SUPPORTED`。

`show_variables`、`find_long_running_queries`、`find_blocking_sessions`、`show_locks` 等运维工具依赖数据库账号具备相应可见性和权限。

## MCP 工具

配置与发现：

| 工具 | 用途 |
| --- | --- |
| `show_loaded_config` | 查看当前配置路径、加载时间、日志状态、查询超时和脱敏连接摘要。 |
| `reload_config` | 重新加载当前 JSON 配置文件，只有校验成功才替换内存配置。 |
| `list_databases` | 列出已配置目标的 key、数据库名、类型和只读状态，不打开连接。 |
| `ping_database` | 测试某个已配置数据库目标的连通性。 |

SQL 元数据：

| 工具 | 用途 |
| --- | --- |
| `list_schemas` | 列出某个 SQL 目标可见的 schema。 |
| `list_tables` | 列出指定 schema 或默认 schema 下的表和视图。 |
| `list_views` | 列出指定 schema 或默认 schema 下的视图。 |
| `describe_table` | 查看表字段和类型，用于编写 join、报表或更新语句前的检查。 |
| `show_create_table` | 在支持的数据库上返回数据库侧 DDL。 |
| `search_tables` | 按名称片段搜索表和视图。 |
| `search_columns` | 在 schema 内按名称片段搜索字段。 |
| `list_indexes` | 查看某张表的索引。 |
| `get_table_statistics` | 返回近似行数、存储指标或数据库特定表统计信息。 |
| `show_variables` | 在支持且有权限时查看数据库运行变量。 |
| `find_long_running_queries` | 查找超过指定时长的当前运行会话。 |
| `find_blocking_sessions` | 查看数据库会话阻塞关系。 |
| `show_locks` | 查看数据库引擎暴露的锁信息。 |

SQL 执行与性能：

| 工具 | 用途 |
| --- | --- |
| `execute_query` | 执行一条只读 SQL 查询。会拒绝写入和多语句 SQL。 |
| `explain_query` | 返回只读 SQL 的静态执行计划。传原始 SQL，不要传 `EXPLAIN ...`。 |
| `analyze_query` | 在支持的数据库上返回只读 SQL 的运行时分析。传原始 SQL，不要传 `EXPLAIN ANALYZE ...`。 |
| `execute_statement` | 在可写目标上，经明确确认后执行一条非查询 SQL。 |

Redis：

| 工具 | 用途 |
| --- | --- |
| `redis_get` | 读取一个 Redis string key。 |
| `redis_hgetall` | 读取一个 Redis hash key。 |
| `redis_scan` | 使用游标扫描 Redis key，可带 pattern。 |

## 典型使用流程

1. 调用 `list_databases` 选择已配置的目标。
2. 调用 `list_schemas`、`search_tables` 或 `list_tables` 找到相关对象。
3. 编写 join 或优化 SQL 前，先调用 `describe_table` 和 `list_indexes`。
4. 使用 `execute_query` 执行只读 SQL。
5. 使用 `explain_query` 或 `analyze_query` 做性能分析。
6. 只有当目标可写且用户确认了精确变更后，才使用 `execute_statement`。

## 安全模型

- 读工具和写工具分离。只读 SQL 使用 `execute_query`，非查询 SQL 使用 `execute_statement`。
- `execute_query` 会经过只读 SQL guard。它会拒绝写入、未知语句类型和多语句 SQL。
- SQL 目标由每个 target 的 `readonly` 标志控制。当目标配置 `readonly: true` 时，`execute_statement` 会被拒绝。
- `execute_statement` 只接受非查询 SQL。它会拒绝 `SELECT` 和其他只读 SQL，确保读写流程分离。
- 可写 SQL 仅支持配置为 `readonly: false` 的 MySQL、Oracle、PostgreSQL 和 openGauss 目标。
- Redis 工具是只读取向，不暴露写操作。
- `show_loaded_config` 和发现工具只返回脱敏摘要。密码不会返回给 MCP 客户端。
- 配置刷新是原子的。新配置无效时，继续使用上一份已校验的内存配置。
- 连接按请求懒加载，并在请求结束后清理。

### 写入确认与两步 fallback

- `execute_statement` 执行前始终需要用户手动确认。
- 当 MCP 客户端支持 elicitation 时，服务会通过客户端直接请求确认。
- 当客户端不支持 elicitation 时，服务使用和其他高风险 MCP 工具一致的显式两步确认模型：第一次调用返回确认详情和 `confirmationId`；第二次调用必须重复相同的 `databaseKey`、`sql` 和 `params`，并携带该 `confirmationId` 与 `confirmExecution: true`。
- 服务会校验第二次调用是否与原始待确认请求完全匹配，然后才执行。
- 确认信息包含 SQL 类型、目标对象、SQL 预览、参数预览、风险等级，以及 `UPDATE` 或 `DELETE` 不带 `WHERE` 等危险语句的风险提示。

## 配置刷新

- 服务启动时加载并校验 JSON 配置。
- 配置文件发生变化后会自动重新加载。
- 自动刷新带防抖，避免读取写到一半的文件。
- 刷新是原子的：新配置无效时继续使用上一份内存配置。
- `reload_config` 可强制手动刷新。
- `show_loaded_config` 返回当前配置路径、加载时间、日志状态、查询超时和脱敏连接摘要。密码不会返回。

## Oracle 说明

Oracle 支持 Thin 和 Thick 模式。省略 `clientMode` 时默认使用 Thin 模式。

Thick 模式需要 Oracle Instant Client：

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

同一进程中的所有 Oracle 目标必须使用相同 client mode。Thick 模式目标也必须使用相同 `clientLibDir`。

Oracle 不支持 `analyze_query`，会返回 `NOT_SUPPORTED`。

## Skill 集成

仓库内包含一个用于更安全数据库工作流的 Agent skill：

- Skill 路径：`skills/database-mcp/SKILL.md`

当你的 Agent 支持 skills 时建议加载它。它会统一数据库发现、结果大小控制、先读后写默认行为和写入确认纪律。

## MCP 客户端配置

Codex：

```toml
[mcp_servers.database]
command = "mcp-database-service"
args = ["--config", "./config/databases.json"]
```

Gemini CLI：

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

Claude Code：

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

## 开发

```bash
npm install
npm run build
node dist/index.js --config ./config/databases.example.json
```

构建后运行测试：

```bash
npm test
```

## 从源码全局安装

Windows：

```powershell
pwsh -File .\scripts\install-global.ps1
```

Linux/macOS：

```bash
sh ./scripts/install-global.sh
```

辅助脚本会安装依赖、构建项目、用 `npm pack` 创建 tarball、全局安装该 tarball，然后删除临时 tarball。它们不使用 `npm link`。

## License

MIT. See [LICENSE](LICENSE).
