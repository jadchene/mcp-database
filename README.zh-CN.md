[English](./README.md) | 简体中文

# MCP Database Service

一个基于 TypeScript 实现的多数据库 MCP 服务，面向 Model Context Protocol (MCP)。

它支持 MySQL、PostgreSQL、Oracle、openGauss 和 Redis，提供懒连接、读为主的数据库工具、SQL 执行计划分析、配置热刷新，以及带保护机制的写操作执行。

这个项目适合需要安全地做数据库发现、查询、性能分析和受控写操作的 AI agent 与 MCP client。

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

## Skill 集成（推荐）

对于 Codex、Gemini 等 AI 助手，仓库内已提供 `database-mcp` skill，配合使用可显著提升流程一致性与写操作安全性。

- Skill 路径：`skills/database-mcp/SKILL.md`
- 主要收益：
  - 统一数据库发现与表结构检查流程
  - 默认查询优先，结果规模与列选择更安全
  - 写操作遵循清晰的两步确认纪律

若你的 AI 客户端支持 Skills，建议在调用 database MCP 工具前先加载该 skill。

## 支持矩阵

| 数据库 | 查询工具 | 元数据工具 | `explain_query` | `analyze_query` | 写操作支持 |
| --- | --- | --- | --- | --- | --- |
| MySQL | 是 | 是 | 是 | 是 | 是 |
| PostgreSQL | 是 | 是 | 是 | 是 | 是 |
| openGauss | 是 | 是 | 是 | 是 | 是 |
| Oracle | 是 | 是 | 是 | 否 | 是 |
| Redis | 是 | 仅 Redis 专用工具 | 否 | 否 | 否 |

补充说明：
- show_create_table 当前支持 MySQL 和 Oracle；PostgreSQL 与 openGauss 目前会返回 NOT_SUPPORTED。
- `show_variables`、`find_long_running_queries`、`find_blocking_sessions`、`show_locks` 这类运行态排障工具依赖数据库账号可见性和权限，结果可能为空或受限。

## 支持的数据库
- MySQL
- Oracle
- PostgreSQL
- openGauss（通过 PostgreSQL 协议兼容）
- Redis

## 特性
- 单个配置文件中支持多个数据库目标
- 支持可选的文件日志，可自定义输出目录
- 无需重启服务即可手动刷新配置
- JSON 配置文件变更后自动热刷新
- 对查询工具进行严格只读限制
- 可写目标支持显式确认后的写操作
- 每次请求使用懒连接，并在完成后保证关闭
- 为 SQL 数据库提供元数据发现工具
- 为 Redis 提供专用只读工具

## 配置
可以通过以下任一方式传入配置文件路径：

1. `node dist/index.js --config ./config/databases.json`
2. 设置 `MCP_DATABASE_CONFIG=/absolute/path/to/databases.json`

