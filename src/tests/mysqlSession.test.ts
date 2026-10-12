import test from "node:test";
import assert from "node:assert/strict";
import mysql from "mysql2";
import type { AddressInfo } from "node:net";
import { MysqlAdapter } from "../db/sql/mysqlClient.js";
import type { MysqlDatabaseConfig } from "../config/configTypes.js";

test("real mysql2 protocol preserves connection, variables and transactions after truncated reads", { timeout: 10000 }, async () => {
  const server = mysql.createServer(() => {}) as any;
  const peers: any[] = [];
  let connections = 0;
  server.on("connection", (connection: any) => {
    connections++;
    peers.push(connection);
    let active = false;
    let value = 0;
    const flags = () => (active ? 1 : 0) | 2;
    connection.on("error", () => {});
    connection.serverHandshake({ protocolVersion: 10, serverVersion: "8.0.fixture", connectionId: connections, statusFlags: 2, characterSet: 33, capabilityFlags: 0x00088201 });
    // 服务端夹具按每个客户端命令重置序号，避免复用连接时累计包序号。
    const handlePacket = connection.handlePacket;
    connection.handlePacket = function(packet: any) {
      if (packet.sequenceId === 0 && this._command?.next?.name === "dispatchCommands") this.sequenceId = 0;
      return handlePacket.call(this, packet);
    };
    connection.on("ping", () => connection.writeOk({ affectedRows: 0, serverStatus: flags() }));
    connection.on("quit", () => connection.stream.end());
    const respond = (sql: string) => {
      if (/^(?:START TRANSACTION|BEGIN)/i.test(sql)) active = true;
      if (/^(?:COMMIT|ROLLBACK)/i.test(sql)) active = false;
      if (/^SET @x/i.test(sql)) value = Number(sql.split("=")[1]);
      if (/^SELECT/i.test(sql)) {
        connection.writeColumns([{ catalog: "def", schema: "fixture", table: "", orgTable: "", name: "value", orgName: "", characterSet: 33, columnLength: 32, columnType: 3, flags: 0, decimals: 0 }]);
        const values = sql.includes("UNION") ? [1, 2, 3, 4] : [sql.includes("@x") ? value : connections];
        for (const item of values) connection.writeTextRow([String(item)]);
        connection.writeEof(0, flags());
      } else connection.writeOk({ affectedRows: 0, serverStatus: flags() });
    };
    connection.on("query", respond);
    connection.on("stmt_prepare", respond);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server._server.address() as AddressInfo).port;
  const config: MysqlDatabaseConfig = { key: "wire", type: "mysql", readonly: false, connection: { host: "127.0.0.1", port, databaseName: "fixture", user: "test", password: "", connectTimeoutMs: 1000 } };
  const adapter = new MysqlAdapter(config, 1000);
  try {
    await adapter.connect();
    assert.equal((await adapter.getTransactionStatus()).state, "none");
    await adapter.executeStatement("SET @x = 123");
    await adapter.executeStatement("START TRANSACTION");
    assert.equal((await adapter.getTransactionStatus()).state, "active");
    const limited = await adapter.executeQuery("SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4", [], 2);
    assert.equal(limited.truncated, true);
    assert.deepEqual(limited.rows, [{ value: 1 }, { value: 2 }]);
    assert.equal((await adapter.getTransactionStatus()).state, "active");
    assert.deepEqual((await adapter.executeQuery("SELECT @x", [], 2)).rows, [{ value: 123 }]);
    await assert.rejects(() => adapter.executeScript("SET @x = 2", { useTransaction: true }), /existing transaction/);
    assert.equal((await adapter.getTransactionStatus()).state, "active");
    assert.equal((await adapter.rollbackTransaction()).outcome, "rolled_back");
    assert.equal((await adapter.getTransactionStatus()).state, "none");
    assert.equal((await adapter.commitTransaction()).outcome, "no_transaction");
    assert.equal(connections, 1);
  } finally {
    await adapter.close();
    for (const peer of peers) peer.stream.destroy();
    await new Promise<void>(resolve => server.close(resolve));
  }
});
