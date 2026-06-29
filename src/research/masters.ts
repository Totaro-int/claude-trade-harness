/**
 * 4대가 렌즈 + anti-bias 프레임워크 — ai-berkshire `investment-team.md` 와 `CLAUDE.md` 원칙의 이식.
 *
 * 종목 1개를 4명의 가치투자 대가 관점으로 병렬 분석한다. 각 렌즈는 독립적인 프롬프트로
 * Claude 서브프로세스(웹리서치)에 던져지고(Phase 3 panel.ts), 구조화된 판정을 반환한다.
 */

import { z } from 'zod';
import { extractFirstJsonObject } from '../core/claude.js';

export type LensKey = 'business' | 'financial' | 'industry' | 'risk';
export type InfoTier = 'A' | 'B' | 'C';

export const LENS_KEYS: LensKey[] = ['business', 'financial', 'industry', 'risk'];

export interface Lens {
  key: LensKey;
  masterKo: string;
  masterEn: string;
  role: string;
  /** 이 렌즈가 반드시 다뤄야 할 분석축 (investment-team.md 태스크 description 이식). */
  taskPoints: string[];
  /** true면 출력에 검산용 수치(metrics)를 강제한다 — 코드가 verifyMarketCap으로 교차검증. */
  requiresMetrics?: boolean;
}

export const LENSES: Record<LensKey, Lens> = {
  business: {
    key: 'business',
    masterKo: '돤융핑(段永平)',
    masterEn: 'Duan Yongping',
    role: '비즈니스 모델 & 해자(moat) 분석',
    taskPoints: [
      '비즈니스 모델 본질: 핵심 사업 정의·수익 구조 분해',
      '플랫폼/제품 플라이휠이 어떻게 작동하는가',
      '해자 검증: 브랜드·전환비용·네트워크효과·규모의경제·기술장벽을 하나씩',
      '고객 가치: 각 이해관계자에게 어떤 독특한 가치를 창출하는가',
      '사업 매트릭스와 시너지',
      '돤융핑 "좋은 사업" 기준: 차별화·가격결정력·지속가능한 경쟁우위',
    ],
  },
  financial: {
    key: 'financial',
    masterKo: '버핏(巴菲特)',
    masterEn: 'Warren Buffett',
    role: '재무 & 밸류에이션 분석',
    taskPoints: [
      '최근 3~5년 매출·순이익·영업이익 추세',
      '수익성: ROE·ROA·매출총이익률·영업이익률',
      '현금흐름: 영업현금흐름·잉여현금흐름(FCF)·자본적지출',
      '재무상태표 건전성: 현금 보유·부채비율·유동성',
      '밸류에이션: PE/PS/PB/EV, 과거 및 동종업계 대비',
      '안전마진: 내재가치 vs 현재가 (3정경 추정)',
      '※ 시총·PER·ROE 등 핵심 수치는 암산 금지 — 별도 검산 도구로 교차검증된 값만 인용',
      '※ 아래 metrics(현재가·총주식수·보고시총·EPS·BVPS)를 반드시 숫자로 채운다 — 코드가 verifyMarketCap으로 자동 검산한다',
    ],
    requiresMetrics: true,
  },
  industry: {
    key: 'industry',
    masterKo: '멍거(芒格)',
    masterEn: 'Charlie Munger',
    role: '산업 격국 & 경쟁 분석',
    taskPoints: [
      '산업 규모와 성장: 시장 규모·성장률·침투율',
      '경쟁 격국: 주요 경쟁사 점유율·전략 비교',
      '핵심 경쟁자 위협을 하나씩 평가',
      '세부 트랙(segment)별 격국',
      '산업 트렌드: 기술 변혁·정책 영향·신규 진입자',
      '밸류체인: 상·중·하류 가치 배분',
    ],
  },
  risk: {
    key: 'risk',
    masterKo: '리루(李录)',
    masterEn: 'Li Lu',
    role: '리스크 & 경영진 평가',
    taskPoints: [
      '경영진 평가: CEO 능력범위·정직성·전략 안목·자본배분 능력·과거 의사결정 품질',
      '규제 리스크: 현재 및 잠재 규제 영향',
      '경쟁 리스크: 각 경쟁자 위협 정도',
      '사업 리스크: 신규사업 적자·확장 불확실성',
      '거시 리스크: 경기·산업 사이클 영향',
      '지배구조: 지분구조·특수관계자 거래·주주환원 정책',
      '장기 확실성: 10년 후 이 회사는? 무엇이 이 비즈니스를 무너뜨릴 수 있나?',
    ],
  },
};

/** ai-berkshire CLAUDE.md "投研分析核心原则" 이식 — 모든 렌즈 프롬프트의 머리말. */
export const ANTI_BIAS_PREAMBLE = `## 분석 원칙 (최고 우선순위 — 위반 시 분석 무효)
- 객관·객관·객관: 모든 판단은 사실과 데이터에 근거한다. 주관적 억측 금지.
- 사실과 관점을 엄격히 구분한다. 사실은 데이터로 뒷받침하고, 관점은 "관점"·"추정"으로 명시한다.
- 입장을 미리 정하지 않는다. 먼저 데이터를 늘어놓고, 논리를 전개하고, 마지막에 결론을 데이터에서 자연히 도출한다.
- "내 생각엔"·"분명히" 같은 주관 표현 대신 "데이터에 따르면"·"근거가 보여주듯"을 쓴다.
- 정반양면: 모든 핵심 판단에는 반드시 반대 논거(bear)를 함께 제시한다.
- 불확실한 것은 정직하게 "불확실"·"데이터 부족"이라 적는다. 추측으로 프레임을 채우지 않는다.
- 자료가 많다 ≠ 확실하다. 확실성은 자료량이 아니라 비즈니스 모델 자체에서 온다.`;

