import { describe, it, expect } from 'vitest';
import {
  verifyMarketCap,
  verifyValuation,
  crossValidate,
  threeScenario,
  benford,
} from '../src/research/rigor.js';

describe('rigor — verifyMarketCap', () => {
  it('편차 ≤1% 이면 pass', () => {
    const r = verifyMarketCap(510, 9.11e9, 4.65e12);
    expect(r.calculated).toBe(4_646_100_000_000);
    expect(r.deviationPct).toBeCloseTo(0.0839, 3);
    expect(r.severity).toBe('pass');
    expect(r.ok).toBe(true);
  });

  it('편차 1~5% 면 warn(허용), >5% 면 fail', () => {
    expect(verifyMarketCap(100, 1e9, 1.03e11).severity).toBe('warn'); // 3%
    expect(verifyMarketCap(100, 1e9, 1.03e11).ok).toBe(true);
    const fail = verifyMarketCap(100, 1e9, 1.2e11); // 16.7%
    expect(fail.severity).toBe('fail');
    expect(fail.ok).toBe(false);
  });

  it('reported=0 이면 편차 계산 불가 → fail', () => {
    const r = verifyMarketCap(100, 1e9, 0);
    expect(r.ok).toBe(false);
  });
});

describe('rigor — verifyValuation', () => {
  it('PE·수익률·PB·ROE를 정확히 계산', () => {
    const r = verifyValuation(510, { eps: 23.5, bvps: 120 });
    expect(r.pe).toBeCloseTo(21.7021, 3);
    expect(r.earningsYieldPct).toBeCloseTo(4.6078, 3);
    expect(r.pb).toBeCloseTo(4.25, 4);
    expect(r.roePct).toBeCloseTo(19.5833, 3);
  });

  it('FCF·배당·매출 지표', () => {
    const r = verifyValuation(100, { fcfPerShare: 5, dividend: 2, revenuePerShare: 40 });
    expect(r.pfcf).toBeCloseTo(20, 4);
    expect(r.fcfYieldPct).toBeCloseTo(5, 4);
    expect(r.dividendYieldPct).toBeCloseTo(2, 4);
    expect(r.ps).toBeCloseTo(2.5, 4);
  });

  it('EPS=0 이면 PE 미정의(null)', () => {
    const r = verifyValuation(100, { eps: 0 });
    expect(r.pe).toBeNull();
  });
});

describe('rigor — crossValidate', () => {
  it('중위수 기준 편차로 일관성 판정', () => {
    const r = crossValidate('revenue', { 연간보고서: 7518, Yahoo: 7500, StockAnalysis: 7520 }, 2);
    expect(r.median).toBe(7518);
    expect(r.consensus).toBe(7518);
    expect(r.allConsistent).toBe(true);
    const yahoo = r.perSource.find((s) => s.source === 'Yahoo')!;
    expect(yahoo.deviationPct).toBeCloseTo(0.2394, 3);
    expect(yahoo.ok).toBe(true);
  });

  it('한 소스가 tolerance 초과면 비일관', () => {
    const r = crossValidate('revenue', { A: 1000, B: 1010, C: 1500 }, 2);
    expect(r.allConsistent).toBe(false);
    expect(r.perSource.find((s) => s.source === 'C')!.ok).toBe(false);
  });

  it('짝수 개수 중위수는 두 중앙값 평균', () => {
    const r = crossValidate('x', { A: 10, B: 20 }, 5);
    expect(r.median).toBe(15);
  });
});

describe('rigor — threeScenario', () => {
  it('복리성장×목표PE로 3정경 목표가', () => {
    const r = threeScenario(100, 5, {
      bull: { growth: 0.2, pe: 25 },
      base: { growth: 0.1, pe: 18 },
      bear: { growth: 0.0, pe: 12 },
    }, 3);
    const bull = r.find((s) => s.name === 'bull')!;
    expect(bull.targetEps).toBeCloseTo(8.64, 4);
    expect(bull.targetPrice).toBeCloseTo(216, 3);
    expect(bull.changePct).toBeCloseTo(116, 3);

    const base = r.find((s) => s.name === 'base')!;
    expect(base.targetPrice).toBeCloseTo(119.79, 2);

    const bear = r.find((s) => s.name === 'bear')!;
    expect(bear.targetPrice).toBeCloseTo(60, 4);
    expect(bear.changePct).toBeCloseTo(-40, 4);
  });
});

describe('rigor — benford', () => {
  it('선두 숫자 추출과 표본 수', () => {
    const r = benford([1234, 2345, 3456]);
    expect(r.n).toBe(3);
    expect(r.counts[1]).toBe(1);
    expect(r.counts[2]).toBe(1);
    expect(r.counts[3]).toBe(1);
    // 표본 너무 적으면 판정 보류
    expect(r.suspicious).toBe(false);
    expect(r.insufficient).toBe(true);
  });

  it('음수·0은 제외하고 절대값 선두숫자', () => {
    const r = benford([-91, 0, 9.9]);
    expect(r.n).toBe(2); // 91→9, 9.9→9
    expect(r.counts[9]).toBe(2);
  });
});
