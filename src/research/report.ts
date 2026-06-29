/**
 * 리포트 렌더링 — ai-berkshire `portfolio-review.md` 第六步 보고서 구조의 마크다운 출력.
 *
 * 종목별 리포트(4대가 렌즈 + 종합)와 포트폴리오 리포트(개요·집중도·기회비용·조정제안·결론)를
 * 결정론적으로 렌더링한다. 정성 서술은 각 verdict/lens 텍스트를 그대로 인용한다.
 */

import { LENSES, LENS_KEYS } from './masters.js';
import type { CompanyAnalysis } from './panel.js';
import type { PortfolioComputation } from './portfolio.js';

const won = (n: number) => Math.round(n).toLocaleString('ko-KR');
const pct = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;

const VERDICT_KO: Record<string, string> = { pass: '준입(pass)', conditional: '조건부(conditional)', gray: '회색·보류(gray)' };
const ADVICE_KO: Record<string, string> = { add: '추가', hold: '유지', trim: '축소', exit: '청산' };

/** 종목 1개 리포트 — 4대가 렌즈 + team-lead 종합. */
export function renderCompanyReport(a: CompanyAnalysis): string {
  const lines: string[] = [`## ${a.name}(${a.symbol})`];

  // 검산 경고를 최상단에 노출 (시총 환각 등 — 재무 분석 신뢰 전 확인)
  if (a.rigorWarnings.length > 0) {
    lines.push('');
    for (const w of a.rigorWarnings) {
      lines.push(`> ${w.severity === 'fail' ? '🚨' : '⚠️'} **검산 경고(${w.kind})**: ${w.message}`);
    }
  }

  if (!a.verdict && Object.keys(a.lenses).length === 0) {
    lines.push('', '> ⚠️ 분석 불가 — 데이터 부족(렌즈 응답 없음).');
    return lines.join('\n');
  }

  // 렌즈별 보고
  lines.push('', '### 4대가 렌즈');
  for (const k of LENS_KEYS) {
    const v = a.lenses[k];
    if (!v) { lines.push(`- **${LENSES[k].masterKo}** — (결측)`); continue; }
    lines.push(
      `- **${LENSES[k].masterKo}** · ${LENSES[k].role} — 점수 ${v.score}/5, 신뢰도 ${v.confidence}`,
      `  - 결론: ${v.conclusion}`,
      `  - 🟢 ${v.bull.join(' / ')}`,
      `  - 🔴 ${v.bear.join(' / ')}`,
      `  - 반증조건: ${v.invalidation}`,
    );
  }

  // 종합
  const v = a.verdict;
  if (!v) {
    lines.push('', '### 종합', '> ⚠️ 렌즈는 있으나 종합 판정 생성 실패.');
    return lines.join('\n');
  }
  const target = v.targetLow != null && v.targetHigh != null
    ? `${won(v.targetLow)}~${won(v.targetHigh)}원`
    : v.targetLow != null ? `${won(v.targetLow)}원~` : v.targetHigh != null ? `~${won(v.targetHigh)}원` : '미정';
  lines.push(
    '', '### 종합 (team-lead)',
    `- 판정: **${VERDICT_KO[v.verdict] ?? v.verdict}** · ${'★'.repeat(v.stars)}${'☆'.repeat(5 - v.stars)} · 신뢰도 ${v.confidence}`,
    `- 포지션 권고: **${ADVICE_KO[v.positionAdvice] ?? v.positionAdvice}** · 목표가 ${target}`,
    `- 🟢 ${v.bull.join(' / ')}`,
    `- 🔴 ${v.bear.join(' / ')}`,
    `- 요약: ${v.summary}`,
    `- 반증조건: ${v.invalidation}`,
  );
  return lines.join('\n');
}

export type HealthGrade = '우수' | '양호' | '조정 필요' | '문제 심각';

export interface PortfolioSummary {
  healthGrade: HealthGrade;
  oneThing: string;
  biggestRisk: string;
}

