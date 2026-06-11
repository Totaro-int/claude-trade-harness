import { describe, it, expect, vi } from 'vitest';
import { createHttpClient } from '../src/setup/http-client.js';

describe('createHttpClient', () => {
  it('path는 baseUrl 기준으로만 요청, 절대 URL은 거부', async () => {
    const calls: string[] = [];
    const fetcher = vi.fn(async (url: string) => { calls.push(url); return new Response('{"ok":true}', { status: 200 }); });
    const http = createHttpClient('https://api.broker.com', fetcher as never);
    await http.get('/v1/quotes');
    expect(calls[0]).toBe('https://api.broker.com/v1/quotes');
    await expect(http.get('https://evil.com/x')).rejects.toThrow(/상대 경로만/);
  });

  it('429 + Retry-After 시 1회 재시도', async () => {
    let n = 0;
    const fetcher = vi.fn(async () => {
      n++;
      return n === 1
        ? new Response('', { status: 429, headers: { 'Retry-After': '0' } })
        : new Response('{"ok":true}', { status: 200 });
    });
    const http = createHttpClient('https://api.broker.com', fetcher as never);
    expect(await http.get('/x')).toEqual({ ok: true });
    expect(n).toBe(2);
  });

  it('5xx는 에러', async () => {
    const fetcher = vi.fn(async () => new Response('oops', { status: 500 }));
    const http = createHttpClient('https://api.broker.com', fetcher as never);
    await expect(http.get('/x')).rejects.toThrow(/HTTP 500/);
  });

  it('POST 요청 시 JSON body가 fetcher에 전달됨', async () => {
    const fetcher = vi.fn(async () => new Response('{"status":"ok"}', { status: 200 }));
    const http = createHttpClient('https://api.broker.com', fetcher as never);
    await http.post('/v1/order', { symbol: 'AAPL', qty: 1 });
    const [, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(options.method).toBe('POST');
    expect(options.body).toBe(JSON.stringify({ symbol: 'AAPL', qty: 1 }));
  });

  it('fetcher 호출 시 redirect:"error" 옵션이 포함됨', async () => {
    const fetcher = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    const http = createHttpClient('https://api.broker.com', fetcher as never);
    await http.get('/v1/quotes');
    const [, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect((options as RequestInit & { redirect: string }).redirect).toBe('error');
  });
});
