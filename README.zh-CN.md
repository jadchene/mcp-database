[English](./README.md) | 简体中文

# MCP Database Service

支持 MySQL、PostgreSQL、Oracle 和 Redis 的 MCP 服务，提供显式持久连接与跨调用 SQL 状态连续性。

## 安装

```powershell
npm install -g @jadchene/mcp-database-service
mcp-database-service --config ./config/databases.json
```

也可通过 MCP_DATABASE_CONFIG 指定配置文件。

## 配置

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

`enable` 默认 `true`。禁用目标保留在文件中，不展示在数据库列表或配置摘要中，也不能连接。配置自动热更新，也可调用 `reload_config`；无效更新保留上一份有效配置。禁用目标或更改连接/权限设置会使已有会话失效。

`sessionIdleTimeoutMs` 是空闲期限，默认 30 分钟；每次有效数据库操作结束后重新计时，不是从 connect 起固定倒计时。`maxSessions` 默认 32，连接中的条目也计入上限。SQL 执行超时与空闲过期独立。日志默认关闭；启用后默认写入系统临时目录，相对日志路径按配置文件目录解析。

## 支持的数据库

| 数据库 | SQL 查询 | SQL 写入 | 运行时分析 | SQL 脚本 |
| --- | --- | --- | --- | --- |
| MySQL | ✓ | ✓ | ✓ | ✓ |
| PostgreSQL | ✓ | ✓ | ✓ | — |
| Oracle | ✓ | ✓ | — | — |
| Redis | — | — | — | — |

SQL 写入需目标授权。Redis 支持 GET、HGETALL、SCAN 和连接探测。

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

只有 `connect` 能建立连接。其他数据库操作必须传 `sessionId`，不再接受 databaseKey 调用。复用同一个 ID 可保持变量、临时表、当前 schema 及事务；独立调用能延续状态，不必使用脚本。

```text
connect({ databaseKey: "main-mysql" }) → sessionId = S
execute_statement({ sessionId: S, sql: "SET @x = 123" })
execute_query({ sessionId: S, sql: "SELECT @x" }) → 123
get_transaction_status({ sessionId: S })
disconnect({ sessionId: S })
```

SET 示例要求目标配置为 `readonly: false` 或 `dangerMode: true`。

同会话并发或执行中断开返回 `SESSION_BUSY`，不同会话可并行。空闲到期、断线或服务重启后 ID 失效，需要显式重新 connect；不自动重连或重放 SQL。长操作执行期间不因空闲过期而断开。

通过 `execute_statement` 使用引擎原生 SQL 开启事务，使用提交/回滚工具或原生 SQL结束。查询工具不再隐藏开启、提交或回滚事务。结果只在 `structuredContent` 返回一次。普通 SQL 附带最小的 transaction.state，SQL 出错也返回可确认的状态；get_transaction_status 额外返回 autoCommit。状态为 none、active、failed、unknown；Redis 的专用状态查询返回 not_supported，普通读取不附加 SQL 事务信息。sessionId 和空闲期限只在 connect 返回，不重复输出内部版本、时间戳或到期日期。

`execute_script` 默认参与当前事务。`useTransaction: true` 显式请求脚本事务，已有事务或脚本包含事务控制/autocommit 修改时拒绝；失败时只回滚脚本自行开启的事务。DDL 隐式提交遵循引擎规则。断线或写入超时可能返回 EXECUTION_OUTCOME_UNKNOWN，不自动重放。

## 写入与审批

SQL 目标保留原有 readonly 配置。可写目标的语句、脚本及非空事务提交需要交互式 Accept / Decline / Cancel 审批；回滚不额外请求写入审批。审批绑定目标和会话版本，等待期间过期或状态变化会阻止执行。不支持 elicitation 的客户端不能执行需要审批的操作。

`dangerMode: true` 为该目标启用 Full Access，覆盖只读设置并跳过人工/自动审批，返回结果带 Full Access 警告。普通模式下 codexAutoReview: true 添加 Codex 审批元数据。两个字段默认 false；SQL 校验和数据库账号权限仍生效。

`execute_query` 拒绝非查询、加锁、文件输出及多语句 SQL。查询保护不能替代数据库账号权限限制，尤其是带副作用的函数或过程。配置发现不返回密码；日志仅记录 SQL 指纹和参数数量，不记录 SQL 正文或参数值。

## Oracle

默认使用 Thin 模式。Thick 模式配置 connection.clientMode: "thick"，并用 connection.clientLibDir 指定 Oracle Instant Client。启用的 Oracle 目标须使用相同模式和库目录。Oracle DML 手动提交，使用 commit_transaction 或 rollback_transaction。analyze_query 不支持；explain_query 要求活动事务，用保存点清理执行计划，不结束外层事务。

## 开发

```powershell
npm install
npm run build
npm test
npm run verify:reload
npm run verify:package
```

Agent Skill: [database-mcp](./skills/database-mcp/SKILL.md).
