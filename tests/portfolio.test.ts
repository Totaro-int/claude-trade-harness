import { describe, it, expect } from 'vitest';
import { computePortfolio, type RawHolding } from '../src/research/portfolio.js';
import type { CompanyAnalysis } from '../src/research/panel.js';

const HOLDINGS: RawHolding[] = [
  { symbol: 'A', name: '에이', quantity: 100, avgPrice: 1000 },
  { symbol: 'B', name: '비', quantity: 50, avgPrice: 2000 },
];
const PRICES = new Map([['A', 1500], ['B', 2000]]);

function verdict(targetLow: number, targetHigh: number, advice: 'add' | 'hold' | 'trim' | 'exit'): CompanyAnalysis {
  return {
    symbol: 'x', name: 'x', lenses: {}, rigorWarnings: [],
    verdict: {
      verdict: 'conditional', stars: 3, positionAdvice: advice,
      targetLow, targetHigh, confidence: 'B',
      bull: ['b'], bear: ['r'], summary: 's', invalidation: 'i',
    },
  };
}

describe('portfolio — computePortfolio', () => {
  it('시가평가·비중·손익을 계산한다', () => {
    const r = computePortfolio(HOLDINGS, PRICES, 50000);
    expect(r.totalEquity).toBe(300000); // 150000 + 100000 + 50000
    const a = r.positions.find((p) => p.symbol === 'A')!;
    expect(a.marketValue).toBe(150000);
    expect(a.weightPct).toBeCloseTo(50, 4);
    expect(a.pnlPct).toBeCloseTo(50, 4);
    const b = r.positions.find((p) => p.symbol === 'B')!;
    expect(b.pnlPct).toBeCloseTo(0, 4);
  });

  it('집중도 지표와 임계 판정', () => {
    const r = computePortfolio(HOLDINGS, PRICES, 50000);
    expect(r.concentration.top1Pct).toBeCloseTo(50, 4);
    expect(r.concentration.top3Pct).toBeCloseTo(83.3333, 3);
    expect(r.concentration.count).toBe(2);
    expect(r.concentration.cashPct).toBeCloseTo(16.6667, 3);
    expect(r.concentration.top1Ok).toBe(false); // 50% > 40%
    expect(r.concentration.countOk).toBe(false); // 2 < 5
    expect(r.concentration.cashOk).toBe(true); // 16.7% in 10~30
  });

  it('기회비용: verdict 목표가로 기대상승률 랭킹(내림차순)', () => {
    const analyses = new Map<string, CompanyAnalysis>([
      ['A', verdict(1600, 2000, 'add')], // mid 1800 vs 1500 → +20%
      ['B', verdict(1900, 2100, 'hold')], // mid 2000 vs 2000 → 0%
    ]);
    const r = computePortfolio(HOLDINGS, PRICES, 50000, analyses);
    expect(r.opportunity[0]!.symbol).toBe('A');
    expect(r.opportunity[0]!.expectedUpsidePct).toBeCloseTo(20, 4);
    expect(r.opportunity[1]!.symbol).toBe('B');
    expect(r.opportunity[1]!.expectedUpsidePct).toBeCloseTo(0, 4);
    expect(r.opportunity[0]!.advice).toBe('add');
  });

  it('분석 없으면 기대상승률 null, 비중순 정렬', () => {
    const r = computePortfolio(HOLDINGS, PRICES, 50000);
    expect(r.opportunity.every((o) => o.expectedUpsidePct === null)).toBe(true);
    expect(r.opportunity[0]!.symbol).toBe('A'); // 비중 큰 순
  });

  it('현금만 있고 보유 없으면 빈 포지션·현금 100%', () => {
    const r = computePortfolio([], new Map(), 100000);
    expect(r.positions).toHaveLength(0);
    expect(r.totalEquity).toBe(100000);
    expect(r.concentration.cashPct).toBe(100);
    expect(r.concentration.top1Pct).toBe(0);
  });

  it('시세 없는 종목은 평단가로 평가(fallback)', () => {
    const r = computePortfolio([{ symbol: 'C', name: '씨', quantity: 10, avgPrice: 5000 }], new Map(), 0);
    const c = r.positions[0]!;
    expect(c.currentPrice).toBe(5000);
    expect(c.marketValue).toBe(50000);
    expect(c.pnlPct).toBe(0);
  });
});
