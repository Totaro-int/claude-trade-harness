import { describe, it, expect } from 'vitest';
import { renderCompanyReport, renderPortfolioReport, derivePortfolioSummary } from '../src/research/report.js';
import { computePortfolio, type RawHolding } from '../src/research/portfolio.js';
import type { CompanyAnalysis } from '../src/research/panel.js';

const HOLDINGS: RawHolding[] = [
  { symbol: 'A', name: '에이', quantity: 100, avgPrice: 1000 },
  { symbol: 'B', name: '비', quantity: 50, avgPrice: 2000 },
];
const PRICES = new Map([['A', 1500], ['B', 2000]]);

function analysis(symbol: string, advice: 'add' | 'hold' | 'trim' | 'exit', tl: number, th: number): CompanyAnalysis {
  return {
    symbol, name: symbol === 'A' ? '에이' : '비',
    rigorWarnings: [],
    lenses: {
      financial: { lens: 'financial', score: 4, confidence: 'B', bull: ['ROE 높음'], bear: ['사이클'], conclusion: '저평가', invalidation: 'ROE 붕괴' },
    },
    verdict: {
      verdict: 'conditional', stars: 3, positionAdvice: advice,
      targetLow: tl, targetHigh: th, confidence: 'B',
      bull: ['해자'], bear: ['경쟁'], summary: '종합 요약', invalidation: '반증',
    },
  };
}

describe('report — renderCompanyReport', () => {
  it('렌즈별 결론과 종합 판정을 담는다', () => {
    const md = renderCompanyReport(analysis('A', 'add', 1600, 2000));
    expect(md).toContain('에이');
    expect(md).toContain('버핏'); // 렌즈 마스터명
    expect(md).toContain('저평가'); // 렌즈 결론
    expect(md).toContain('종합 요약');
    expect(md).toMatch(/조건부|conditional/);
    expect(md).toContain('반증');
  });

  it('검산 경고(시총 환각)를 최상단에 🚨로 노출한다', () => {
    const a = analysis('A', 'hold', 1600, 2000);
    a.rigorWarnings = [{ kind: 'market-cap', severity: 'fail', message: '시총 검산 편차 387.0% — 환각 가능성' }];
    const md = renderCompanyReport(a);
    expect(md).toContain('🚨');
    expect(md).toContain('검산 경고');
    expect(md).toContain('387.0%');
  });

  it('verdict 없으면 분석 불가 표기', () => {
    const md = renderCompanyReport({ symbol: 'X', name: '엑스', lenses: {}, verdict: null, rigorWarnings: [] });
    expect(md).toMatch(/분석 불가|데이터 부족/);
  });
});

describe('report — derivePortfolioSummary', () => {
  it('집중도 통과 수로 건전도 등급', () => {
    const comp = computePortfolio(HOLDINGS, PRICES, 50000);
    const s = derivePortfolioSummary(comp);
    // top1 50%>40(fail), count 2<5(fail), top3 2종목(ok), cash 16.7%(ok) → 2 ok
    expect(s.healthGrade).toBe('조정 필요');
    expect(s.biggestRisk).toContain('집중'); // top1>40
  });

  it('최우선 행동: 기대수익 최저 & 축소/청산 권고 종목을 짚는다', () => {
    const analyses = new Map([
      ['A', analysis('A', 'add', 1800, 2200)],
      ['B', analysis('B', 'exit', 1400, 1600)], // mid 1500 vs 2000 → -25%
    ]);
    const comp = computePortfolio(HOLDINGS, PRICES, 50000, analyses);
    const s = derivePortfolioSummary(comp, analyses);
    expect(s.oneThing).toContain('비'); // 청산 권고 + 최저 기대수익
  });
});

describe('report — renderPortfolioReport', () => {
  it('개요·집중도·기회비용·조정제안·결론 섹션을 담는다', () => {
    const analyses = new Map([
      ['A', analysis('A', 'add', 1800, 2200)],
      ['B', analysis('B', 'trim', 1900, 2100)],
    ]);
    const comp = computePortfolio(HOLDINGS, PRICES, 50000, analyses);
    const md = renderPortfolioReport({ comp, analyses, date: '2026-06-29' });
    expect(md).toContain('2026-06-29');
    expect(md).toContain('조합 개요');
    expect(md).toContain('집중도');
    expect(md).toContain('기회비용');
    expect(md).toContain('조정 제안');
    expect(md).toContain('에이');
    expect(md).toContain('비');
    // 비중·현금 노출
    expect(md).toMatch(/현금/);
  });
});
