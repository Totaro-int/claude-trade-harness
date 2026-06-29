/**
 * 포트폴리오 집계 — ai-berkshire `portfolio-review.md` 의 조합 레벨 분석 이식(결정론적 부분).
 *
 * 토스 보유종목 + 시세 + 현금을 받아 시가평가·비중·집중도·기회비용 랭킹을 계산한다.
 * 상관성·스트레스 테스트 등 정성 분석은 포트폴리오 레벨 LLM 종합(후속 단계)의 몫이며,
 * 여기서는 수치로 확정 가능한 부분만 다룬다.
 */

import type { CompanyAnalysis } from './panel.js';

export interface RawHolding {
  symbol: string;
  name: string;
  quantity: number;
  avgPrice: number;
}

export interface PricedPosition extends RawHolding {
  currentPrice: number;
  marketValue: number;
  weightPct: number;
  pnlPct: number;
}

/** portfolio-review.md 4.1 集中度分析 임계값. */
const TOP1_MAX = 40;       // 第一大持仓 <40%
const TOP3_MIN = 50;       // 前三大 50~80%
const TOP3_MAX = 80;
const COUNT_MIN = 5;       // 总持仓 5~15
const COUNT_MAX = 15;
const CASH_MIN = 10;       // 现金 10~30%
const CASH_MAX = 30;

export interface ConcentrationMetrics {
  top1Pct: number;
  top3Pct: number;
  count: number;
  cashPct: number;
  top1Ok: boolean;
  top3Ok: boolean;
  countOk: boolean;
  cashOk: boolean;
}

export interface OpportunityRow {
  symbol: string;
  name: string;
  weightPct: number;
  /** verdict 목표가 중간값 대비 현재가 기대상승률(%). 분석/목표 없으면 null. */
  expectedUpsidePct: number | null;
  advice: 'add' | 'hold' | 'trim' | 'exit' | null;
}

export interface PortfolioComputation {
  positions: PricedPosition[];
  totalEquity: number;
  cash: number;
  investedValue: number;
  concentration: ConcentrationMetrics;
  /** 기대상승률 내림차순(없으면 비중 내림차순) — 기회비용 분석용. */
  opportunity: OpportunityRow[];
}

function round(value: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round((value + Number.EPSILON) * f) / f;
}

/** verdict 목표가 중간값으로 기대상승률(%)을 추정. 목표가 없으면 null. */
function expectedUpside(currentPrice: number, a?: CompanyAnalysis): number | null {
  const v = a?.verdict;
  if (!v) return null;
  const lo = v.targetLow;
  const hi = v.targetHigh;
  let mid: number | null = null;
  if (lo != null && hi != null) mid = (lo + hi) / 2;
  else if (lo != null) mid = lo;
  else if (hi != null) mid = hi;
  if (mid == null || currentPrice <= 0) return null;
  return round((mid / currentPrice - 1) * 100);
}

export function computePortfolio(
  holdings: RawHolding[],
  prices: Map<string, number>,
  cash: number,
  analyses?: Map<string, CompanyAnalysis>,
): PortfolioComputation {
  const priced: PricedPosition[] = holdings.map((h) => {
    const currentPrice = prices.get(h.symbol) ?? h.avgPrice; // 시세 없으면 평단가 fallback
    const marketValue = currentPrice * h.quantity;
    const pnlPct = h.avgPrice > 0 ? round((currentPrice / h.avgPrice - 1) * 100) : 0;
    return { ...h, currentPrice, marketValue, weightPct: 0, pnlPct }; // weight는 아래서 채움
  });

  const investedValue = priced.reduce((s, p) => s + p.marketValue, 0);
  const totalEquity = investedValue + cash;

  for (const p of priced) {
    p.weightPct = totalEquity > 0 ? round((p.marketValue / totalEquity) * 100) : 0;
  }

  // 집중도 — 비중 내림차순 기준
  const byWeight = [...priced].sort((a, b) => b.marketValue - a.marketValue);
  const top1Pct = byWeight[0]?.weightPct ?? 0;
  const top3Pct = round(byWeight.slice(0, 3).reduce((s, p) => s + p.weightPct, 0));
  const count = priced.length;
  const cashPct = totalEquity > 0 ? round((cash / totalEquity) * 100) : 0;

  const concentration: ConcentrationMetrics = {
    top1Pct, top3Pct, count, cashPct,
    top1Ok: count === 0 ? true : top1Pct < TOP1_MAX,
    top3Ok: count <= 3 ? true : top3Pct >= TOP3_MIN && top3Pct <= TOP3_MAX,
    countOk: count >= COUNT_MIN && count <= COUNT_MAX,
    cashOk: cashPct >= CASH_MIN && cashPct <= CASH_MAX,
  };

  // 기회비용 랭킹 — 기대상승률 desc, 동률/결측은 비중 desc
  const opportunity: OpportunityRow[] = priced
    .map((p) => {
      const a = analyses?.get(p.symbol);
      return {
        symbol: p.symbol,
        name: p.name,
        weightPct: p.weightPct,
        expectedUpsidePct: expectedUpside(p.currentPrice, a),
        advice: a?.verdict?.positionAdvice ?? null,
      };
    })
    .sort((x, y) => {
      const xu = x.expectedUpsidePct;
      const yu = y.expectedUpsidePct;
      if (xu != null && yu != null && xu !== yu) return yu - xu;
      if (xu != null && yu == null) return -1;
      if (xu == null && yu != null) return 1;
      return y.weightPct - x.weightPct;
    });

  return { positions: priced, totalEquity, cash, investedValue, concentration, opportunity };
}
