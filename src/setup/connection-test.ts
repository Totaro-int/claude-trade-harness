import type { BrokerAdapter } from '../broker/adapter.js';

export interface ConnStep { name: string; ok: boolean; detail: string }
export interface ConnResult { ok: boolean; steps: ConnStep[] }

/** 읽기 전용 3종 연결 테스트. 주문 API는 절대 호출하지 않는다. */
export async function runConnectionTest(adapter: BrokerAdapter, testSymbol: string): Promise<ConnResult> {
  const steps: ConnStep[] = [];
  const run = async (name: string, fn: () => Promise<string>) => {
    try { steps.push({ name, ok: true, detail: await fn() }); return true; }
    catch (err) { steps.push({ name, ok: false, detail: String(err).slice(0, 300) }); return false; }
  };

  if (!(await run('auth', async () => { await adapter.auth(); return '인증 성공'; }))) return { ok: false, steps };
  if (!(await run('getQuotes', async () => {
    const q = await adapter.getQuotes([testSymbol]);
    if (q.length === 0) throw new Error('시세 0건');
    return `${q[0]!.symbol} = ${q[0]!.price}`;
  }))) return { ok: false, steps };
  if (!(await run('getBalance', async () => {
    const b = await adapter.getBalance();
    return `현금 ${b.cash}, 포지션 ${b.positions.length}건`;
  }))) return { ok: false, steps };

  return { ok: true, steps };
}
