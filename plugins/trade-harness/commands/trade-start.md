---
description: "claude-trade-harness 운영 데몬 시작 — 장중 30분 사이클로 페이퍼 트레이딩 + 대시보드"
argument-hint: "[하네스 프로젝트 경로(선택)]"
allowed-tools: ["Bash", "Read"]
---

# claude-trade-harness 운영 데몬 시작

온보딩이 끝난 하네스를 **운영 모드**로 백그라운드 실행한다. 장중에는 30분 사이클로 Claude 판단 + 코드 가드레일 → 페이퍼 체결이 돌고, 토스 스타일 대시보드가 뜬다.

인자(`$ARGUMENTS`)가 있으면 프로젝트 경로로 사용한다.

## 절차

1. **프로젝트 탐색** (`/trade-setup`과 동일 로직):

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

2. **온보딩 완료 확인** — `config.json`에 brokerId가 없으면(또는 mock도 아니면) 아직 미설정이다. `/trade-setup`을 먼저 하라고 안내하고 멈춘다. (단 `brokerId: "mock"`이면 데모 실행 허용)

3. **중복 실행 방지** — 이미 떠 있으면(헬스체크 성공) 새로 띄우지 말고 기존 URL을 안내한다.

   ```bash
   if curl -sf "http://localhost:$PORT/api/state" >/dev/null 2>&1; then echo "ALREADY_RUNNING"; fi
   ```

4. **백그라운드 시작 + 헬스 대기**:

   ```bash
   cd "$DIR"
   nohup npm start > /tmp/claude-trade-harness.log 2>&1 &
   echo $! > "$DIR/.trade-daemon.pid"
   for i in $(seq 1 40); do curl -sf "http://localhost:$PORT/api/state" >/dev/null 2>&1 && break; sleep 0.5; done
   ```

5. **결과 보고** — 대시보드 URL을 안내하고 macOS면 `open` 한다. 헬스체크가 끝내 실패하면 로그 마지막 부분으로 원인을 진단한다(예: claude 미로그인, 어댑터 인증 실패, universe.json 누락).

   ```bash
   [ "$(uname)" = "Darwin" ] && open "http://localhost:$PORT" 2>/dev/null || true
   tail -20 /tmp/claude-trade-harness.log
   ```

## 주의

- v1은 라이브 주문을 실행하지 않는다(페이퍼 전용, 3중 잠금). 데몬이 떠도 실제 주문은 나가지 않는다.
- 데몬은 `nohup`으로 세션과 분리되어 계속 돈다. 끄려면 `/trade-stop`.
