/**
 * 검산 게이트 — financial 렌즈가 낸 수치(metrics)를 받는 즉시 rigor 도구로 자동 검증한다.
 *
 * ai-berkshire는 financial_rigor.py 를 Bash로 필수 호출하게 강제한다. 이 포팅에선 LLM이
 * 수치를 구조화 필드로 내게 하고, 코드(verifyMarketCap)가 결정론적으로 교차검증해 시총 환각
 * 같은 오류를 ⚠️ 경고로 리포트에 박는다 — LLM의 "검산했다"는 말을 신뢰하지 않는다.
 */

import { verifyMarketCap, verifyValuation, type MarketCapResult, type ValuationResult } from './rigor.js';
import type { LensMetrics } from './masters.js';

export interface RigorWarning {
  kind: 'market-cap' | 'valuation';
  message: string;
  severity: 'warn' | 'fail';
}

export interface RigorGateResult {
  marketCap?: MarketCapResult;
  valuation?: ValuationResult;
  warnings: RigorWarning[];
}

const won = (n: number) => Math.round(n).toLocaleString('ko-KR');

/** financial 렌즈 metrics를 검산한다. price×shares vs reportedMarketCap 편차가 크면 경고. */
export function checkLensMetrics(m: LensMetrics | undefined): RigorGateResult {
  const warnings: RigorWarning[] = [];
  const result: RigorGateResult = { warnings };
  if (!m) return result;

  // 시총 검산 — 세 값이 모두 있을 때만
  if (m.price != null && m.sharesOutstanding != null && m.reportedMarketCap != null) {
    const mc = verifyMarketCap(m.price, m.sharesOutstanding, m.reportedMarketCap);
    result.marketCap = mc;
    if (mc.severity !== 'pass') {
      warnings.push({
        kind: 'market-cap',
        severity: mc.severity, // 'warn' | 'fail'
        message: `시총 검산 편차 ${mc.deviationPct.toFixed(1)}% — 현재가 ${won(m.price)} × 주식수 ${won(m.sharesOutstanding)} = ${won(mc.calculated)} vs 보고 시총 ${won(m.reportedMarketCap)}. 환각·단위혼동·구주식수 가능성, 재무 분석을 신뢰하기 전 확인 필요.`,
      });
    }
  }

  // 밸류에이션 — 부가 정보(PE/PB/ROE). 경고가 아니라 참고용.
  if (m.price != null && (m.eps != null || m.bvps != null)) {
    result.valuation = verifyValuation(m.price, { eps: m.eps, bvps: m.bvps });
  }

  return result;
}
