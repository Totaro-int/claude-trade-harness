import type { HttpClient } from '../broker/adapter.js';

type Fetcher = typeof globalThis.fetch;

/** 생성 어댑터에 주입되는 유일한 네트워크 통로. base URL 밖으로 못 나간다. */
export function createHttpClient(baseUrl: string, fetcher: Fetcher = globalThis.fetch): HttpClient {
  const base = baseUrl.replace(/\/$/, '');

  async function request(method: 'GET' | 'POST', path: string, body?: unknown, init?: { headers?: Record<string, string> }): Promise<unknown> {
    if (/^[a-z]+:\/\//i.test(path)) throw new Error(`상대 경로만 허용됩니다: ${path}`);
    const url = base + (path.startsWith('/') ? path : '/' + path);
    const doFetch = () => fetcher(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    let res = await doFetch();
    if (res.status === 429) {
      const wait = Math.min(Number(res.headers.get('Retry-After') ?? '1'), 30);
      await new Promise(r => setTimeout(r, wait * 1000));
      res = await doFetch();
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} ${method} ${path}: ${(await res.text()).slice(0, 300)}`);
    const text = await res.text();
    try { return JSON.parse(text); } catch { return text; }
  }

  return {
    get: (path, init) => request('GET', path, undefined, init),
    post: (path, body, init) => request('POST', path, body, init),
  };
}
