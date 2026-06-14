import { z } from 'zod';
import type { IndicatorRow, Quote, Thesis } from '../core/types.js';
import { runClaudeText, extractFirstJsonObject } from './runner.js';

export const SkepticVerdictSchema = z.object({
  refute: z.boolean(),
  reason: z.string(),
});
export type SkepticVerdict = z.infer<typeof SkepticVerdictSchema>;

export interface SkepticInput {
  symbol: string;
  name: string;
  quantity: number;
  reasoning: string;
  thesis: Thesis;
  marketView: string;
  quote?: Quote;
  indicator?: IndicatorRow;
  strategyDocs: string;
}

const won = (n: number) => Math.round(n).toLocaleString('ko-KR');

export function buildSkepticPrompt(i: SkepticInput): string {
  const px = i.quote ? `${won(i.quote.price)}원 (${i.quote.changeRate}%)` : '시세 없음';
  const ind = i.indicator
    ? `5일선 ${i.indicator.ma5 ?? '-'} · 20일선 ${i.indicator.ma20 ?? '-'} · RSI ${i.indicator.rsi14 ?? '-'} · ATR% ${i.indicator.atrPct ?? '-'} · 낙폭 ${i.indicator.drawdownPct ?? '-'}%`
    : '지표 없음';

  return `당신은 자동매매 시스템의 '회의론자(skeptic)' 검토관입니다. 아래 매수(BUY) 결정을 반박하는 것이 임무입니다.
매수는 돌이키기 어렵고 비용(왕복 약 0.3%)이 드는 결정이므로, 근거가 약하면 막아야 합니다.
다만 합리적 근거가 충분하면 통과시키십시오 — 무조건 반대하는 것이 목적이 아닙니다.

## 전략 문서
${i.strategyDocs}

## 검토 대상 매수
- 종목: ${i.name}(${i.symbol}) ${i.quantity}주
- 시장관점: ${i.marketView}
- 매수 근거: ${i.reasoning}
- thesis: ${i.thesis.why} / 목표 ${i.thesis.target} / 손절 ${i.thesis.stop} / 청산조건 ${i.thesis.exitCondition}
- 현재가: ${px}
- 지표: ${ind}

## 판단 기준 (하나라도 명확히 해당하면 refute=true)
- thesis가 데이터(지표·시세)와 모순되거나 근거가 막연하다
- 과매수(RSI 높음)·고점 매수 등 진입 타이밍이 나쁘다
- 거래비용을 이길 만한 기대우위가 보이지 않는다
- 전략 문서와 어긋난다

## 출력 (JSON만, 다른 텍스트 금지)
{ "refute": true|false, "reason": "한 줄 근거" }`;
}

/** 텍스트에서 스켑틱 판정 추출. 실패 시 통과(fail-open) — 결정론적 가드레일이 이미 통과한 주문이므로 스켑틱 오류로 매매를 영구 차단하지 않는다. */
export function parseSkepticVerdict(text: string): SkepticVerdict {
  const json = extractFirstJsonObject(text);
  if (!json) return { refute: false, reason: '스켑틱 응답 파싱 실패 — 통과' };
  try {
    return SkepticVerdictSchema.parse(JSON.parse(json));
  } catch {
    return { refute: false, reason: '스켑틱 응답 형식 오류 — 통과' };
  }
}

export interface SkepticOptions { claudeCmd: string; timeoutMs?: number }

/** 실제 LLM 스켑틱 함수 생성 (main.ts가 cycle deps에 주입). 호출/파싱 오류는 모두 통과(fail-open). */
export function makeSkeptic(opts: SkepticOptions): (input: SkepticInput) => Promise<SkepticVerdict> {
  return async (input: SkepticInput): Promise<SkepticVerdict> => {
    try {
      const text = await runClaudeText(buildSkepticPrompt(input), {
        claudeCmd: opts.claudeCmd,
        timeoutMs: opts.timeoutMs ?? 90_000,
      });
      return parseSkepticVerdict(text);
    } catch {
      return { refute: false, reason: '스켑틱 호출 실패 — 통과' };
    }
  };
}
