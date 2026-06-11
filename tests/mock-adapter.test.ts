import { describe, it, expect } from 'vitest';
import { MockAdapter } from '../src/broker/mock.js';

describe('MockAdapter', () => {
  const universe = [{ symbol: '005930', name: '삼성전자' }, { symbol: '000660', name: 'SK하이닉스' }];

  it('같은 seed면 같은 가격 시퀀스 (결정론)', async () => {
    const a = new MockAdapter(universe, 42);
    const b = new MockAdapter(universe, 42);
    expect(await a.getQuotes(['005930'])).toEqual(await b.getQuotes(['005930']));
  });

  it('advance()로 가격이 랜덤워크', async () => {
    const a = new MockAdapter(universe, 42);
    const before = (await a.getQuotes(['005930']))[0]!.price;
    a.advance();
    const after = (await a.getQuotes(['005930']))[0]!.price;
    expect(after).not.toBe(before);
    expect(Math.abs(after / before - 1)).toBeLessThan(0.011);
  });

  it('getBalance는 빈 계좌, isMarketOpen은 항상 true, getCandles 20개 반환', async () => {
    const a = new MockAdapter(universe, 1);
    expect((await a.getBalance()).positions).toEqual([]);
    expect(await a.isMarketOpen()).toBe(true);
    expect(await a.getCandles('005930', 'day', 20)).toHaveLength(20);
  });

  it('setPrice로 시나리오 주입', async () => {
    const a = new MockAdapter(universe, 1);
    a.setPrice('005930', 50000);
    expect((await a.getQuotes(['005930']))[0]!.price).toBe(50000);
  });
});
