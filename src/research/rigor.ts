/**
 * 금융 데이터 엄밀성 검증 도구 — ai-berkshire `tools/financial_rigor.py` 의 TS 포팅.
 *
 * 원본은 Python `decimal.Decimal` 로 부동소수 드리프트를 막지만, 한국 시총 최대 ~500조(5e14)는
 * float64 안전정수(9e15) 이내이므로 plain number 로 충분하다. 재현성을 위해 결과는
 * `round()` 헬퍼로 결정론적으로 반올림한다. (의존성 추가 없음 — simplicity-first)
 *
 * 모든 함수는 순수함수이며 출력하지 않고 구조화된 결과를 반환한다(원본은 stdout 프린트).
 */

/** 소수 n자리 반올림 (round-half-up, 표시·재현 일관성용). */
function round(value: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round((value + Number.EPSILON) * f) / f;
}

// ---------------------------------------------------------------------------
// 1. 시가총액 검증 (시가 × 총주식수 vs 보고 시총)
// ---------------------------------------------------------------------------

export type Severity = 'pass' | 'warn' | 'fail';

export interface MarketCapResult {
  calculated: number;
  deviationPct: number;
  severity: Severity;
  ok: boolean;
}

/** 시총 = 시가 × 총주식수 를 계산하고 보고값과의 편차로 판정. ≤1% pass · ≤5% warn · >5% fail. */
export function verifyMarketCap(price: number, shares: number, reportedCap: number): MarketCapResult {
  const calculated = price * shares;
  if (!Number.isFinite(reportedCap) || reportedCap === 0) {
    return { calculated, deviationPct: Infinity, severity: 'fail', ok: false };
  }
  const deviationPct = Math.abs((calculated - reportedCap) / reportedCap) * 100;
  const severity: Severity = deviationPct > 5 ? 'fail' : deviationPct > 1 ? 'warn' : 'pass';
  return {
    calculated: round(calculated, 2),
    deviationPct: round(deviationPct, 4),
    severity,
    ok: severity !== 'fail',
  };
}

// ---------------------------------------------------------------------------
// 2. 밸류에이션 지표 검증
// ---------------------------------------------------------------------------

export interface ValuationInput {
  eps?: number;
  bvps?: number;
  fcfPerShare?: number;
  dividend?: number;
  revenuePerShare?: number;
}

export interface ValuationResult {
  pe: number | null;
  earningsYieldPct: number | null;
  pb: number | null;
  roePct: number | null;
  pfcf: number | null;
  fcfYieldPct: number | null;
  dividendYieldPct: number | null;
  ps: number | null;
}

/** 원시 입력에서 PE/PB/ROE/FCF수익률/배당률/PS 를 정확히 산출. 0 분모는 null. */
export function verifyValuation(price: number, i: ValuationInput): ValuationResult {
  const r: ValuationResult = {
    pe: null, earningsYieldPct: null, pb: null, roePct: null,
    pfcf: null, fcfYieldPct: null, dividendYieldPct: null, ps: null,
  };

  if (i.eps != null && i.eps !== 0) {
    r.pe = round(price / i.eps);
    r.earningsYieldPct = round((i.eps / price) * 100);
  }
  if (i.bvps != null && i.bvps !== 0) {
    r.pb = round(price / i.bvps);
    if (i.eps != null && i.eps !== 0) r.roePct = round((i.eps / i.bvps) * 100);
  }
  if (i.fcfPerShare != null && i.fcfPerShare !== 0) {
    r.pfcf = round(price / i.fcfPerShare);
    r.fcfYieldPct = round((i.fcfPerShare / price) * 100);
  }
  if (i.dividend != null && price !== 0) {
    r.dividendYieldPct = round((i.dividend / price) * 100);
  }
  if (i.revenuePerShare != null && i.revenuePerShare !== 0) {
    r.ps = round(price / i.revenuePerShare);
  }
  return r;
}

// ---------------------------------------------------------------------------
// 3. 다(多)소스 교차검증
// ---------------------------------------------------------------------------

export interface CrossSource {
  source: string;
  value: number;
  deviationPct: number;
  ok: boolean;
}

export interface CrossValidateResult {
  median: number;
  consensus: number;
  allConsistent: boolean;
  perSource: CrossSource[];
}

