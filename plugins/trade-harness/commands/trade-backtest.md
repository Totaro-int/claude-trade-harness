---
description: "claude-trade-harness 백테스트 — 과거 캔들 리플레이로 전략을 벤치마크 대비 평가(룩어헤드 없음)"
argument-hint: "[막대 수, 예: 120] [하네스 프로젝트 경로(선택)]"
allowed-tools: ["Bash", "Read"]
---

# claude-trade-harness 백테스트

실거래/페이퍼에 붙이기 전에 전략을 **위험 없이 과거 데이터로 평가**한다. 실제와 동일한 PaperBroker(수수료·세금·스프레드)·가드레일·프롬프트로 리플레이하고, 동일가중 buy-and-hold 대비 초과수익을 출력한다.

`$ARGUMENTS`에서 숫자는 막대 수(`--bars`), 경로처럼 보이는 토큰은 프로젝트 경로로 해석한다.

## 절차

1. **프로젝트 탐색 + 인자 파싱**:

   ```bash
   find_trade_dir() {
     for d in "$CLAUDE_TRADE_DIR" "$PWD" "$HOME/open-trader" "$HOME/claude-trade-harness"; do
       [ -n "$d" ] && [ -f "$d/package.json" ] && grep -q '"claude-trade-harness"' "$d/package.json" && { echo "$d"; return 0; }
     done
     return 1
   }
   DIR=$(find_trade_dir) || echo "NOT_FOUND"
   BARS=$(echo "$ARGUMENTS" | grep -oE '[0-9]+' | head -1)   # 없으면 기본 60
   ```

2. **실행** — 막대 수만큼 Claude를 호출하므로 비용/시간이 막대 수에 비례함을 미리 안내한다(긴 구간은 작게).

   ```bash
   cd "$DIR"
   if [ -n "$BARS" ]; then npm run backtest -- --bars "$BARS"; else npm run backtest; fi
   ```

3. **리포트 해석** — 출력에서 다음을 강조한다:
   - **excessPct (벤치마크 대비 초과수익, %p)** — 가장 중요한 "정직한 점수판". 대부분 음수이며 그게 정상임을 명시한다.
   - `totalReturnPct` vs `benchmarkReturnPct`, `maxDrawdownPct`, `trades`, `feesTotal`
   - 일봉 백테스트는 매수를 당일 종가에 체결하는 단순화를 쓰므로 절대 수익률은 다소 낙관적일 수 있으나, 벤치마크도 같은 기준이라 초과수익 비교는 공정하다는 점을 덧붙인다.

## 주의

- 백테스트는 데몬과 무관하게 단독 실행된다(포트 불필요). 운영 데몬을 멈출 필요 없다.
- claude CLI 로그인 상태여야 한다(막대마다 1회 호출).
