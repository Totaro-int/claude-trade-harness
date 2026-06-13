---
description: "claude-trade-harness 현재 상태 — 자산·일손익·벤치마크 대비 초과수익·보유 포지션·최근 판단"
argument-hint: "[하네스 프로젝트 경로(선택)]"
allowed-tools: ["Bash", "Read"]
---

# claude-trade-harness 상태 조회

운영 중인 데몬의 `/api/state`를 읽어 사람이 읽기 쉽게 요약한다.

## 절차

1. **프로젝트/포트 탐색**:

   ```bash
   find_trade_dir() {
     for d in "$1" "$CLAUDE_TRADE_DIR" "$PWD" "$HOME/open-trader" "$HOME/claude-trade-harness"; do
       [ -n "$d" ] && [ -f "$d/package.json" ] && grep -q '"claude-trade-harness"' "$d/package.json" && { echo "$d"; return 0; }
     done
     return 1
   }
   DIR=$(find_trade_dir "$ARGUMENTS") || echo "NOT_FOUND"
   PORT=$(node -e "try{console.log(require('$DIR/config.json').port||3000)}catch{console.log(3000)}")
   ```

2. **상태 조회**:

   ```bash
   curl -sf "http://localhost:$PORT/api/state"
   ```

   - 연결 실패 → 데몬이 안 떠 있는 것. `/trade-start`를 안내한다.

3. **요약 출력** — JSON에서 아래를 뽑아 표/불릿으로 정리한다:
   - `brokerName`, `mode`(paper/live), `equity`·`cash`·`initialCash`
   - `totalReturnPct`(절대 수익률)와 **`benchmark` 대비 초과수익** — 정직한 점수판은 벤치마크 대비 값이며 음수가 정상임을 한 줄로 덧붙인다
   - `dailyPnlPct`, `ordersToday`/`maxOrdersPerDay`, `feesTotal`
   - `positions[]`: 종목·수량·평단·현재가·`pnlPct`
   - `decisions[]` 최근 3건: action·status·reasoning 요약
   - `warning`이 있으면 강조(예: claude 인증 필요), `consecutiveErrors`가 1↑면 경고

## 주의

- 절대 수익률만 보고 좋다/나쁘다 판단하지 말 것. 항상 벤치마크 대비로 해석한다.
- 시크릿은 응답에 포함되지 않는다(설계상). 혹시 키처럼 보이는 값이 있으면 출력하지 말고 보고한다.
