import { describe, it, expect } from 'vitest';
import { checkAdapterSource } from '../src/setup/static-check.js';

const SECRETS = ['sk-real-key-123', 'secret-xyz'];
const ok = `
import type { BrokerAdapter, AdapterEnv, HttpClient } from '../../src/broker/adapter.js';
export function createAdapter(env: AdapterEnv, http: HttpClient): BrokerAdapter {
  let token = '';
  return {
    id: 'demo',
    async auth() { const r = await http.post('/oauth2/token', { key: env.apiKey }) as { access_token: string }; token = r.access_token; },
    async getQuotes(symbols) { return await http.get('/quotes?s=' + symbols.join(','), { headers: { Authorization: token } }) as never; },
    async getBalance() { return await http.get('/balance') as never; },
    async isMarketOpen() { return true; },
  };
}`;

describe('checkAdapterSource', () => {
  it('규격 준수 코드는 위반 없음', () => {
    expect(checkAdapterSource(ok, SECRETS)).toEqual([]);
  });
  it.each([
    ['fs 접근', `import fs from 'node:fs';`],
    ['child_process', `import { exec } from 'child_process';`],
    ['값 import', `import { z } from 'zod';`],
    ['동적 import', `const m = await import('node:fs');`],
    ['eval', `eval('1+1');`],
    ['직접 fetch', `await fetch('https://evil.com');`],
    ['process 접근', `const k = process.env.SECRET;`],
    ['require', `const fs = require('fs');`],
  ])('%s 차단', (_label, snippet) => {
    expect(checkAdapterSource(ok + '\n' + snippet, SECRETS).length).toBeGreaterThan(0);
  });
  it('시크릿 하드코딩 차단', () => {
    expect(checkAdapterSource(ok + `\nconst k = 'sk-real-key-123';`, SECRETS).length).toBeGreaterThan(0);
  });
  it('createAdapter export 없으면 위반', () => {
    expect(checkAdapterSource(`export const x = 1;`, SECRETS).length).toBeGreaterThan(0);
  });
});
