import { describe, it, expect, vi } from 'vitest';
import { runReview, type ReviewDeps } from '../src/review/run.js';
import type { BrokerAdapter } from '../src/broker/adapter.js';
import type { Balance, Quote } from '../src/core/types.js';

function fakeAdapter(balance: Balance, quotes: Quote[]): BrokerAdapter {
  return {
    id: 'toss',
    auth: async () => {},
    getBalance: async () => balance,
    getQuotes: async () => quotes,
    isMarketOpen: async () => true,
  };
}

const lensJson = (lens: string) => JSON.stringify({
  lens, score: 4, confidence: 'B', bull: ['b'], bear: ['r'], conclusion: 'c', invalidation: 'i',
});
const synthJson = JSON.stringify({
  verdict: 'conditional', stars: 3, positionAdvice: 'hold',
  targetLow: 70000, targetHigh: 90000, confidence: 'B',
  bull: ['해자'], bear: ['사이클'], summary: '요약', invalidation: '반증',
});

describe('review — runReview', () => {
  const balance: Balance = {
    cash: 1_000_000,
    positions: [
      { symbol: '005930', name: '삼성전자', quantity: 100, avgPrice: 65000 },
      { symbol: '000660', name: 'SK하이닉스', quantity: 10, avgPrice: 180000 },
    ],
  };
  const quotes: Quote[] = [
    { symbol: '005930', name: '삼성전자', price: 72000, bid: 72000, ask: 72000, changeRate: 0, volume: 0 },
    { symbol: '000660', name: 'SK하이닉스', price: 200000, bid: 200000, ask: 200000, changeRate: 0, volume: 0 },
  ];

  function deps(saved: Record<string, string>): ReviewDeps & { saved: Record<string, string> } {
    const runLens = vi.fn(async (prompt: string) => {
      const m = prompt.match(/"lens": "(business|financial|industry|risk)"/);
      return lensJson(m![1]!);
    });
    const runSynthesis = vi.fn(async () => synthJson);
    return {
      adapter: fakeAdapter(balance, quotes),
      runLens, runSynthesis,
      saveReport: (key, value) => { saved[key] = value; },
      now: new Date('2026-06-29T00:00:00Z'),
      saved,
    };
  }

  it('보유종목을 분석해 포트폴리오 리포트를 만들고 저장한다', async () => {
    const saved: Record<string, string> = {};
    const d = deps(saved);
    const r = await runReview(d);

    expect(r.comp.positions).toHaveLength(2);
    expect(r.comp.totalEquity).toBe(1_000_000 + 72000 * 100 + 200000 * 10); // 10,200,000
    expect(r.reportMd).toContain('포트폴리오 진단 리포트');
    expect(r.reportMd).toContain('삼성전자');
    expect(r.reportMd).toContain('2026-06-29');
    // 종목당 4 렌즈 × 2 종목 = 8회, 종합 2회
    expect((d.runLens as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(8);
    expect((d.runSynthesis as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(2);
    // 저장됨
    expect(saved['portfolio-report']).toContain('포트폴리오 진단 리포트');
  });

  it('보유 0이고 현금만 있으면 빈 포지션 리포트', async () => {
    const saved: Record<string, string> = {};
    const d = { ...deps(saved), adapter: fakeAdapter({ cash: 500_000, positions: [] }, []) };
    const r = await runReview(d);
    expect(r.comp.positions).toHaveLength(0);
    expect(r.comp.concentration.cashPct).toBe(100);
    expect(r.reportMd).toContain('포트폴리오 진단 리포트');
  });
});