const TIER_STRATEGY: Record<InfoTier, string> = {
  A: '정보 충분(A급): 시장 합의를 되풀이하는 "맞는 헛소리"를 피하라. 반면 검증과 비합의(non-consensus) 관점에 무게를 둔다.',
  B: '정보 보통(B급): 추산한 수치마다 신뢰도를 명시하고, 결론에 "데이터 충분도"를 표기한다.',
  C: '정보 희소(C급): 제일원리(first-principles) 모드로 전환한다. 보고서 완결성에 집착하지 말고 비즈니스 본질의 핵심 질문 몇 가지에 집중한다. 데이터 부족은 부족이라 적는다.',
};

export interface HoldingInput {
  name: string;
  symbol: string;
  quantity?: number;
  avgPrice?: number;
  currentPrice?: number;
  infoTier: InfoTier;
}

const won = (n: number) => Math.round(n).toLocaleString('ko-KR');

/** 한 렌즈(대가)의 분석 프롬프트를 만든다. */
export function buildLensPrompt(lens: Lens, h: HoldingInput): string {
  const holdingLine = h.quantity != null && h.avgPrice != null
    ? `보유: ${h.quantity}주 @ ${won(h.avgPrice)}원${h.currentPrice != null ? ` (현재가 ${won(h.currentPrice)}원)` : ''}`
    : h.currentPrice != null ? `현재가: ${won(h.currentPrice)}원` : '보유/시세 정보 없음';

  return `당신은 ${h.name}(${h.symbol}) 투자 분석팀의 "${lens.role}" 담당이며, ${lens.masterKo} 투자 관점으로 분석합니다.

${ANTI_BIAS_PREAMBLE}

## 정보 충실도 전략
${TIER_STRATEGY[h.infoTier]}

## 대상 종목
- ${h.name}(${h.symbol})
- ${holdingLine}

## 분석 과제 (${lens.masterKo} 관점)
${lens.taskPoints.map((t, idx) => `${idx + 1}. ${t}`).join('\n')}

## 연구 방법
- 웹 검색으로 최신 공개 정보(재무제표·산업 보고서·뉴스)를 조사한다.
- 핵심 재무 수치는 2개 이상 독립 소스로 교차검증하고, 두 소스 차이가 1% 초과면 표기한다.
- 데이터에는 출처를 단다. 분석은 표면적이지 않게 깊이 들어간다.

## 출력 형식 (JSON만, 다른 텍스트 금지)
{
  "lens": "${lens.key}",
  "score": 1~5 정수(이 렌즈 관점의 종합 점수, 5가 최고),
  "confidence": "A"|"B"|"C"(분석 신뢰도 — 데이터 충분도 기준),
  "bull": ["이 종목을 긍정하는 핵심 근거", ...],
  "bear": ["이 종목을 부정하는 핵심 근거", ...](반드시 1개 이상 — 정반양면),
  "conclusion": "이 렌즈의 한 줄 결론",
  "invalidation": "이 결론을 폐기해야 하는 반증 조건(무엇이 보이면 틀린 것인가)"${lens.requiresMetrics ? `,
  "metrics": {
    "price": 조사한 현재가(원, 숫자),
    "sharesOutstanding": 총 발행주식수(주, 숫자 — 예: 5970000000),
    "reportedMarketCap": 공시·포털 보고 시가총액(원, 숫자),
    "eps": 주당순이익(원, 숫자, 모르면 생략),
    "bvps": 주당순자산(원, 숫자, 모르면 생략),
    "currency": "KRW"
  }` : ''}
}${lens.requiresMetrics ? '\n\n※ metrics의 price·sharesOutstanding·reportedMarketCap은 반드시 채운다. 코드가 price×shares vs reportedMarketCap을 자동 검산해 편차가 크면 당신의 분석을 신뢰하지 않는다.' : ''}`;
}

/** 검산용 수치 — financial 렌즈가 채운다. 받는 즉시 코드가 verifyMarketCap/verifyValuation으로 검증. */
export const LensMetricsSchema = z.object({
  price: z.number().positive().optional(),
  sharesOutstanding: z.number().positive().optional(),
  reportedMarketCap: z.number().positive().optional(),
  eps: z.number().optional(),
  bvps: z.number().optional(),
  currency: z.string().max(10).optional(),
});
export type LensMetrics = z.infer<typeof LensMetricsSchema>;

export const LensVerdictSchema = z.object({
  lens: z.enum(['business', 'financial', 'industry', 'risk']),
  score: z.number().int().min(1).max(5),
  confidence: z.enum(['A', 'B', 'C']),
  bull: z.array(z.string().min(1)).min(1),
  bear: z.array(z.string().min(1)).min(1), // 정반양면 강제: 반대 논거 필수
  conclusion: z.string().min(1).max(1000),
  invalidation: z.string().min(1).max(1000),
  metrics: LensMetricsSchema.optional(),
});
export type LensVerdict = z.infer<typeof LensVerdictSchema>;

/** LLM 텍스트에서 렌즈 판정 JSON을 추출·검증. 실패 시 null(호출자가 결측 처리). */
export function parseLensVerdict(text: string): LensVerdict | null {
  const json = extractFirstJsonObject(text);
  if (!json) return null;
  try {
    return LensVerdictSchema.parse(JSON.parse(json));
  } catch {
    return null;
  }
}
