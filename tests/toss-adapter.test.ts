import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createAdapter } from '../adapters/toss/adapter.js';
import { wrapAdapter, type AdapterEnv, type HttpClient } from '../src/broker/adapter.js';
import { checkAdapterSource } from '../src/setup/static-check.js';

const ENV: AdapterEnv = {
  apiKey: 'tsck_test_key_000000',
  apiSecret: 'tssk_test_secret_000000',
  accountNo: '12345678901',
  baseUrl: 'https://openapi.tossinvest.com',
};

interface Call { method: 'GET' | 'POST'; path: string; body?: unknown; headers?: Record<string, string> }

/** 경로(쿼리 제외)별 캔드 응답을 돌려주는 가짜 http. 호출을 기록한다. */
function fakeHttp(routes: Record<string, unknown>): { http: HttpClient; calls: Call[] } {
  const calls: Call[] = [];
  const lookup = (path: string): unknown => {
    const bare = path.split('?')[0]!;
    // 동적 경로(/orders/{id}/cancel)는 prefix 매칭
    const key = Object.keys(routes).find((k) => bare === k || bare.startsWith(k));
    if (key === undefined) throw new Error(`라우트 없음: ${path}`);
    return routes[key];
  };
  const http: HttpClient = {
    get: async (path, init) => { calls.push({ method: 'GET', path, headers: init?.headers }); return lookup(path); },
    post: async (path, body, init) => { calls.push({ method: 'POST', path, body, headers: init?.headers }); return lookup(path); },
  };
  return { http, calls };
}

const TOKEN_OK = { access_token: 'tok-abc', token_type: 'Bearer', expires_in: 86400 };
const ACCOUNTS_OK = { result: [{ accountNo: '12345678901', accountSeq: 7, accountType: 'BROKERAGE' }] };

function baseRoutes(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { '/oauth2/token': TOKEN_OK, '/api/v1/accounts': ACCOUNTS_OK, ...extra };
}

describe('toss adapter — 정적 검사', () => {
  it('생성 어댑터 소스가 static-check를 통과한다', () => {
    const src = readFileSync(resolve(__dirname, '../adapters/toss/adapter.ts'), 'utf-8');
    expect(checkAdapterSource(src, [ENV.apiKey, ENV.apiSecret, ENV.accountNo])).toEqual([]);
  });
});

