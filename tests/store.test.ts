import { describe, it, expect, beforeEach } from 'vitest';
import { Store } from '../src/core/store.js';

describe('Store', () => {
  let store: Store;
  beforeEach(() => {
    store = new Store(':memory:');
  });

  it('체결 기록 후 조회', () => {
    store.recordTrade({ ts: '2026-06-11T09:10:00+09:00', side: 'BUY', symbol: '005930', name: '삼성전자', quantity: 10, price: 70_070, fee: 105, tax: 0 });
    const trades = store.getTrades(10);
    expect(trades).toHaveLength(1);
    expect(trades[0].symbol).toBe('005930');
  });

  it('판단 기록 후 최신순 조회', () => {
    store.recordDecision({ ts: '2026-06-11T09:10:00+09:00', action: 'BUY', symbol: '005930', name: '삼성전자', quantity: 10, orderType: 'MARKET', limitPrice: null, reasoning: '근거1', status: 'FILLED', rejectReason: null, marketView: '강세', thesis: null });
    store.recordDecision({ ts: '2026-06-11T09:20:00+09:00', action: 'HOLD', symbol: null, name: null, quantity: null, orderType: null, limitPrice: null, reasoning: '관망', status: 'HOLD', rejectReason: null, marketView: '횡보', thesis: null });
    const ds = store.getDecisions(10);
    expect(ds[0].action).toBe('HOLD'); // 최신이 먼저
    expect(ds[1].reasoning).toBe('근거1');
  });

  it('자산 스냅샷 기록 후 시간순 조회', () => {
    store.recordSnapshot({ ts: '2026-06-11T09:10:00+09:00', equity: 10_000_000, cash: 9_000_000, dailyPnlPct: 0, benchmark: null });
    store.recordSnapshot({ ts: '2026-06-11T09:20:00+09:00', equity: 10_050_000, cash: 9_000_000, dailyPnlPct: 0.5, benchmark: null });
    const snaps = store.getSnapshots(100);
    expect(snaps).toHaveLength(2);
    expect(snaps[0].equity).toBe(10_000_000); // 시간순(과거→현재)
  });

  it('kv: 브로커 상태 저장/복원', () => {
    store.setKV('broker', JSON.stringify({ cash: 123 }));
    expect(JSON.parse(store.getKV('broker')!)).toEqual({ cash: 123 });
    expect(store.getKV('없는키')).toBeNull();
  });

  it('close 후에는 쿼리가 던져진다', () => {
    store.close();
    expect(() => store.getTrades(1)).toThrow();
  });

  it('getTrades limit이 동작한다', () => {
    for (let i = 0; i < 5; i++) {
      store.recordTrade({ ts: `2026-06-11T09:1${i}:00+09:00`, side: 'BUY', symbol: '005930', name: '삼성전자', quantity: 1, price: 70_000, fee: 1, tax: 0 });
    }
    expect(store.getTrades(3)).toHaveLength(3);
  });
});

describe('atomic & benchmark & thesis', () => {
  it('atomic 내부에서 throw하면 아무것도 기록되지 않는다', () => {
    const s = new Store(':memory:');
    expect(() => s.atomic(() => {
      s.recordTrade({ ts: 't', side: 'BUY', symbol: 'A', name: 'A', quantity: 1, price: 100, fee: 0, tax: 0 });
      throw new Error('boom');
    })).toThrow('boom');
    expect(s.getTrades(10)).toHaveLength(0);
  });

  it('snapshot에 benchmark 저장/조회', () => {
    const s = new Store(':memory:');
    s.recordSnapshot({ ts: 't', equity: 100, cash: 50, dailyPnlPct: 0, benchmark: 99.5 });
    expect(s.getSnapshots(1)[0]!.benchmark).toBe(99.5);
  });

  it('decision에 thesis JSON 저장/조회', () => {
    const s = new Store(':memory:');
    s.recordDecision({
      ts: 't', action: 'BUY', symbol: 'A', name: 'A', quantity: 1, orderType: 'MARKET',
      limitPrice: null, reasoning: 'r', status: 'FILLED', rejectReason: null, marketView: 'm',
      thesis: JSON.stringify({ why: 'w', target: '+6%', stop: '-3%', exitCondition: 'x' }),
    });
    expect(JSON.parse(s.getDecisions(1)[0]!.thesis!).target).toBe('+6%');
  });

  it('totalFees: 여러 체결의 fee+tax 합산', () => {
    const s = new Store(':memory:');
    s.recordTrade({ ts: 't1', side: 'BUY', symbol: 'A', name: 'A', quantity: 1, price: 100, fee: 100, tax: 50 });
    s.recordTrade({ ts: 't2', side: 'SELL', symbol: 'A', name: 'A', quantity: 1, price: 110, fee: 200, tax: 80 });
    expect(s.totalFees()).toBe(430);
  });
});
