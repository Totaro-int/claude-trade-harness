# trade-harness (Claude Code 플러그인)

[claude-trade-harness](https://github.com/Totaro-int/claude-trade-harness)를 슬래시 커맨드로 제어하는 **얇은 런처 플러그인**입니다.

> 매매 엔진 자체는 이 플러그인에 들어 있지 않습니다. 별도로 클론한 하네스 앱이 백그라운드 데몬으로 동작하고, 이 플러그인은 그것을 띄우고·멈추고·들여다보는 역할만 합니다.

## 커맨드

| 커맨드 | 동작 |
|--------|------|
| `/trade-setup` | 첫 온보딩 — 의존성 설치 후 온보딩 서버를 띄워 증권사 키 입력·어댑터 자동생성 |
| `/trade-start` | 운영 데몬을 백그라운드로 시작 (장중 30분 사이클 페이퍼 트레이딩 + 대시보드) |
| `/trade-status` | 현재 자산·일손익·**벤치마크 대비 초과수익**·보유 포지션·최근 판단 요약 |
| `/trade-stop` | 데몬 정상 종료(SIGTERM, 상태 저장) |
| `/trade-backtest [막대수]` | 과거 캔들 리플레이로 전략 평가 (룩어헤드 없음) |

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
- Claude Code CLI 로그인 상태 (하네스가 `claude -p`를 두뇌로 호출)

## 안전 메모

- 키·시크릿은 브라우저 온보딩 폼으로만 입력되어 `.env`(0600)에만 저장됩니다. 커맨드는 대화로 시크릿을 받지 않습니다.
- v1은 라이브 주문을 실행하지 않습니다(페이퍼 전용). 생성된 어댑터의 주문 경로는 미검증이므로 라이브 전 사람이 직접 검토해야 합니다.

라이선스: [MIT](../../LICENSE)
