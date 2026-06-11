import { describe, it, expect } from 'vitest';
import { checkOrder, type GuardrailContext } from '../src/guardrails/index.js';
import type { OrderRequest, Quote } from '../src/core/types.js';
import type { GuardrailLimits } from '../src/core/config.js';

const limits: GuardrailLimits = {
  maxPositionPct: 20, maxOrderPct: 10, maxOrdersPerCycle: 3, dailyLossLimitPct: 3,
  maxOrdersPerDay: 10, reentryCooldownMin: 60, maxTotalExposurePct: 80,
};

function ctx(over: Partial<GuardrailContext> = {}): GuardrailContext {
  const q: Quote = { symbol: '005930', name: '삼성전자', price: 70_000, bid: 69_930, ask: 70_070, changeRate: 0, volume: 1000 };
  return {
    equity: 10_000_000,
    positions: [],
    quotes: new Map([['005930', q]]),
    dailyPnlPct: 0,
    ordersThisCycle: 0,
    ordersToday: 0,
    lastSellAt: null,
    now: new Date(),
    totalPositionValue: 0,
    ...over,
  };
}

function buy(quantity: number, limitPrice?: number): OrderRequest {
  return { side: 'BUY', symbol: '005930', name: '삼성전자', quantity, orderType: limitPrice !== undefined ? 'LIMIT' : 'MARKET', limitPrice };
}

describe('checkOrder', () => {
  it('정상 주문은 허용', () => {
    expect(checkOrder(buy(10), ctx(), limits).allowed).toBe(true);
  });

  it('1회 주문 금액이 총자산의 10% 초과 시 거부', () => {
    // 70,070 * 15 = 1,051,050 > 1,000,000 (10%)
    const r = checkOrder(buy(15), ctx(), limits);
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('주문 금액');
  });

  it('체결 후 종목 비중이 20% 초과 시 거부', () => {
    const c = ctx({
      positions: [{ symbol: '005930', name: '삼성전자', quantity: 20, avgPrice: 70_000 }],
    });
    // 기존 140만 + 신규 70만 = 210만 > 200만 (20%)
    const r = checkOrder(buy(10), c, limits);
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('종목 비중');
  });

  it('사이클당 4번째 주문은 거부', () => {
    const r = checkOrder(buy(1), ctx({ ordersThisCycle: 3 }), limits);
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('주문 수');
  });

  it('일일 손실 -3% 도달 시 매수만 거부, 매도는 허용', () => {
    const c = ctx({
      dailyPnlPct: -3.5,
      positions: [{ symbol: '005930', name: '삼성전자', quantity: 5, avgPrice: 70_000 }],
    });
    expect(checkOrder(buy(1), c, limits).allowed).toBe(false);
    expect(checkOrder(buy(1), c, limits).reason).toContain('일일 손실');
    const sell: OrderRequest = { side: 'SELL', symbol: '005930', name: '삼성전자', quantity: 5, orderType: 'MARKET' };
    expect(checkOrder(sell, c, limits).allowed).toBe(true);
  });

  it('시세 없는 종목 거부', () => {
    const order: OrderRequest = { side: 'BUY', symbol: '999999', name: '없는종목', quantity: 1, orderType: 'MARKET' };
    expect(checkOrder(order, ctx(), limits).allowed).toBe(false);
  });

  it('NaN 지정가는 거부 (가드레일 우회 차단)', () => {
    const r = checkOrder(buy(1, NaN), ctx(), limits);
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('유효하지 않은 가격');
  });

  it('0/음수/비정수 수량은 거부', () => {
    expect(checkOrder(buy(0), ctx(), limits).allowed).toBe(false);
    expect(checkOrder(buy(-1), ctx(), limits).allowed).toBe(false);
    expect(checkOrder(buy(0.5), ctx(), limits).allowed).toBe(false);
  });

  it('equity가 0이면 모든 매수 거부 (fail-safe)', () => {
    expect(checkOrder(buy(1), ctx({ equity: 0 }), limits).allowed).toBe(false);
  });
});

describe('신규 가드레일', () => {
  const limits: GuardrailLimits = {
    maxPositionPct: 20, maxOrderPct: 10, maxOrdersPerCycle: 3, dailyLossLimitPct: 3,
    maxOrdersPerDay: 10, reentryCooldownMin: 60, maxTotalExposurePct: 80,
  };
  const quote: Quote = { symbol: 'A', name: 'A', price: 10000, bid: 10000, ask: 10000, changeRate: 0, volume: 0 };
  const baseCtx = (over: Partial<GuardrailContext> = {}): GuardrailContext => ({
    equity: 10_000_000, positions: [], quotes: new Map([['A', quote]]),
    dailyPnlPct: 0, ordersThisCycle: 0, ordersToday: 0, lastSellAt: null,
    now: new Date('2026-06-11T05:00:00Z'), totalPositionValue: 0, ...over,
  });
  const buy = { side: 'BUY' as const, symbol: 'A', name: 'A', quantity: 10, orderType: 'MARKET' as const };

  it('일일 주문 수 초과 시 거부', () => {
    expect(checkOrder(buy, baseCtx({ ordersToday: 10 }), limits).allowed).toBe(false);
  });

  it('재진입 쿨다운 내 매수 거부, 경과 후 허용', () => {
    const sold30minAgo = new Date('2026-06-11T04:30:00Z').toISOString();
    expect(checkOrder(buy, baseCtx({ lastSellAt: sold30minAgo }), limits).allowed).toBe(false);
    const sold2hAgo = new Date('2026-06-11T03:00:00Z').toISOString();
    expect(checkOrder(buy, baseCtx({ lastSellAt: sold2hAgo }), limits).allowed).toBe(true);
  });

  it('총 노출 상한 초과 거부', () => {
    expect(checkOrder(buy, baseCtx({ totalPositionValue: 7_950_000 }), limits).allowed).toBe(false);
  });

  it('쿨다운/일일상한은 SELL에 적용 안 됨', () => {
    const sell = { ...buy, side: 'SELL' as const };
    expect(checkOrder(sell, baseCtx({ ordersToday: 99, lastSellAt: new Date().toISOString() }), limits).allowed).toBe(true);
  });

  it('lastSellAt이 유효하지 않은 문자열이면 거부 (fail-safe)', () => {
    const r = checkOrder(buy, baseCtx({ lastSellAt: 'not-a-date' }), limits);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/유효하지 않음/);
  });

  it('lastSellAt이 미래 시각이면 쿨다운 이내로 취급하여 거부', () => {
    const futureIso = new Date('2026-06-11T06:00:00Z').toISOString(); // baseCtx.now(05:00)보다 1시간 뒤
    const r = checkOrder(buy, baseCtx({ lastSellAt: futureIso }), limits);
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('재진입 쿨다운');
  });
});
