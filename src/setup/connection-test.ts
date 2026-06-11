import type { BrokerAdapter } from '../broker/adapter.js';

export interface ConnStep { name: string; ok: boolean; detail: string }
export interface ConnResult { ok: boolean; steps: ConnStep[] }

/** 각 시크릿(6자 이상)을 '[REDACTED]'로 교체. */
function scrub(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s.length >= 6) out = out.replaceAll(s, '[REDACTED]');
  }
  return out;
}

/**
 * 읽기 전용 3종 연결 테스트. 주문 API는 절대 호출하지 않는다.
 *
 * @param secrets - 에러 메시지에서 마스킹할 시크릿 목록.
 *   하네스는 검증 중 submitOrder를 호출하지 않지만,
 *   어댑터의 auth/getQuotes 내부 동작은 이 함수가 제어하지 않는다
 *   (해당 방어는 static-check + wrapAdapter 담당).
 */
export async function runConnectionTest(
  adapter: BrokerAdapter,
  testSymbol: string,
  secrets: string[] = [],
): Promise<ConnResult> {
  const steps: ConnStep[] = [];
  const run = async (name: string, fn: () => Promise<string>) => {
    try { steps.push({ name, ok: true, detail: await fn() }); return true; }
    catch (err) { steps.push({ name, ok: false, detail: scrub(String(err).slice(0, 300), secrets) }); return false; }
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
