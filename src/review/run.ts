/**
 * 포트폴리오 리뷰 오케스트레이터 — ai-berkshire `/portfolio-review` 의 실행 플로우.
 *
 * 토스 어댑터에서 실보유·시세를 받아 → 종목별 4대가 패널 분석 → 포트폴리오 집계 →
 * 리포트 렌더링·저장. Claude 호출·저장은 의존성으로 주입해 테스트 가능하게 한다.
 */

import type { BrokerAdapter } from '../broker/adapter.js';
import { analyzeHolding, type CompanyAnalysis, type PanelDeps } from '../research/panel.js';
import { computePortfolio, type PortfolioComputation, type RawHolding } from '../research/portfolio.js';
import { renderPortfolioReport } from '../research/report.js';
import type { InfoTier } from '../research/masters.js';

export interface ReviewDeps {
  adapter: BrokerAdapter;
  runLens: PanelDeps['runLens'];
  runSynthesis: PanelDeps['runSynthesis'];
  /** 리포트 영속화(예: store.setKV 또는 파일 쓰기). */
  saveReport: (key: string, value: string) => void;
  now: Date;
  /** 종목별 정보 충실도. 미지정 시 전부 'B'(추산값 신뢰도 명시 모드). */
  infoTier?: (symbol: string) => InfoTier;
}

export interface ReviewResult {
  comp: PortfolioComputation;
  analyses: Map<string, CompanyAnalysis>;
  reportMd: string;
}

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function runReview(deps: ReviewDeps): Promise<ReviewResult> {
  const balance = await deps.adapter.getBalance();
  const holdings: RawHolding[] = balance.positions
    .filter((p) => p.quantity > 0)
    .map((p) => ({ symbol: p.symbol, name: p.name, quantity: p.quantity, avgPrice: p.avgPrice }));

  // 시세
  const prices = new Map<string, number>();
  if (holdings.length > 0) {
    const quotes = await deps.adapter.getQuotes(holdings.map((h) => h.symbol));
    for (const q of quotes) prices.set(q.symbol, q.price);
  }

  // 종목별 4대가 패널 분석 (순차 — 종목당 5회 claude 호출이라 동시성 폭주 방지)
  const panelDeps: PanelDeps = { runLens: deps.runLens, runSynthesis: deps.runSynthesis };
  const analyses = new Map<string, CompanyAnalysis>();
  for (const h of holdings) {
    const a = await analyzeHolding(
      {
        name: h.name,
        symbol: h.symbol,
        quantity: h.quantity,
        avgPrice: h.avgPrice,
        currentPrice: prices.get(h.symbol),
        infoTier: deps.infoTier?.(h.symbol) ?? 'B',
      },
      panelDeps,
    );
    analyses.set(h.symbol, a);
  }

  const comp = computePortfolio(holdings, prices, balance.cash, analyses);
  const reportMd = renderPortfolioReport({ comp, analyses, date: fmtDate(deps.now) });
  deps.saveReport('portfolio-report', reportMd);

  return { comp, analyses, reportMd };
}