配置文件必须是一个 JSON 对象，其中顶层 `databases` 数组是必填项；`logging`、`query` 等顶层配置项是可选的。示例：

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
        "user": "root",
        "password": "secret",
        "connectTimeoutMs": 5000
      }
    }
  ]
}
```

`logging.enabled` 默认是 `false`。开启后，日志默认写入系统临时目录；你也可以通过 `logging.directory` 自定义目录，若填相对路径，则相对于配置文件所在目录解析。上面的示例会把日志写到 `./logs`。

`query.timeoutMs` 是可选项。配置后，服务会为数据库操作应用查询超时。上面的示例会在 `5000` 毫秒后超时。

Oracle 同时支持 Thin 和 Thick 模式。Thick 模式仍然使用同一个 `oracledb` 包，但要求宿主机安装 Oracle Instant Client。示例：

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

## 可用 MCP Tools
- `show_loaded_config`：查看当前内存中的配置路径、加载时间和所有已配置数据库目标
- `reload_config`：重新读取当前 JSON 配置文件，并在成功时原子替换内存配置
- `list_databases`：列出所有已配置目标的 key 和逻辑数据库名，不会打开数据库连接
- `ping_database`：测试某个已配置目标的连通性
- `list_schemas`：列出某个 SQL 目标下的 schema
- `list_tables`：列出某个 SQL schema 或默认 schema 下的表 / 视图
- `list_views`：列出某个 SQL schema 或默认 schema 下的视图
- `describe_table`：查看列信息，适合写 join、报表或优化 SQL 前使用
- `show_create_table`：在当前数据库支持时查看数据库侧的 DDL 定义
- `search_tables`：按部分名称搜索表或视图
- `search_columns`：按部分名称搜索 schema 下的列
- `list_indexes`：查看表索引，适合做性能分析
- `get_table_statistics`：查看近似行数、存储信息和数据库特定统计信息
- `show_variables`：查看数据库运行时参数
- `find_long_running_queries`：查看超过阈值的当前长时间运行会话
- `find_blocking_sessions`：查看当前阻塞关系
- `show_locks`：查看数据库当前可见的锁信息
- `execute_query`：执行只读 SQL 查询；传原始查询 SQL，不要传写 SQL
- `explain_query`：查看只读 SQL 的静态执行计划；传原始查询 SQL，不要传 `EXPLAIN ...`
- `analyze_query`：查看只读 SQL 的运行时分析；传原始查询 SQL，不要传 `EXPLAIN ANALYZE ...`
- `execute_statement`：在可写目标上执行非查询 SQL，但必须先经过显式确认
- `redis_get`：读取一个 Redis 字符串 key
- `redis_hgetall`：读取一个 Redis hash key
- `redis_scan`：按游标安全扫描 Redis key，可选 pattern

## 开发

```bash
npm install
npm run build
node dist/index.js --config ./config/databases.example.json
```

## 全局安装

本项目通过 `bin` 字段暴露了一个 CLI 命令：`mcp-database-service`。

推荐方式：

1. 直接从 npm 安装：

```powershell
npm install -g @jadchene/mcp-database-service
```

2. 或从本地源码树通过辅助脚本安装：

```powershell
pwsh -File .\scripts\install-global.ps1
```

Linux / macOS 可使用：

```bash
sh ./scripts/install-global.sh
```

这些脚本会安装依赖、构建项目、通过 `npm pack` 生成 tarball、再用 `npm install -g <tarball>` 全局安装，最后删除临时 tarball。它们不会使用 `npm link`。

3. 或手动安装打包产物：

```powershell
npm pack
npm install -g .\jadchene-mcp-database-service-0.1.5.tgz
```

由于 `files` 字段只发布运行时文件，所以打包安装时会包含 `dist`、运行时 README 和配置示例，而不是整个源码目录。

安装后可以这样启动：

```powershell
mcp-database-service --config .\config\databases.example.json
```

MCP 服务配置示例：

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

## 配置刷新

- 服务启动时会加载 JSON 配置文件，并保留一份校验通过的内存快照
- 服务也会监听同一个 JSON 文件，在磁盘变更后自动热刷新
- 自动刷新有防抖，避免在文件半写入状态下频繁重载
- 你仍然可以使用 `reload_config` 手动刷新，而无需重启进程
- 刷新是原子的：如果新文件无效，旧的内存配置会继续保持生效
- 可以用 `show_loaded_config` 查看当前配置路径、加载时间和已配置数据库目标
- `show_loaded_config` 也会返回当前日志开关状态、解析后的日志目录以及配置的查询超时
- `show_loaded_config` 还会返回脱敏后的连接摘要，例如 host、port、databaseName 或 serviceName、用户名以及 Oracle client mode，但不会暴露密码

## Oracle 说明
- 未配置 `clientMode` 时，默认使用 Thin 模式
- Thick 模式要求 `clientMode: "thick"`，并提供有效的 `clientLibDir`
- 同一进程中的所有 Oracle 目标必须使用相同的 client mode；如果使用 Thick，还必须共用同一个 `clientLibDir`
- Oracle 目前不支持 `analyze_query`，会返回 `NOT_SUPPORTED`

## 写操作说明
- `execute_query` 始终是只读的，会拦截非查询 SQL
- `execute_statement` 仅用于可写 SQL 目标
- `execute_statement` 要求目标配置为 `readonly: false`
- 如果 MCP client 支持交互确认，服务会在执行非查询 SQL 前通过 MCP elicitation 请求用户确认
- 如果 MCP client 不支持 elicitation，`execute_statement` 会自动退回到二段式确认流程：第一次调用返回确认详情和 `confirmationId`，用户确认后，第二次必须带上 `confirmationId` 和 `confirmExecution: true`，并重复同一条 SQL 才会真正执行
- `execute_statement` 的确认信息会包含 SQL 类型、目标对象、SQL 预览、参数预览，以及高风险语句的风险提示




