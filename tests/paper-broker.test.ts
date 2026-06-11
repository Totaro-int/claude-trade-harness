import { describe, it, expect, beforeEach } from 'vitest';
import { PaperBroker } from '../src/broker/paper.js';
import type { Quote } from '../src/core/types.js';

function quote(symbol: string, price: number): Quote {
  return {
    symbol, name: symbol, price,
    bid: Math.round(price * 0.999), ask: Math.round(price * 1.001),
    changeRate: 0, volume: 1000,
  };
}

const quotes = new Map([['005930', quote('005930', 70_000)]]);

describe('PaperBroker 시장가', () => {
  let broker: PaperBroker;
  beforeEach(() => {
    broker = new PaperBroker({ initialCash: 1_000_000, feeRate: 0.00015, taxRate: 0.0018, halfSpreadPct: 0 });
  });

  it('시장가 매수: 매도호가(ask)로 체결, 수수료 차감, 포지션 생성', () => {
    const r = broker.submit(
      { side: 'BUY', symbol: '005930', name: '삼성전자', quantity: 10, orderType: 'MARKET' },
      quotes,
    );
    const ask = 70_070; // 70000 * 1.001
    const fee = Math.round(ask * 10 * 0.00015);
    expect(r.status).toBe('FILLED');
    expect(r.fillPrice).toBe(ask);
    expect(r.fee).toBe(fee);
    expect(broker.cash).toBe(1_000_000 - ask * 10 - fee);
    expect(broker.positions).toEqual([
      expect.objectContaining({ symbol: '005930', name: '삼성전자', quantity: 10, avgPrice: ask }),
    ]);
  });

  it('현금 부족 시 거부', () => {
    const r = broker.submit(
      { side: 'BUY', symbol: '005930', name: '삼성전자', quantity: 100, orderType: 'MARKET' },
      quotes,
    );
    expect(r.status).toBe('REJECTED');
    expect(r.reason).toContain('현금 부족');
    expect(broker.cash).toBe(1_000_000);
  });

  it('시장가 매도: 매수호가(bid)로 체결, 수수료+거래세 차감, 포지션 감소', () => {
    broker.submit({ side: 'BUY', symbol: '005930', name: '삼성전자', quantity: 10, orderType: 'MARKET' }, quotes);
    const cashAfterBuy = broker.cash;
    const r = broker.submit(
      { side: 'SELL', symbol: '005930', name: '삼성전자', quantity: 4, orderType: 'MARKET' },
      quotes,
    );
    const bid = 69_930; // 70000 * 0.999
    const proceeds = bid * 4;
    const fee = Math.round(proceeds * 0.00015);
    const tax = Math.round(proceeds * 0.0018);
    expect(r.status).toBe('FILLED');
    expect(r.tax).toBe(tax);
    expect(broker.cash).toBe(cashAfterBuy + proceeds - fee - tax);
    expect(broker.positions[0].quantity).toBe(6);
  });

  it('보유량 초과 매도 거부 / 전량 매도 시 포지션 제거', () => {
    broker.submit({ side: 'BUY', symbol: '005930', name: '삼성전자', quantity: 5, orderType: 'MARKET' }, quotes);
    expect(
      broker.submit({ side: 'SELL', symbol: '005930', name: '삼성전자', quantity: 6, orderType: 'MARKET' }, quotes).status,
    ).toBe('REJECTED');
    broker.submit({ side: 'SELL', symbol: '005930', name: '삼성전자', quantity: 5, orderType: 'MARKET' }, quotes);
    expect(broker.positions).toEqual([]);
  });

  it('추가 매수 시 평단가 가중평균', () => {
    broker.submit({ side: 'BUY', symbol: '005930', name: '삼성전자', quantity: 5, orderType: 'MARKET' }, quotes);
    broker.submit({ side: 'BUY', symbol: '005930', name: '삼성전자', quantity: 5, orderType: 'MARKET' }, quotes);
    expect(broker.positions[0].avgPrice).toBe(70_070);
    expect(broker.positions[0].quantity).toBe(10);
  });

  it('equity = 현금 + 보유평가액', () => {
    broker.submit({ side: 'BUY', symbol: '005930', name: '삼성전자', quantity: 10, orderType: 'MARKET' }, quotes);
    expect(broker.equity(quotes)).toBe(broker.cash + 70_000 * 10);
  });

  it('toJSON/fromJSON 라운드트립으로 상태 복원', () => {
    broker.submit({ side: 'BUY', symbol: '005930', name: '삼성전자', quantity: 10, orderType: 'MARKET' }, quotes);
    const restored = PaperBroker.fromJSON(broker.toJSON(), { feeRate: 0.00015, taxRate: 0.0018, halfSpreadPct: 0 });
    expect(restored.cash).toBe(broker.cash);
    expect(restored.positions).toEqual(broker.positions);
  });
});

