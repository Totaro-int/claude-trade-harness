import { describe, it, expect } from 'vitest';
import { runEval } from '../src/backtest/eval.js';
import { loadConfig } from '../src/core/config.js';
import type { Candle, BrainOutput, UniverseEntry } from '../src/core/types.js';

const baseConfig = loadConfig('does-not-exist.json'); // 기본값

const universe: UniverseEntry[] = [
  { symbol: 'AAA', name: 'A종목' },
  { symbol: 'BBB', name: 'B종목' },
];

function makeCandles(start: number, step: number, n: number): Candle[] {
  const out: Candle[] = [];
  let px = start;
  for (let i = 0; i < n; i++) {
    const close = Math.round(px);
    out.push({
      time: `2024-01-${String(i + 1).padStart(2, '0')}`,
      open: close, high: Math.round(close * 1.01), low: Math.round(close * 0.99),
      close, volume: 100_000,
    });
    px = px * (1 + step);
  }
  return out;
}

const BARS = 40;
function uptrendBook(): Map<string, Candle[]> {
  return new Map([
    ['AAA', makeCandles(10_000, 0.012, BARS)],
    ['BBB', makeCandles(20_000, 0.004, BARS)],
  ]);
}

// 매 막대 AAA 1주 시장가 매수 시도 (가드레일이 막지 않는 한)
const alwaysBuyA = async (): Promise<BrainOutput> => ({
  marketView: 'buy',
  decisions: [{
    action: 'BUY', symbol: 'AAA', quantity: 1, orderType: 'MARKET', reasoning: '매수',
    thesis: { why: '추세', target: '+10%', stop: '-3%', exitCondition: '이탈' },
  }],
});

const shared = () => ({
  candlesBySymbol: uptrendBook(), universe, baseConfig,
  baseStrategyDocs: '기본 전략', brain: alwaysBuyA,
});

describe('runEval', () => {
  it('변형 없음 → throw', async () => {
    await expect(runEval(shared(), [])).rejects.toThrow('변형이 없습니다');
  });

  it('라벨 중복 → throw', async () => {
    await expect(runEval(shared(), [
      { label: 'x' }, { label: 'x' },
    ])).rejects.toThrow('중복');
  });

  it('config.guardrails 오버라이드가 적용된다 (maxOrdersPerCycle=0 → 거래 0)', async () => {
    const report = await runEval(shared(), [
      { label: 'frozen', config: { guardrails: { maxOrdersPerCycle: 0 } } },
    ]);
    expect(report.results[0]!.report.trades).toBe(0);
    expect(report.best).toBe('frozen');
  });

  it('결과는 초과수익 내림차순 정렬, best는 최상위', async () => {
    const report = await runEval(shared(), [
      { label: 'active' },                                                  // 매수 허용
      { label: 'frozen', config: { guardrails: { maxOrdersPerCycle: 0 } } }, // 매수 차단 → excess=0
    ]);
    expect(report.results).toHaveLength(2);
    // 내림차순
    expect(report.results[0]!.report.excessPct).toBeGreaterThanOrEqual(report.results[1]!.report.excessPct);
    expect(report.best).toBe(report.results[0]!.label);
    // 두 변형은 서로 다른 결과를 낸다
    expect(report.results[0]!.report.trades).not.toBe(report.results[1]!.report.trades);
  });

  it('onVariant 콜백이 변형마다 호출된다', async () => {
    const seen: string[] = [];
    await runEval({ ...shared(), onVariant: (label) => seen.push(label) }, [
      { label: 'a' }, { label: 'b' },
    ]);
    expect(seen).toEqual(['a', 'b']);
  });
});
