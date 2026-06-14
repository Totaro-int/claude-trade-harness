import { describe, it, expect } from 'vitest';
import { computeIndicatorRow } from '../src/core/indicators.js';
import type { Candle } from '../src/core/types.js';

/** close 경로로 캔들 생성 (high/low = ±1% 밴드). */
function candles(closes: number[]): Candle[] {
  return closes.map((close, i) => ({
    time: `2024-01-${String(i + 1).padStart(2, '0')}`,
    open: close, high: Math.round(close * 1.01), low: Math.round(close * 0.99), close, volume: 1000 + i,
  }));
}

const seq = (start: number, step: number, n: number) =>
  Array.from({ length: n }, (_, i) => start + step * i);

describe('computeIndicatorRow', () => {
  it('캔들 6개 미만 → null', () => {
    expect(computeIndicatorRow(candles(seq(100, 1, 5)))).toBeNull();
  });

  it('6~14개 → ma/change5d만, rsi/atr는 undefined', () => {
    const row = computeIndicatorRow(candles(seq(100, 1, 10)))!;
    expect(row.ma5).toBeGreaterThan(0);
    expect(row.change5d).toBeCloseTo((109 / 104 - 1) * 100, 2);
    expect(row.rsi14).toBeUndefined();
    expect(row.atrPct).toBeUndefined();
    expect(row.ma20).toBeUndefined();      // 20개 미만
    expect(row.drawdownPct).toBe(0);       // 단조 상승 → 마지막이 고점
  });

  it('단조 상승 20봉 → RSI 100, 낙폭 0, ma20 산출', () => {
    const row = computeIndicatorRow(candles(seq(100, 1, 20)))!;
    expect(row.rsi14).toBe(100);
    expect(row.drawdownPct).toBe(0);
    expect(row.ma20).toBe(110);            // mean(100..119)=109.5 → round 110
    expect(row.volume).toBe(1019);         // 마지막 봉
    expect(row.atrPct).toBeGreaterThan(0);
  });

  it('단조 하락 20봉 → RSI 0, 낙폭 양수', () => {
    const row = computeIndicatorRow(candles(seq(120, -1, 20)))!;
    expect(row.rsi14).toBe(0);
    // peak=120(첫봉), last=101 → (120-101)/120*100
    expect(row.drawdownPct).toBeCloseTo((19 / 120) * 100, 2);
  });

  it('고점 후 하락 → 낙폭이 고점 대비로 계산된다', () => {
    // 100→110 상승 후 100으로 하락 (총 20봉)
    const closes = [...seq(100, 1, 11), ...seq(109, -1, 9)]; // 100..110, 109..101 (last=101)
    const row = computeIndicatorRow(candles(closes))!;
    expect(row.drawdownPct).toBeCloseTo((9 / 110) * 100, 1); // (110-101)/110
  });

  it('변동 없는 평탄 구간 → RSI 50 (gains=losses=0)', () => {
    const row = computeIndicatorRow(candles(seq(100, 0, 20)))!;
    expect(row.rsi14).toBe(50);
    expect(row.drawdownPct).toBe(0);
  });
});