describe('toss adapter — auth', () => {
  it('토큰을 form-urlencoded로 발급하고 accountSeq를 확보한다', async () => {
    const { http, calls } = fakeHttp(baseRoutes());
    const a = createAdapter(ENV, http);
    await a.auth();
    const tokenCall = calls.find((c) => c.path === '/oauth2/token')!;
    expect(tokenCall.headers?.['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(tokenCall.body).toContain('grant_type=client_credentials');
    expect(tokenCall.body).toContain(`client_id=${ENV.apiKey}`);
    expect(calls.some((c) => c.path === '/api/v1/accounts')).toBe(true);
  });
});

describe('toss adapter — read 경로', () => {
  it('getQuotes: prices+stocks 매핑, bid/ask는 price proxy', async () => {
    const { http } = fakeHttp(baseRoutes({
      '/api/v1/prices': { result: [{ symbol: '005930', lastPrice: '72000', currency: 'KRW' }] },
      '/api/v1/stocks': { result: [{ symbol: '005930', name: '삼성전자' }] },
    }));
    const a = wrapAdapter(createAdapter(ENV, http)); // zod 계약까지 검증
    const q = await a.getQuotes(['005930']);
    expect(q).toEqual([{ symbol: '005930', name: '삼성전자', price: 72000, bid: 72000, ask: 72000, changeRate: 0, volume: 0 }]);
  });

  it('getBalance: KRW 매수가능금액 + KR 보유분만(US 제외)', async () => {
    const { http } = fakeHttp(baseRoutes({
      '/api/v1/buying-power': { result: { currency: 'KRW', cashBuyingPower: '5000000' } },
      '/api/v1/holdings': { result: { items: [
        { symbol: '005930', name: '삼성전자', marketCountry: 'KR', currency: 'KRW', quantity: '100', averagePurchasePrice: '65000' },
        { symbol: 'AAPL', name: 'Apple', marketCountry: 'US', currency: 'USD', quantity: '10', averagePurchasePrice: '150' },
      ] } },
    }));
    const a = wrapAdapter(createAdapter(ENV, http));
    const b = await a.getBalance();
    expect(b.cash).toBe(5_000_000);
    expect(b.positions).toEqual([{ symbol: '005930', name: '삼성전자', quantity: 100, avgPrice: 65000 }]);
  });

  it('isMarketOpen: 정규장 윈도 안이면 true, integrated null이면 false', async () => {
    const within = {
      result: { today: { integrated: { regularMarket: {
        startTime: new Date(Date.now() - 3_600_000).toISOString(),
        endTime: new Date(Date.now() + 3_600_000).toISOString(),
      } } } },
    };
    const open = createAdapter(ENV, fakeHttp(baseRoutes({ '/api/v1/market-calendar/KR': within })).http);
    expect(await open.isMarketOpen()).toBe(true);

    const closed = createAdapter(ENV, fakeHttp(baseRoutes({ '/api/v1/market-calendar/KR': { result: { today: { integrated: null } } } })).http);
    expect(await closed.isMarketOpen()).toBe(false);
  });

  it('getCandles: day→1d 매핑 + 최신→과거를 오름차순으로 뒤집음', async () => {
    const { http, calls } = fakeHttp(baseRoutes({
      '/api/v1/candles': { result: { candles: [
        { timestamp: '2026-03-25T09:00:00+09:00', openPrice: '71600', highPrice: '72300', lowPrice: '71500', closePrice: '72000', volume: '3521000', currency: 'KRW' },
        { timestamp: '2026-03-24T09:00:00+09:00', openPrice: '71200', highPrice: '71800', lowPrice: '71000', closePrice: '71600', volume: '2984000', currency: 'KRW' },
      ], nextBefore: null } },
    }));
    const a = wrapAdapter(createAdapter(ENV, http));
    const c = await a.getCandles!('005930', 'day', 2);
    expect(calls.some((x) => x.path.includes('interval=1d'))).toBe(true);
    expect(c.map((x) => x.time)).toEqual(['2026-03-24T09:00:00+09:00', '2026-03-25T09:00:00+09:00']);
    expect(c[1]!.close).toBe(72000);
  });

  it('getOrderbook: price/volume 매핑', async () => {
    const { http } = fakeHttp(baseRoutes({
      '/api/v1/orderbook': { result: { currency: 'KRW', asks: [{ price: '72300', volume: '1200' }], bids: [{ price: '72000', volume: '5200' }] } },
    }));
    const a = wrapAdapter(createAdapter(ENV, http));
    const ob = await a.getOrderbook!('005930');
    expect(ob.asks[0]).toEqual({ price: 72300, quantity: 1200 });
    expect(ob.bids[0]).toEqual({ price: 72000, quantity: 5200 });
  });
});

describe('toss adapter — 주문 경로(live 전용)', () => {
  it('submitOrder: 성공 시 ACCEPTED + X-Tossinvest-Account 헤더', async () => {
    const { http, calls } = fakeHttp(baseRoutes({ '/api/v1/orders': { result: { orderId: 'ord-1', clientOrderId: null } } }));
    const a = wrapAdapter(createAdapter(ENV, http));
    const r = await a.submitOrder!({ symbol: '005930', name: '삼성전자', side: 'BUY', quantity: 10, orderType: 'LIMIT', limitPrice: 70000 });
    expect(r).toEqual({ orderId: 'ord-1', status: 'ACCEPTED' });
    const orderCall = calls.find((c) => c.path === '/api/v1/orders' && c.method === 'POST')!;
    expect(orderCall.headers?.['X-Tossinvest-Account']).toBe('7');
    expect((orderCall.body as { quantity: string }).quantity).toBe('10');
  });

  it('submitOrder: LIMIT인데 가격 없으면 REJECTED', async () => {
    const { http } = fakeHttp(baseRoutes({ '/api/v1/orders': { result: { orderId: 'x' } } }));
    const a = createAdapter(ENV, http);
    const r = await a.submitOrder!({ symbol: '005930', name: '삼성전자', side: 'BUY', quantity: 10, orderType: 'LIMIT' });
    expect(r.status).toBe('REJECTED');
  });
});
