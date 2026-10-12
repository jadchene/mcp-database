---
name: database-mcp
description: Use persistent database sessions, transaction tools, SQL scripts, and guarded writes.
---

# Database MCP

- Discover unknown enabled targets with list_databases. Pass databaseKey only to connect; reuse its sessionId in subsequent operations. Variables, temporary objects, current schema, and transactions persist across independent calls.
- Idle expiry slides from the last completed valid database operation. Running SQL suspends idle expiry; waiting for approval does not extend it. Await dependent calls sequentially. An expired ID requires explicit connect; never replay an uncertain write.
- Read structuredContent. Ordinary SQL returns transaction.state; get_transaction_status adds autoCommit. Unknown state is not an empty transaction. Session versions and expiration timestamps are internal.
- Start transactions with engine-native SQL through execute_statement; finish with commit_transaction or rollback_transaction. Oracle DML requires explicit commit. Redis has dedicated read tools and no SQL transaction support.
- execute_script is MySQL-only and accepts inline SQL or a server-local UTF-8 .sql file. useTransaction=true cannot wrap an existing transaction or transaction-control SQL; DDL follows engine implicit-commit rules.
- Outside dangerMode, writes and non-empty commits require interactive approval; rollback does not. Stop on decline/cancel or failed elicitation; do not invent fallback confirmation fields.
- Oracle analyze_query is unsupported; explain_query requires an active transaction. Disconnect unused sessions; disabling the target or changing its connection/permission settings invalidates old IDs.