const RISK_FREE_PCT = 4; // 무위험 수익률(현금 기준) — 기회비용 비교선

/** 결정론적 요약: 건전도 등급 / 최우선 행동 / 최대 리스크 (portfolio-review 第六步 结论). */
export function derivePortfolioSummary(
  comp: PortfolioComputation,
  analyses?: Map<string, CompanyAnalysis>,
): PortfolioSummary {
  const c = comp.concentration;
  const okCount = [c.top1Ok, c.top3Ok, c.countOk, c.cashOk].filter(Boolean).length;
  const healthGrade: HealthGrade =
    okCount === 4 ? '우수' : okCount === 3 ? '양호' : okCount === 2 ? '조정 필요' : '문제 심각';

  // 최대 리스크
  let biggestRisk: string;
  if (!c.top1Ok && c.count > 0) {
    biggestRisk = `최대 종목 비중 ${c.top1Pct.toFixed(1)}%로 집중 위험(>40%).`;
  } else if (!c.cashOk) {
    biggestRisk = `현금 비중 ${c.cashPct.toFixed(1)}%가 권장(10~30%) 밖.`;
  } else {
    const worst = [...comp.opportunity].reverse().find((o) => o.expectedUpsidePct != null);
    biggestRisk = worst
      ? `기대수익 최저 종목 ${worst.name}(${worst.expectedUpsidePct!.toFixed(1)}%).`
      : '뚜렷한 집중·현금 리스크는 없음(개별 종목 논지 점검 필요).';
  }

  // 최우선 행동: 기대수익 < 무위험 & 축소/청산 권고 종목 우선, 없으면 최고확신 추가
  let oneThing = '현 상태 유지 — 분기 1회 재점검.';
  const ranked = comp.opportunity.filter((o) => o.expectedUpsidePct != null);
  const trimExit = ranked
    .filter((o) => (o.advice === 'trim' || o.advice === 'exit') && o.expectedUpsidePct! < RISK_FREE_PCT)
    .sort((a, b) => a.expectedUpsidePct! - b.expectedUpsidePct!);
  if (trimExit.length > 0) {
    const t = trimExit[0]!;
    oneThing = `${t.name} ${t.advice === 'exit' ? '청산' : '축소'} 검토 — 기대수익 ${t.expectedUpsidePct!.toFixed(1)}%로 현금(${RISK_FREE_PCT}%) 미달.`;
  } else {
    const add = ranked.find((o) => o.advice === 'add');
    if (add) oneThing = `${add.name} 추가 검토 — 기대수익 ${add.expectedUpsidePct!.toFixed(1)}% 최상위.`;
  }

  return { healthGrade, oneThing, biggestRisk };
}

export interface PortfolioReportInput {
  comp: PortfolioComputation;
  analyses: Map<string, CompanyAnalysis>;
  date: string;
}

const okMark = (b: boolean) => (b ? '✅' : '⚠️');