describe('PaperBroker 지정가', () => {
  let broker: PaperBroker;
  beforeEach(() => {
    broker = new PaperBroker({ initialCash: 1_000_000, feeRate: 0.00015, taxRate: 0.0018, halfSpreadPct: 0 });
  });

  it('미도달 지정가 매수는 PENDING으로 대기', () => {
    const r = broker.submit(
      { side: 'BUY', symbol: '005930', name: '삼성전자', quantity: 5, orderType: 'LIMIT', limitPrice: 68_000 },
      quotes,
    );
    expect(r.status).toBe('PENDING');
    expect(broker.pendingOrders).toHaveLength(1);
    expect(broker.cash).toBe(1_000_000); // 체결 전 현금 변화 없음
  });

  it('즉시 체결 가능한 지정가 매수는 바로 체결', () => {
    const r = broker.submit(
      { side: 'BUY', symbol: '005930', name: '삼성전자', quantity: 5, orderType: 'LIMIT', limitPrice: 71_000 },
      quotes,
    );
    expect(r.status).toBe('FILLED');
    expect(r.fillPrice).toBe(70_070); // ask
  });

  it('onTick에서 가격 도달 시 지정가로 체결', () => {
    broker.submit(
      { side: 'BUY', symbol: '005930', name: '삼성전자', quantity: 5, orderType: 'LIMIT', limitPrice: 68_000 },
      quotes,
    );
    const dropped = new Map([['005930', quote('005930', 67_500)]]);
    const fills = broker.onTick(dropped);
    expect(fills).toHaveLength(1);
    expect(fills[0].result.fillPrice).toBe(68_000);
    expect(broker.pendingOrders).toHaveLength(0);
    expect(broker.positions[0].quantity).toBe(5);
  });

  it('cancelAllPending이 미체결 주문을 전부 제거', () => {
    broker.submit(
      { side: 'BUY', symbol: '005930', name: '삼성전자', quantity: 5, orderType: 'LIMIT', limitPrice: 68_000 },
      quotes,
    );
    const canceled = broker.cancelAllPending();
    expect(canceled).toHaveLength(1);
    expect(broker.pendingOrders).toHaveLength(0);
  });

  it('onTick에서 대기 SELL 지정가가 가격 도달 시 체결', () => {
    broker.submit({ side: 'BUY', symbol: '005930', name: '삼성전자', quantity: 5, orderType: 'MARKET' }, quotes);
    const r = broker.submit(
      { side: 'SELL', symbol: '005930', name: '삼성전자', quantity: 5, orderType: 'LIMIT', limitPrice: 72_000 },
      quotes,
    );
    expect(r.status).toBe('PENDING');
    const risen = new Map([['005930', quote('005930', 72_500)]]);
    const fills = broker.onTick(risen);
    expect(fills).toHaveLength(1);
    expect(fills[0].result.fillPrice).toBe(72_000);
    expect(broker.positions).toEqual([]);
  });

  it('체결 시점에 현금이 부족한 대기 매수는 큐에 유지된다 (소실 금지)', () => {
    // 1) 여유 있을 때 지정가 매수 대기
    broker.submit(
      { side: 'BUY', symbol: '005930', name: '삼성전자', quantity: 5, orderType: 'LIMIT', limitPrice: 68_000 },
      quotes,
    );
    // 2) 시장가 매수로 현금 소진 (13주 ≈ 911k → 잔액 ≈ 89k < 340k)
    broker.submit({ side: 'BUY', symbol: '005930', name: '삼성전자', quantity: 13, orderType: 'MARKET' }, quotes);
    // 3) 가격 도달 틱 — 체결 불가 → 큐 유지, FILLED 없음
    const dropped = new Map([['005930', quote('005930', 67_500)]]);
    const fills = broker.onTick(dropped);
    expect(fills).toHaveLength(0);
    expect(broker.pendingOrders).toHaveLength(1);
  });

  it('toJSON/fromJSON이 pending과 nextOrderId까지 보존', () => {
    broker.submit(
      { side: 'BUY', symbol: '005930', name: '삼성전자', quantity: 5, orderType: 'LIMIT', limitPrice: 68_000 },
      quotes,
    );
    const restored = PaperBroker.fromJSON(broker.toJSON(), { feeRate: 0.00015, taxRate: 0.0018, halfSpreadPct: 0 });
    expect(restored.pendingOrders).toEqual(broker.pendingOrders);
    expect(restored.toJSON().nextOrderId).toBe(broker.toJSON().nextOrderId);
  });

  it('equity는 시세 없는 보유 종목을 평단가로 평가', () => {
    broker.submit({ side: 'BUY', symbol: '005930', name: '삼성전자', quantity: 5, orderType: 'MARKET' }, quotes);
    const empty = new Map<string, Quote>();
    expect(broker.equity(empty)).toBe(broker.cash + 70_070 * 5);
  });
});

