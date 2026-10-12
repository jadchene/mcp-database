/**
 * 数据库实际事务状态，不将自动提交设置等同于活动事务。
 * @author chenjd
 * @created 2026-10-12 15:00:00
 */
export interface TransactionStatus {
  /** 数据库确认的当前状态。 */
  state: "none" | "active" | "failed" | "unknown" | "not_supported";
  /** 引擎或驱动的自动提交设置；不能确认时为空。 */
  autoCommit: boolean | null;
  /** 本次观察时间。 */
  observedAt: string;
}

/** 创建带观察时间的状态快照。 */
export function transactionStatus(state: TransactionStatus["state"], autoCommit: boolean | null = null): TransactionStatus {
  return { state, autoCommit, observedAt: new Date().toISOString() };
}
