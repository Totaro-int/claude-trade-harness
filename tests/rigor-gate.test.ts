import { describe, it, expect } from 'vitest';
import { checkLensMetrics } from '../src/research/rigor-gate.js';

describe('rigor-gate — checkLensMetrics', () => {
  it('시총 편차 ≤5%면 경고 없음', () => {
    // 74000 × 6.0e9 = 4.44e14, 보고 4.45e14 → 0.22% 편차
    const r = checkLensMetrics({ price: 74000, sharesOutstanding: 6.0e9, reportedMarketCap: 4.45e14 });
    expect(r.marketCap?.severity).toBe('pass');
    expect(r.warnings).toHaveLength(0);
  });

  it('환각 시총(5배 부풀림)을 ⚠️로 잡는다', () => {
    // 실측 사례: 74000 × 6.0e9 = 4.44e14 인데 보고 2.161e15 라고 주장 → ~387% 편차
    const r = checkLensMetrics({ price: 74000, sharesOutstanding: 6.0e9, reportedMarketCap: 2.161e15 });
    expect(r.marketCap?.severity).toBe('fail');
    expect(r.warnings.some((w) => w.kind === 'market-cap')).toBe(true);
    expect(r.warnings[0]!.message).toMatch(/시총|편차/);
  });

  it('수치가 일부만 있으면 검산 생략(경고 없음)', () => {
    const r = checkLensMetrics({ price: 74000 });
    expect(r.marketCap).toBeUndefined();
    expect(r.warnings).toHaveLength(0);
  });

  it('valuation: PE 계산은 부가 정보로만(경고 아님)', () => {
    const r = checkLensMetrics({ price: 74000, eps: 5000 });
    expect(r.valuation?.pe).toBeCloseTo(14.8, 1);
    expect(r.warnings).toHaveLength(0);
  });

  it('metrics 없으면 빈 결과', () => {
    const r = checkLensMetrics(undefined);
    expect(r.warnings).toHaveLength(0);
    expect(r.marketCap).toBeUndefined();
  });
});
