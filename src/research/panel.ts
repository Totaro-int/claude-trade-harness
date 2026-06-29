/**
 * 종목 패널 — ai-berkshire `investment-team.md` 의 4-에이전트 병렬 + team-lead 종합 이식.
 *
 * 한 종목을 4대가 렌즈로 병렬 분석(`runLens`)하고, 결과를 team-lead가 종합(`runSynthesis`)해
 * 회사 단위 투자 판정을 만든다. Claude 호출은 의존성으로 주입해 테스트 가능하게 한다.
 */

import { z } from 'zod';
import { extractFirstJsonObject } from '../core/claude.js';
import {
  LENSES,
  LENS_KEYS,
  buildLensPrompt,
  parseLensVerdict,
  type HoldingInput,
  type LensKey,
  type LensVerdict,
} from './masters.js';
import { checkLensMetrics, type RigorWarning } from './rigor-gate.js';

export interface PanelDeps {
  /** 한 렌즈 프롬프트를 웹리서치 가능한 Claude에 던지고 텍스트를 받는다. */
  runLens: (prompt: string) => Promise<string>;
  /** team-lead 종합 프롬프트를 Claude에 던지고 텍스트를 받는다. */
  runSynthesis: (prompt: string) => Promise<string>;
}

/** 종합 판정 등급 (ai-berkshire 准入/有条件/灰色). */
export const CompanyVerdictSchema = z.object({
  verdict: z.enum(['pass', 'conditional', 'gray']),
  stars: z.number().int().min(1).max(5),
  positionAdvice: z.enum(['add', 'hold', 'trim', 'exit']),
  targetLow: z.number().nullable(),
  targetHigh: z.number().nullable(),
  confidence: z.enum(['A', 'B', 'C']),
  bull: z.array(z.string().min(1)).min(1),
  bear: z.array(z.string().min(1)).min(1),
  summary: z.string().min(1).max(2000),
  invalidation: z.string().min(1).max(1000),
});
export type CompanyVerdict = z.infer<typeof CompanyVerdictSchema>;

export interface CompanyAnalysis {
  symbol: string;
  name: string;
  lenses: Partial<Record<LensKey, LensVerdict>>;
  verdict: CompanyVerdict | null;
  /** financial 렌즈 metrics 검산 경고 (시총 환각 등). 없으면 빈 배열. */
  rigorWarnings: RigorWarning[];
}

const won = (n: number) => Math.round(n).toLocaleString('ko-KR');

/** 4 렌즈 판정을 묶어 team-lead 종합 프롬프트를 만든다. */
export function buildSynthesisPrompt(h: HoldingInput, lenses: Partial<Record<LensKey, LensVerdict>>): string {
  const blocks = LENS_KEYS.filter((k) => lenses[k]).map((k) => {
    const v = lenses[k]!;
    return `### [${k}] ${LENSES[k].masterKo} — ${LENSES[k].role} (점수 ${v.score}/5, 신뢰도 ${v.confidence})
- 결론: ${v.conclusion}
- 긍정: ${v.bull.join(' / ')}
- 부정: ${v.bear.join(' / ')}
- 반증조건: ${v.invalidation}`;
  }).join('\n\n');

  const px = h.currentPrice != null ? `현재가 ${won(h.currentPrice)}원` : '시세 없음';
  const missing = LENS_KEYS.filter((k) => !lenses[k]);
  const missingNote = missing.length
    ? `\n\n※ 결측 렌즈(${missing.join(', ')})가 있다. 종합 신뢰도(confidence)에 반영하라.`
    : '';

  return `당신은 ${h.name}(${h.symbol}) 투자 분석팀의 team-lead입니다. 아래 4대가 렌즈 보고를 종합해 최종 투자 판정을 내립니다. (${px})

## 종합 원칙 (반편향)
- 각 렌즈가 자료 충분도에 휘둘렸는지, 시장 합의에 과도하게 수렴했는지 평가한다.
- 자료가 부족하면 프레임을 추측으로 채우지 말고 confidence를 낮춘다.
- 매수/관망/회피를 회피하지 말고 명확히 판정한다.

## 4대가 렌즈 보고
${blocks}${missingNote}

## 출력 형식 (JSON만, 다른 텍스트 금지)
{
  "verdict": "pass"(준입)|"conditional"(조건부)|"gray"(회색·판단보류),
  "stars": 1~5 정수(종합 점수),
  "positionAdvice": "add"(추가)|"hold"(유지)|"trim"(축소)|"exit"(청산),
  "targetLow": 목표가 하단(원, 모르면 null),
  "targetHigh": 목표가 상단(원, 모르면 null),
  "confidence": "A"|"B"|"C"(종합 신뢰도),
  "bull": ["종합 매수논거", ...],
  "bear": ["종합 매도논거", ...](필수),
  "summary": "한 문단 종합 결론",
  "invalidation": "이 판정을 폐기해야 하는 반증 조건"
}`;
}

/** 종합 텍스트에서 회사 판정 JSON 추출·검증. 실패 시 null. */
export function parseCompanyVerdict(text: string): CompanyVerdict | null {
  const json = extractFirstJsonObject(text);
  if (!json) return null;
  try {
    return CompanyVerdictSchema.parse(JSON.parse(json));
  } catch {
    return null;
  }
}

/** 종목 1개를 4대가 렌즈로 병렬 분석하고 team-lead로 종합한다. */
export async function analyzeHolding(h: HoldingInput, deps: PanelDeps): Promise<CompanyAnalysis> {
  // 1) 4 렌즈 병렬 호출 — 개별 실패는 결측으로 흡수(전체를 막지 않음)
  const settled = await Promise.all(
    LENS_KEYS.map(async (k) => {
      try {
        const text = await deps.runLens(buildLensPrompt(LENSES[k], h));
        return [k, parseLensVerdict(text)] as const;
      } catch {
        return [k, null] as const;
      }
    }),
  );

  const lenses: Partial<Record<LensKey, LensVerdict>> = {};
  for (const [k, v] of settled) if (v) lenses[k] = v;

  // 검산 게이트 — financial 렌즈가 낸 수치를 코드로 교차검증(시총 환각 등 차단)
  const rigorWarnings = checkLensMetrics(lenses.financial?.metrics).warnings;

  // 2) 렌즈가 하나도 없으면 종합 불가
  if (Object.keys(lenses).length === 0) {
    return { symbol: h.symbol, name: h.name, lenses, verdict: null, rigorWarnings };
  }

  // 3) team-lead 종합
  let verdict: CompanyVerdict | null = null;
  try {
    const text = await deps.runSynthesis(buildSynthesisPrompt(h, lenses));
    verdict = parseCompanyVerdict(text);
  } catch {
    verdict = null;
  }

  return { symbol: h.symbol, name: h.name, lenses, verdict, rigorWarnings };
}
