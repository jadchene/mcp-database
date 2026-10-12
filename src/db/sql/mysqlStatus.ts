/**
 * 从 MySQL COM_PING 的 OK 包读取状态；不执行 SQL，不改变事务。
 * @author chenjd
 * @created 2026-10-12 15:00:00
 */
export interface MysqlPacket { buffer: Buffer; offset: number; end: number }

/** 解析协议 4.1 OK 响应中的状态标记，异常包不猜测状态。 */
export function readMysqlOkStatus(packet: MysqlPacket): number | null {
  const { buffer, end } = packet;
  let offset = packet.offset;
  if (buffer[offset++] !== 0) return null;
  for (let index = 0; index < 2; index++) {
    const marker = buffer[offset];
    if (marker === undefined || marker === 0xfb || marker === 0xff) return null;
    offset += marker < 0xfb ? 1 : marker === 0xfc ? 3 : marker === 0xfd ? 4 : 9;
  }
  return offset + 2 <= end ? buffer.readUInt16LE(offset) : null;
}
