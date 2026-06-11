import { describe, it, expect } from 'vitest';
import { buildPrompt } from '../src/brain/prompt.js';

const base = {
  strategyDocs: '# 내 전략\n저평가 우량주 분할매수',
  cash: 5_000_000, equity: 10_000_000, dailyPnlPct: -1.2,
  positions: [{ symbol: '005930', name: '삼성전자', quantity: 10, avgPrice: 70000,
    thesis: { why: '반도체 회복', target: '+6%', stop: '-3%', exitCondition: '20일선 이탈' } }],
  quotes: [{ symbol: '005930', name: '삼성전자', price: 71000, bid: 70900, ask: 71100, changeRate: 1.4, volume: 1000 }],
  indicators: [{ symbol: '005930', ma5: 70500, ma20: 69800, change5d: 2.1 }],
  recentDecisions: ['2026-06-11 BUY 삼성전자 10 [FILLED] — 반등 기대'],
  limits: { maxPositionPct: 20, maxOrderPct: 10, maxOrdersPerCycle: 3, dailyLossLimitPct: 3,
    maxOrdersPerDay: 10, reentryCooldownMin: 60, maxTotalExposurePct: 80 },
  ordersToday: 2,
};

describe('buildPrompt', () => {
  it('전략 문서·thesis·지표·잔여 한도가 모두 포함된다', () => {
    const p = buildPrompt(base);
    expect(p).toContain('저평가 우량주 분할매수');
    expect(p).toContain('반도체 회복');       // thesis.why
    expect(p).toContain('20일선 이탈');        // exitCondition
    expect(p).toContain('70,500');             // ma5
    expect(p).toContain('2/10');               // ordersToday/maxOrdersPerDay
    expect(p).toContain('"thesis"');           // 출력 스키마 안내
  });

  it('지표 없으면 "지표 데이터 없음" 명시 (환각 억제)', () => {
    const p = buildPrompt({ ...base, indicators: [] });
    expect(p).toContain('지표 데이터 없음');
  });
});
