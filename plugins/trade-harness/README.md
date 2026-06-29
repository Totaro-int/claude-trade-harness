# trade-harness (Claude Code 플러그인)

[claude-trade-harness](https://github.com/Totaro-int/claude-trade-harness)를 슬래시 커맨드로 제어하는 **얇은 런처 플러그인**입니다.

> 분석 엔진 자체는 이 플러그인에 들어 있지 않습니다. 별도로 클론한 하네스 앱이 분석을 수행하고, 이 플러그인은 온보딩 서버를 띄우고 분석을 돌리는 역할만 합니다. 주문은 실행하지 않습니다.

## 커맨드

| 커맨드 | 동작 |
|--------|------|
| `/trade-setup` | 첫 온보딩 — 의존성 설치 후 온보딩 서버를 띄워 증권사 키 입력·어댑터 자동생성 |
| `/trade-review` | 보유종목 4대가(버핏·멍거·돤융핑·리루) 가치투자 분석 실행 → `reports/portfolio-latest.md` 요약 |

각 커맨드는 선택적으로 하네스 프로젝트 경로를 인자로 받습니다.

## 사전 준비 — 하네스 앱 클론

```bash
git clone https://github.com/Totaro-int/claude-trade-harness ~/open-trader
```

플러그인은 다음 순서로 앱을 자동 탐색합니다: `$CLAUDE_TRADE_DIR` → 현재 디렉토리 → `~/open-trader` → `~/claude-trade-harness`. 다른 곳에 두었다면 `export CLAUDE_TRADE_DIR=/경로` 하거나 커맨드 인자로 경로를 넘기세요.

## 플러그인 설치

```text
/plugin marketplace add Totaro-int/claude-trade-harness
/plugin install trade-harness@claude-trade-harness
```

로컬 체크아웃에서 바로 쓰려면 마켓플레이스로 로컬 경로를 추가해도 됩니다:

```text
/plugin marketplace add ~/open-trader
/plugin install trade-harness@claude-trade-harness
```

## 요구사항

- Node.js 20+
- Claude Code CLI 로그인 상태 (하네스가 `claude -p`를 두뇌로 호출, 분석은 웹검색 사용)

## 안전 메모

- 키·시크릿은 브라우저 온보딩 폼으로만 입력되어 `.env`(0600)에만 저장됩니다. 커맨드는 대화로 시크릿을 받지 않습니다.
- 이 도구는 보유종목을 **읽어서 분석만** 하며 주문을 실행하지 않습니다. 산출 분석은 투자 자문이 아니며 모든 판단·손실은 사용자 책임입니다.
- 분석당 종목 수 × 약 5회 claude 호출(웹검색)이 발생하므로 비용·시간에 유의하세요.

라이선스: [MIT](../../LICENSE)
