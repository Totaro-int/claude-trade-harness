---
description: "보유종목 4대가 가치투자 분석 실행 — npm run review 후 리포트 요약"
argument-hint: "[하네스 프로젝트 경로(선택)]"
allowed-tools: ["Bash", "Read"]
---

# 보유종목 분석 실행

토스 OpenAPI에서 실보유 종목을 받아 4대가(버핏·멍거·돤융핑·리루) 관점으로 분석하고
`reports/portfolio-latest.md` 진단 리포트를 생성한다. 주문은 실행하지 않는다(읽기 전용).

인자(`$ARGUMENTS`)가 있으면 그것을 프로젝트 경로로 사용한다.

## 절차

1. **하네스 프로젝트 디렉토리 탐색** — 못 찾으면 `/trade-setup` 안내.

   ```bash
   find_trade_dir() {
     for d in "$1" "$CLAUDE_TRADE_DIR" "$PWD" "$HOME/open-trader" "$HOME/claude-trade-harness"; do
       [ -n "$d" ] && [ -f "$d/package.json" ] && grep -q '"claude-trade-harness"' "$d/package.json" && { echo "$d"; return 0; }
     done
     return 1
   }
   DIR=$(find_trade_dir "$ARGUMENTS") || echo "NOT_FOUND"
   ```

2. **온보딩 여부 확인** — `config.json`에 brokerId가 없으면 `/trade-setup`을 먼저 안내하고 멈춘다.

   ```bash
   node -e "try{process.exit(require('$DIR/config.json').brokerId?0:1)}catch{process.exit(1)}" \
     || echo "온보딩 필요 — /trade-setup 먼저 실행"
   ```

3. **분석 실행** — `npm run review`. 종목당 claude를 약 5회(4 렌즈 + 종합) 호출하며
   렌즈는 웹검색을 사용하므로 보유 종목 수에 비례해 수 분~수십 분이 걸릴 수 있음을 미리 알린다.

   ```bash
   cd "$DIR" && npm run review
   ```

4. **리포트 요약** — 생성된 `reports/portfolio-latest.md`를 읽어 핵심만 요약 보고한다:
   조합 건전도 · "가장 먼저 할 일" · 최대 리스크 · 종목별 판정(준입/조건부/회색)과
   포지션 권고(추가/유지/축소/청산). 🚨 검산 경고가 있으면 반드시 함께 보고한다.

   ```bash
   cat "$DIR/reports/portfolio-latest.md"
   ```

## 주의

- 산출 분석은 **투자 자문이 아니다.** 모든 판단·손실은 사용자 책임임을 상기시킨다.
- 펀더멘털은 Claude 웹검색에 의존하므로 출처를 직접 검증한 결과로 신뢰하지 말 것.
- LLM은 비결정적이라 같은 종목도 실행마다 결과가 달라질 수 있다.
