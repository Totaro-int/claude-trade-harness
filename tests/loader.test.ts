import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAdapter } from '../src/broker/loader.js';
import { runConnectionTest } from '../src/setup/connection-test.js';

const GOOD = `
export function createAdapter(env, http) {
  return {
    id: 'tmp',
    async auth() {},
    async getQuotes(symbols) { return symbols.map(s => ({ symbol: s, name: s, price: 1000, bid: 1000, ask: 1000, changeRate: 0, volume: 0 })); },
    async getBalance() { return { cash: 5000, positions: [] }; },
    async isMarketOpen() { return true; },
  };
}`;

function writeTmpAdapter(code: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'adp-'));
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'adapter.mjs');
  writeFileSync(p, code);
  return p;
}

describe('loadAdapter + connection test', () => {
  const env = { apiKey: 'k', apiSecret: 's', accountNo: '12345678', baseUrl: 'https://api.example.com' };

  it('로드된 어댑터는 zod 래핑되어 동작', async () => {
    const a = await loadAdapter(writeTmpAdapter(GOOD), env);
    expect((await a.getQuotes(['A']))[0]!.price).toBe(1000);
  });

  it('연결 테스트: auth→quotes→balance 순서 성공 보고', async () => {
    const a = await loadAdapter(writeTmpAdapter(GOOD), env);
    const r = await runConnectionTest(a, 'A');
    expect(r.ok).toBe(true);
    expect(r.steps.map(s => s.name)).toEqual(['auth', 'getQuotes', 'getBalance']);
  });

  it('연결 테스트: 비정상 응답이면 실패 단계 보고', async () => {
    const BAD = GOOD.replace('price: 1000', 'price: -1');
    const a = await loadAdapter(writeTmpAdapter(BAD), env);
    const r = await runConnectionTest(a, 'A');
    expect(r.ok).toBe(false);
    expect(r.steps.find(s => !s.ok)!.name).toBe('getQuotes');
  });

  it('금지 토큰이 포함된 어댑터는 loadAdapter가 거부', async () => {
    const BANNED = `
const x = process.env.FOO;
export function createAdapter(env, http) {
  return {
    id: 'tmp',
    async auth() {},
    async getQuotes(symbols) { return symbols.map(s => ({ symbol: s, name: s, price: 1000, bid: 1000, ask: 1000, changeRate: 0, volume: 0 })); },
    async getBalance() { return { cash: 5000, positions: [] }; },
    async isMarketOpen() { return true; },
  };
}`;
    await expect(loadAdapter(writeTmpAdapter(BANNED), env))
      .rejects.toThrow(/정적 검사 위반/);
  });

  it('연결 테스트: 시크릿이 에러 메시지에 노출되면 마스킹됨', async () => {
    const SECRET = 'sk-secret-123456';
    const LEAKY = `
export function createAdapter(env, http) {
  return {
    id: 'tmp',
    async auth() {},
    async getQuotes(symbols) { throw new Error('bad token ${SECRET}'); },
    async getBalance() { return { cash: 5000, positions: [] }; },
    async isMarketOpen() { return true; },
  };
}`;
    const a = await loadAdapter(writeTmpAdapter(LEAKY), env);
    const r = await runConnectionTest(a, 'A', [SECRET]);
    expect(r.ok).toBe(false);
    const failStep = r.steps.find(s => !s.ok)!;
    expect(failStep.detail).toContain('[REDACTED]');
    expect(failStep.detail).not.toContain(SECRET);
  });
});
