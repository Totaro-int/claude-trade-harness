import { describe, it, expect } from 'vitest';
import { runBacktest } from '../src/backtest/runner.js';
import { loadConfig } from '../src/core/config.js';
import type { Candle, BrainOutput, UniverseEntry } from '../src/core/types.js';

const config = loadConfig('does-not-exist.json'); // 기본값 사용

const universe: UniverseEntry[] = [
  { symbol: 'AAA', name: 'A종목' },
  { symbol: 'BBB', name: 'B종목' },
];

/** 결정론적 캔들 생성 (Math.random 미사용). step만큼 매 막대 등비 상승. */
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
    ['AAA', makeCandles(10_000, 0.01, BARS)], // +1%/bar
    ['BBB', makeCandles(20_000, 0.005, BARS)], // +0.5%/bar
  ]);
}

const holdBrain = async (): Promise<BrainOutput> => ({
  marketView: 'flat', decisions: [{ action: 'HOLD', reasoning: '관망' }],
});

describe('runBacktest', () => {
  it('all-HOLD: 거래 0, 최종자산 = 초기현금, 리포트 필드 유한', async () => {
    const report = await runBacktest({
      candlesBySymbol: uptrendBook(), universe, config,
      strategyDocs: 'test', brain: holdBrain,
    });

    expect(report.trades).toBe(0);
    expect(report.finalEquity).toBe(report.initialCash);
    expect(report.totalReturnPct).toBe(0);
    expect(report.maxDrawdownPct).toBeGreaterThanOrEqual(0);

    // 벤치마크는 우상향 유니버스이므로 양수
    expect(report.benchmarkReturnPct).toBeGreaterThan(0);
    expect(report.excessPct).toBeCloseTo(report.totalReturnPct - report.benchmarkReturnPct, 6);

    // 모든 숫자 필드 유한
    for (const v of [report.bars, report.trades, report.feesTotal, report.initialCash,
      report.finalEquity, report.totalReturnPct, report.benchmarkReturnPct,
      report.excessPct, report.maxDrawdownPct]) {
      expect(Number.isFinite(v)).toBe(true);
    }
    expect(report.equityCurve.length).toBe(report.bars);
    expect(report.bars).toBe(BARS - 20); // default startIndex=20
  });

  it('BUY 후 HOLD: 거래 기록, 수수료>0, 자산이 가격경로 추종', async () => {
    let bought = false;
    const buyOnceBrain = async (): Promise<BrainOutput> => {
      if (bought) return { marketView: '보유', decisions: [{ action: 'HOLD', reasoning: '보유 유지' }] };
      bought = true;
      return {
        marketView: '진입',
        decisions: [{
          action: 'BUY', symbol: 'AAA', quantity: 10, orderType: 'MARKET',
          reasoning: 'A 매수',
          thesis: { why: '상승추세', target: '+10%', stop: '-3%', exitCondition: '추세이탈' },
        }],
      };
    };

    const report = await runBacktest({
      candlesBySymbol: uptrendBook(), universe, config,
      strategyDocs: 'test', brain: buyOnceBrain,
    });

    expect(report.trades).toBe(1);
    expect(report.feesTotal).toBeGreaterThan(0);
    // AAA가 우상향 → 매수 후 평가익 → 총수익률 > 0
    expect(report.totalReturnPct).toBeGreaterThan(0);
    expect(Number.isFinite(report.excessPct)).toBe(true);
    expect(report.maxDrawdownPct).toBeGreaterThanOrEqual(0);
    expect(report.equityCurve.length).toBe(report.bars);
  });

  it('onBar 콜백이 매 막대 호출됨', async () => {
    const seen: number[] = [];
    const report = await runBacktest({
      candlesBySymbol: uptrendBook(), universe, config,
      strategyDocs: 'test', brain: holdBrain,
      onBar: (i) => seen.push(i),
    });
    expect(seen.length).toBe(report.bars);
  });

  it('startIndex 커스텀 가능', async () => {
    const report = await runBacktest({
      candlesBySymbol: uptrendBook(), universe, config,
      strategyDocs: 'test', brain: holdBrain, startIndex: 25,
    });
    expect(report.bars).toBe(BARS - 25);
  });

  it('검증: 캔들 길이 불일치 → throw', async () => {
    const book = new Map<string, Candle[]>([
      ['AAA', makeCandles(10_000, 0.01, 40)],
      ['BBB', makeCandles(20_000, 0.01, 30)],
    ]);
    await expect(runBacktest({
      candlesBySymbol: book, universe, config, strategyDocs: 't', brain: holdBrain,
    })).rejects.toThrow();
  });

  it('검증: 빈 캔들 → throw', async () => {
    const book = new Map<string, Candle[]>([['AAA', []], ['BBB', []]]);
    await expect(runBacktest({
      candlesBySymbol: book, universe, config, strategyDocs: 't', brain: holdBrain,
    })).rejects.toThrow();
  });

  it('검증: N <= startIndex → 캔들 부족 throw', async () => {
    const book = new Map<string, Candle[]>([
      ['AAA', makeCandles(10_000, 0.01, 10)],
      ['BBB', makeCandles(20_000, 0.01, 10)],
    ]);
    await expect(runBacktest({
      candlesBySymbol: book, universe, config, strategyDocs: 't', brain: holdBrain,
      startIndex: 20,
    })).rejects.toThrow('캔들이 부족합니다');
  });
});
