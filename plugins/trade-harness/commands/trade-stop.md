---
description: "claude-trade-harness 데몬 중지 — 백그라운드 운영/온보딩 서버 종료"
argument-hint: "[하네스 프로젝트 경로(선택)]"
allowed-tools: ["Bash", "Read"]
---

# claude-trade-harness 데몬 중지

`/trade-setup`·`/trade-start`로 띄운 백그라운드 데몬을 종료한다. 데몬은 SIGTERM 시 브로커 상태를 저장하고 깨끗이 내려간다.

## 절차

1. **프로젝트 탐색**:

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

2. **PID 파일로 정상 종료(SIGTERM)** — 데몬은 SIGTERM 핸들러에서 상태 저장 후 종료한다:

   ```bash
   PID=$(cat "$DIR/.trade-daemon.pid" 2>/dev/null)
   if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
     kill "$PID" && rm -f "$DIR/.trade-daemon.pid" && echo "STOPPED pid=$PID"
   else
     echo "NO_PID"
   fi
   ```

3. **PID 파일이 없거나 stale이면 포트로 폴백** — 포트를 점유한 프로세스를 찾아 종료한다(사용자 확인 후):

   ```bash
   lsof -ti tcp:$PORT 2>/dev/null   # 결과 PID 확인 후 kill
   ```

4. **확인** — 헬스체크가 더 이상 응답하지 않으면 종료 완료로 보고한다.

   ```bash
   curl -sf "http://localhost:$PORT/api/state" >/dev/null 2>&1 && echo "STILL_UP" || echo "DOWN"
   ```

## 주의

- 포트 폴백 종료는 같은 포트의 무관한 프로세스를 죽일 수 있으니, PID를 보여주고 사용자 확인 후 실행한다.
