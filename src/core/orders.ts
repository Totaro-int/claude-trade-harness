import type { Decision, OrderRequest, Quote } from './types.js';

/**
 * 두뇌 Decision을 주문 요청으로 변환한다. 필드 불완전(symbol/quantity/orderType 누락,
 * LIMIT인데 limitPrice 없음) 시 null. cycle.ts(라이브)와 backtest/runner.ts가 공유한다(발산 방지).
 */
export function toOrder(d: Decision, quotes: Map<string, Quote>): OrderRequest | null {
  if (!d.symbol || d.quantity == null || d.quantity <= 0 || !d.orderType) return null;
  if (d.orderType === 'LIMIT' && !d.limitPrice) return null;
  const name = quotes.get(d.symbol)?.name ?? d.symbol;
  return { side: d.action as 'BUY' | 'SELL', symbol: d.symbol, name, quantity: d.quantity, orderType: d.orderType, limitPrice: d.limitPrice };
}