describe('half-spread & thesis', () => {
  const q = (over: Partial<Quote> = {}): Quote =>
    ({ symbol: 'A', name: 'A', price: 100000, bid: 100000, ask: 100000, changeRate: 0, volume: 0, ...over });
  const mkBroker = () => new PaperBroker({ initialCash: 10_000_000, feeRate: 0, taxRate: 0, halfSpreadPct: 0.001 });

  it('bid==ask이면 MARKET 매수는 price*(1+half)로 체결', () => {
    const b = mkBroker();
    const r = b.submit({ side: 'BUY', symbol: 'A', name: 'A', quantity: 1, orderType: 'MARKET' }, new Map([['A', q()]]));
    expect(r.fillPrice).toBe(100100); // 100000 * 1.001
  });

  it('bid!=ask이면 기존처럼 호가로 체결', () => {
    const b = mkBroker();
    const r = b.submit({ side: 'BUY', symbol: 'A', name: 'A', quantity: 1, orderType: 'MARKET' },
      new Map([['A', q({ bid: 99900, ask: 100200 })]]));
    expect(r.fillPrice).toBe(100200);
  });

  it('setThesis로 포지션에 thesis 저장, toJSON/fromJSON 왕복 보존', () => {
    const b = mkBroker();
    b.submit({ side: 'BUY', symbol: 'A', name: 'A', quantity: 1, orderType: 'MARKET' }, new Map([['A', q()]]));
    b.setThesis('A', { why: 'w', target: '+6%', stop: '-3%', exitCondition: 'x' });
    const restored = PaperBroker.fromJSON(b.toJSON(), { feeRate: 0, taxRate: 0, halfSpreadPct: 0.001 });
    expect(restored.positions[0]!.thesis?.target).toBe('+6%');
  });

  it('bid==ask이면 MARKET 매도는 price-spread로 체결 (half-spread)', () => {
    const b = mkBroker();
    // 먼저 매수로 포지션 확보 (bid==ask, price=100000 → fillPrice=100100)
    b.submit({ side: 'BUY', symbol: 'A', name: 'A', quantity: 1, orderType: 'MARKET' }, new Map([['A', q()]]));
    // 매도: bid==ask, price=100000 → spread=Math.round(100000*0.001)=100 → fillPrice=99900
    const r = b.submit({ side: 'SELL', symbol: 'A', name: 'A', quantity: 1, orderType: 'MARKET' }, new Map([['A', q()]]));
    expect(r.fillPrice).toBe(99900);
  });

  it('존재하지 않는 심볼에 setThesis하면 false 반환', () => {
    const b = mkBroker();
    expect(b.setThesis('UNKNOWN', { why: 'w', target: '+5%', stop: '-2%', exitCondition: 'x' })).toBe(false);
  });
});
