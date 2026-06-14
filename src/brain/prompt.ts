import type { GuardrailLimits } from '../core/config.js';
import type { IndicatorRow, Position, Quote } from '../core/types.js';

export interface PromptInput {
  strategyDocs: string;          // strategy/*.md 전체를 이어붙인 텍스트
  cash: number;
  equity: number;
  dailyPnlPct: number;
  positions: Position[];
  quotes: Quote[];
  indicators: IndicatorRow[];
  recentDecisions: string[];     // 최근 20개 요약 (최신순)
  reflections: string[];         // 청산된 매매의 thesis 회고 (최신순) — 비면 섹션 생략
  limits: GuardrailLimits;
  ordersToday: number;
}

const won = (n: number) => Math.round(n).toLocaleString('ko-KR');

export function buildPrompt(i: PromptInput): string {
  const ind = new Map(i.indicators.map(r => [r.symbol, r]));
  const quoteRows = i.quotes.map(q => {
    const r = ind.get(q.symbol);
    const extra = r
      ? [
          r.ma5 != null ? won(r.ma5) : '-',
          r.ma20 != null ? won(r.ma20) : '-',
          r.change5d != null ? r.change5d.toFixed(1) + '%' : '-',
          r.rsi14 != null ? r.rsi14.toFixed(0) : '-',
          r.atrPct != null ? r.atrPct.toFixed(1) + '%' : '-',
          r.drawdownPct != null ? '-' + r.drawdownPct.toFixed(1) + '%' : '-',
        ].join(' | ')
      : '- | - | - | - | - | -';
    return `| ${q.name} | ${q.symbol} | ${won(q.price)} | ${q.changeRate}% | ${extra} |`;
  }).join('\n');

  const posRows = i.positions.length === 0 ? '(없음)' : i.positions.map(p => {
    const cur = i.quotes.find(q => q.symbol === p.symbol)?.price ?? p.avgPrice;
    const pnl = ((cur / p.avgPrice - 1) * 100).toFixed(2);
    const t = p.thesis
      ? `thesis: ${p.thesis.why} / 목표 ${p.thesis.target} / 손절 ${p.thesis.stop} / 청산조건 ${p.thesis.exitCondition}`
      : 'thesis 없음';
    return `- ${p.name}(${p.symbol}) ${p.quantity}주 @ ${won(p.avgPrice)} (평가 ${pnl}%) — ${t}`;
  }).join('\n');

  const recent = i.recentDecisions.length === 0 ? '(없음)' : i.recentDecisions.map(d => `- ${d}`).join('\n');
  const noIndicators = i.indicators.length === 0;

  // 회고는 있을 때만 섹션을 넣는다 (초기엔 비어 있으므로 프롬프트를 어지럽히지 않음)
  const reflectionBlock = i.reflections.length === 0 ? '' :
    `\n## 과거 매매 회고 (청산된 thesis의 적중/실패 — 같은 실수를 반복하지 마십시오)
${i.reflections.map(r => `- ${r}`).join('\n')}\n`;

  return `당신은 자동매매 시스템의 의사결정 엔진입니다. 아래 전략 문서를 따르되, 확신이 없으면 HOLD 하십시오.
거래에는 비용(수수료+세금+스프레드, 왕복 약 0.3%)이 들므로 잦은 회전매매는 그 자체로 손실입니다.

## 전략 문서
${i.strategyDocs}

## 계좌 상태
- 현금: ${won(i.cash)}원 / 총자산: ${won(i.equity)}원 / 당일 손익: ${i.dailyPnlPct.toFixed(2)}%
- 오늘 주문: ${i.ordersToday}/${i.limits.maxOrdersPerDay}건

## 보유 포지션 (각 포지션의 thesis는 당신이 진입 시 세운 논지입니다. 청산 판단은 thesis 기준으로.)
${posRows}
${reflectionBlock}
## 시세 (현재가 | 등락률 | 5일선 | 20일선 | 5일등락 | RSI | ATR% | 낙폭)
${noIndicators ? '※ 지표 데이터 없음 — 현재가 외 정보는 추정하지 말 것.' : 'RSI 70↑ 과매수·30↓ 과매도, ATR%는 변동성, 낙폭은 최근 20봉 고점 대비.'}
| 종목명 | 코드 | 현재가 | 등락률 | 5일선 | 20일선 | 5일등락 | RSI | ATR% | 낙폭 |
|--------|------|--------|--------|-------|--------|---------|-----|------|------|
${quoteRows}

## 최근 판단 (최신순 20개)
\`\`\`
${recent}
\`\`\`

## 제약 (코드로 강제됨 — 위반 주문은 거부됩니다)
- 종목당 비중 ≤ ${i.limits.maxPositionPct}%, 1회 주문 ≤ 총자산의 ${i.limits.maxOrderPct}%, 일일 손실 ${i.limits.dailyLossLimitPct}% 도달 시 신규 매수가 차단됨 (매도는 허용)
- 사이클당 ≤ ${i.limits.maxOrdersPerCycle}건, 일일 ≤ ${i.limits.maxOrdersPerDay}건, 총 노출 ≤ ${i.limits.maxTotalExposurePct}%
- 매도 후 같은 종목 재매수는 ${i.limits.reentryCooldownMin}분 쿨다운${i.limits.minHoldMin > 0 ? `\n- 이익 실현 매도는 매수 후 ${i.limits.minHoldMin}분 이상 보유해야 함 (평가손 손절 매도는 즉시 허용)` : ''}

## 출력 형식 (JSON만, 다른 텍스트 금지)
{
  "marketView": "시장 상황 한 줄",
  "decisions": [
    { "action": "BUY", "symbol": "코드", "quantity": 정수, "orderType": "LIMIT"|"MARKET", "limitPrice": 숫자(LIMIT시),
      "reasoning": "근거", "thesis": { "why": "진입 근거", "target": "+N%", "stop": "-N%", "exitCondition": "청산 조건" } },
    { "action": "SELL", "symbol": "코드", "quantity": 정수, "orderType": "MARKET", "reasoning": "thesis 대비 어떤 조건 충족/위반인지" },
    { "action": "HOLD", "reasoning": "관망 이유" }
  ]
}
BUY에는 thesis가 반드시 필요합니다. 관망이면 decisions에 HOLD 하나만 넣으십시오.`;
}
