import { describe, it, expect } from 'vitest';
import { wrapAdapter, type BrokerAdapter } from '../src/broker/adapter.js';

const goodQuote = { symbol: '005930', name: '삼성전자', price: 70000, bid: 69900, ask: 70100, changeRate: 1.2, volume: 1000 };

function fake(overrides: Partial<BrokerAdapter> = {}): BrokerAdapter {
  return {
    id: 'fake',
    auth: async () => {},
    getQuotes: async () => [goodQuote],
    getBalance: async () => ({ cash: 1_000_000, positions: [] }),
    isMarketOpen: async () => true,
    ...overrides,
  };
}

describe('wrapAdapter', () => {
  it('정상 응답은 그대로 통과', async () => {
    const a = wrapAdapter(fake());
    expect(await a.getQuotes(['005930'])).toEqual([goodQuote]);
    expect((await a.getBalance()).cash).toBe(1_000_000);
  });

  it('스키마 위반 응답은 AdapterContractError', async () => {
    const a = wrapAdapter(fake({ getQuotes: async () => [{ symbol: '005930', price: 'oops' }] as never }));
    await expect(a.getQuotes(['005930'])).rejects.toThrow(/어댑터 응답이 규격에 맞지 않습니다/);
  });

  it('가격이 NaN/음수면 거부', async () => {
    const a = wrapAdapter(fake({ getQuotes: async () => [{ ...goodQuote, price: -1 }] }));
    await expect(a.getQuotes(['005930'])).rejects.toThrow();
  });

  it('선택 메서드가 없으면 wrapped에도 없음', () => {
    const a = wrapAdapter(fake());
    expect(a.getCandles).toBeUndefined();
  });

  it('submitOrder가 규격에 맞지 않는 응답을 반환하면 AdapterContractError', async () => {
    const a = wrapAdapter(fake({ submitOrder: async () => ({ status: 'ACCEPTED' }) as never }));
    await expect(a.submitOrder!({ symbol: '005930', name: '삼성전자', side: 'BUY', quantity: 1, orderType: 'MARKET' })).rejects.toThrow(/어댑터 응답이 규격에 맞지 않습니다/);
  });

  it('bid가 없는 불완전한 quote는 거부', async () => {
    const { bid: _omit, ...noBid } = goodQuote;
    const a = wrapAdapter(fake({ getQuotes: async () => [noBid] as never }));
    await expect(a.getQuotes(['005930'])).rejects.toThrow(/어댑터 응답이 규격에 맞지 않습니다/);
  });
});
