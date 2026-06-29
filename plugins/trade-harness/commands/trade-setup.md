---
description: "claude-trade-harness 첫 온보딩 — 의존성 설치 후 온보딩 서버를 띄워 증권사 키 입력/어댑터 생성"
argument-hint: "[하네스 프로젝트 경로(선택)]"
allowed-tools: ["Bash", "Read"]
---

# claude-trade-harness 온보딩 시작

AI 가치투자 분석 하네스의 **첫 실행 온보딩**을 준비하고 서버를 띄운다. 이 플러그인은 런처일 뿐이며, 분석 엔진은 사용자가 클론해 둔 하네스 앱에서 동작한다. 온보딩이 끝나면 `/trade-review`로 보유종목 분석을 실행한다.

인자(`$ARGUMENTS`)가 있으면 그것을 프로젝트 경로로 사용한다.

## 절차

1. **하네스 프로젝트 디렉토리 탐색** — 아래 순서로 찾고, 못 찾으면 사용자에게 클론 위치를 묻는다. (미설치면 `git clone https://github.com/Totaro-int/claude-trade-harness` 안내)

   ```bash
   find_trade_dir() {
     for d in "$1" "$CLAUDE_TRADE_DIR" "$PWD" "$HOME/open-trader" "$HOME/claude-trade-harness"; do
       [ -n "$d" ] && [ -f "$d/package.json" ] && grep -q '"claude-trade-harness"' "$d/package.json" && { echo "$d"; return 0; }
     done
     return 1
   }
   DIR=$(find_trade_dir "$ARGUMENTS") || echo "NOT_FOUND"
   ```

2. **사전 점검** — Node 20+ 와 Claude CLI 로그인 상태를 확인한다.

   ```bash
   node --version            # v20 이상이어야 함
   command -v claude && claude --version   # 없으면 설치/로그인 안내
   ```

3. **의존성 설치** — `node_modules`가 없으면 설치한다.

   ```bash
   [ -d "$DIR/node_modules" ] || (cd "$DIR" && npm install)
   ```

4. **이미 설정됨 여부 확인** — `config.json`에 brokerId가 있고 `adapters/`가 차 있으면 이미 온보딩 완료 상태다. 그 경우 `/trade-review`를 안내하고 멈춘다.

5. **온보딩 서버를 백그라운드로 시작** — `npm run onboard`가 setup 마법사를 띄운다.

   ```bash
   PORT=$(node -e "try{console.log(require('$DIR/config.json').port||3000)}catch{console.log(3000)}")
   cd "$DIR"
   nohup npm run onboard > /tmp/claude-trade-harness.log 2>&1 &
   echo $! > "$DIR/.trade-daemon.pid"
   for i in $(seq 1 30); do curl -sf "http://localhost:$PORT/api/setup/status" >/dev/null 2>&1 && break; sleep 0.5; done
   ```

6. **결과 보고** — 온보딩 URL(`http://localhost:$PORT`)을 안내하고, macOS면 `open`으로 브라우저를 연다. 로그 위치(`/tmp/claude-trade-harness.log`)도 알린다.

   ```bash
   [ "$(uname)" = "Darwin" ] && open "http://localhost:$PORT" 2>/dev/null || true
   ```

## 주의

- 시작이 실패하면 `/tmp/claude-trade-harness.log` 마지막 부분을 보여주고 원인을 진단한다.
- 키·시크릿은 브라우저 온보딩 폼에서만 입력받으며 `.env`(0600)에만 저장된다 — 절대 대화로 받지 않는다.
- 이 도구는 보유종목을 읽어 분석만 하며 주문을 실행하지 않는다. 온보딩 후 `/trade-review`로 분석을 실행한다.