/** 한 데이터 포인트를 여러 소스에서 비교, 중위수 기준 편차로 불일치 탐지. */
export function crossValidate(
  field: string,
  sourceValues: Record<string, number>,
  tolerancePct = 2,
): CrossValidateResult {
  const entries = Object.entries(sourceValues);
  const sorted = entries.map(([, v]) => v).sort((a, b) => a - b);
  const n = sorted.length;
  const median = n % 2 === 1 ? sorted[(n - 1) / 2]! : (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2;

  let allConsistent = true;
  const perSource: CrossSource[] = entries.map(([source, value]) => {
    const deviationPct = median !== 0 ? Math.abs((value - median) / median) * 100 : 0;
    const ok = deviationPct <= tolerancePct;
    if (!ok) allConsistent = false;
    return { source, value, deviationPct: round(deviationPct, 4), ok };
  });

  return { median: round(median, 4), consensus: round(median, 4), allConsistent, perSource };
}

// ---------------------------------------------------------------------------
// 4. 3정경(낙관·중립·비관) 밸류에이션
// ---------------------------------------------------------------------------

export type ScenarioName = 'bull' | 'base' | 'bear';

export interface ScenarioInput { growth: number; pe: number }

export interface ScenarioResult {
  name: ScenarioName;
  growth: number;
  pe: number;
  targetEps: number;
  targetPrice: number;
  changePct: number;
}

/** 미래 EPS = 현재 EPS × (1+성장)^년수, 목표가 = 미래 EPS × 목표 PE. */
export function threeScenario(
  price: number,
  eps: number,
  scenarios: Record<ScenarioName, ScenarioInput>,
  years = 3,
): ScenarioResult[] {
  const order: ScenarioName[] = ['bull', 'base', 'bear'];
  return order.map((name) => {
    const { growth, pe } = scenarios[name];
    let futureEps = eps;
    for (let y = 0; y < years; y++) futureEps *= 1 + growth;
    const targetPrice = futureEps * pe;
    const changePct = price !== 0 ? ((targetPrice - price) / price) * 100 : 0;
    return {
      name, growth, pe,
      targetEps: round(futureEps, 4),
      targetPrice: round(targetPrice, 4),
      changePct: round(changePct, 4),
    };
  });
}

// ---------------------------------------------------------------------------
// 5. Benford 법칙 빠른 검사 (재무 데이터 조작 탐지)
// ---------------------------------------------------------------------------

/** 표본이 이보다 적으면 Benford 판정을 보류한다 (통계적 의미 없음). */
const BENFORD_MIN_SAMPLE = 30;

const BENFORD_EXPECTED: Record<number, number> = Object.fromEntries(
  Array.from({ length: 9 }, (_, k) => [k + 1, Math.log10(1 + 1 / (k + 1))]),
);

export interface BenfordResult {
  n: number;
  counts: Record<number, number>;
  expected: Record<number, number>;
  chiSquare: number;
  insufficient: boolean;
  suspicious: boolean;
}

/** 값 목록의 선두 숫자 분포를 Benford 기대분포와 카이제곱으로 비교. */
export function benford(values: number[]): BenfordResult {
  const counts: Record<number, number> = {};
  for (let d = 1; d <= 9; d++) counts[d] = 0;

  let n = 0;
  for (const raw of values) {
    const v = Math.abs(raw);
    if (v > 0 && Number.isFinite(v)) {
      const sig = 10 ** (Math.log10(v) - Math.floor(Math.log10(v)));
      const d = Math.floor(sig);
      if (d >= 1 && d <= 9) { counts[d]!++; n++; }
    }
  }

  // 카이제곱: Σ (관측 - 기대)² / 기대, 기대 = n × P(d)
  let chiSquare = 0;
  if (n > 0) {
    for (let d = 1; d <= 9; d++) {
      const exp = n * BENFORD_EXPECTED[d]!;
      chiSquare += (counts[d]! - exp) ** 2 / exp;
    }
  }

  const insufficient = n < BENFORD_MIN_SAMPLE;
  // 자유도 8, 유의수준 0.05 임계값 ≈ 15.51. 표본 충분 + 초과 시 의심.
  const suspicious = !insufficient && chiSquare > 15.51;

  return {
    n, counts, expected: BENFORD_EXPECTED,
    chiSquare: round(chiSquare, 4),
    insufficient, suspicious,
  };
}