/** 포트폴리오 리포트 — 개요·단일점검·집중도·기회비용·조정제안·결론. */
export function renderPortfolioReport({ comp, analyses, date }: PortfolioReportInput): string {
  const c = comp.concentration;
  const s = derivePortfolioSummary(comp, analyses);
  const L: string[] = [];

  L.push(`# 포트폴리오 진단 리포트 — ${date}`, '');
  L.push(`> 4대가(버핏·멍거·돤융핑·리루) 관점 종합. 총자산 ${won(comp.totalEquity)}원 · 현금 ${won(comp.cash)}원(${c.cashPct.toFixed(1)}%)`, '');

  // 一. 조합 개요
  L.push('## 1. 조합 개요', '', '| 종목 | 코드 | 수량 | 평단 | 현재가 | 평가액 | 비중 | 손익 |', '|---|---|--:|--:|--:|--:|--:|--:|');
  for (const p of comp.positions) {
    L.push(`| ${p.name} | ${p.symbol} | ${p.quantity} | ${won(p.avgPrice)} | ${won(p.currentPrice)} | ${won(p.marketValue)} | ${p.weightPct.toFixed(1)}% | ${pct(p.pnlPct)} |`);
  }
  L.push(`| 현금 | - | - | - | - | ${won(comp.cash)} | ${c.cashPct.toFixed(1)}% | - |`, '');

  // 二. 단일 종목 점검 (요약 줄)
  L.push('## 2. 단일 종목 점검', '', '| 종목 | 판정 | 권고 | 별점 | 신뢰도 |', '|---|---|---|---|---|');
  for (const p of comp.positions) {
    const v = analyses.get(p.symbol)?.verdict;
    if (v) L.push(`| ${p.name} | ${VERDICT_KO[v.verdict] ?? v.verdict} | ${ADVICE_KO[v.positionAdvice] ?? v.positionAdvice} | ${v.stars}/5 | ${v.confidence} |`);
    else L.push(`| ${p.name} | (분석 없음) | - | - | - |`);
  }
  L.push('');

  // 三. 조합 분석 — 집중도 / 기회비용
  L.push('## 3. 조합 분석', '', '### 3.1 집중도', '', '| 지표 | 현재 | 권장 | 판정 |', '|---|--:|---|:--:|');
  L.push(`| 1위 비중 | ${c.top1Pct.toFixed(1)}% | <40% | ${okMark(c.top1Ok)} |`);
  L.push(`| 상위 3 비중 | ${c.top3Pct.toFixed(1)}% | 50~80% | ${okMark(c.top3Ok)} |`);
  L.push(`| 보유 종목수 | ${c.count} | 5~15 | ${okMark(c.countOk)} |`);
  L.push(`| 현금 비중 | ${c.cashPct.toFixed(1)}% | 10~30% | ${okMark(c.cashOk)} |`, '');

  L.push('### 3.2 기회비용 (기대수익 순)', '', '| 순위 | 종목 | 비중 | 기대상승 | 권고 |', '|--:|---|--:|--:|---|');
  comp.opportunity.forEach((o, i) => {
    const up = o.expectedUpsidePct != null ? `${o.expectedUpsidePct >= 0 ? '+' : ''}${o.expectedUpsidePct.toFixed(1)}%` : '—';
    L.push(`| ${i + 1} | ${o.name} | ${o.weightPct.toFixed(1)}% | ${up} | ${o.advice ? (ADVICE_KO[o.advice] ?? o.advice) : '—'} |`);
  });
  L.push('', `> 무위험(현금) 수익 ~${RISK_FREE_PCT}% 미만 종목은 현금 대비 열위 — 교체 후보.`, '');

  // 四. 조정 제안
  L.push('## 4. 조정 제안', '', '| 동작 | 종목 | 비중 | 사유 |', '|---|---|--:|---|');
  for (const o of comp.opportunity) {
    if (!o.advice || o.advice === 'hold') continue;
    const v = analyses.get(o.symbol)?.verdict;
    L.push(`| ${ADVICE_KO[o.advice]} | ${o.name} | ${o.weightPct.toFixed(1)}% | ${v?.summary ?? ''} |`);
  }
  L.push('');

  // 五. 결론
  L.push('## 5. 결론', '', `- **조합 건전도**: ${s.healthGrade}`, `- **가장 먼저 할 일**: ${s.oneThing}`, `- **최대 리스크**: ${s.biggestRisk}`);
  const warnCount = comp.positions.reduce((n, p) => n + (analyses.get(p.symbol)?.rigorWarnings.length ?? 0), 0);
  if (warnCount > 0) L.push(`- **🚨 검산 경고 ${warnCount}건** — 아래 종목별 상세 상단 확인(시총·밸류 수치 신뢰 전 검증 필요)`);
  L.push('');

  // 종목별 상세
  L.push('---', '', '# 종목별 상세');
  for (const p of comp.positions) {
    const a = analyses.get(p.symbol);
    L.push('', a ? renderCompanyReport(a) : `## ${p.name}(${p.symbol})\n\n> 분석 없음.`);
  }

  return L.join('\n');
}
