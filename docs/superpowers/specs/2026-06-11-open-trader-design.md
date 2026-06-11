# open-trader — 설계 문서

**날짜**: 2026-06-11
**상태**: 승인됨 (사용자 승인 완료)
**대체 대상**: `~/toss-autotrader` (검증된 모듈 이식 후 기존 프로젝트 삭제 예정)

## 1. 개요

어떤 증권사든 **OpenAPI 문서 URL과 API 키만 입력하면** Claude(구독, `claude -p`)가
해당 증권사용 어댑터를 자동 생성·검증해 연결하고, **자연어 전략 문서**에 따라
자동매매를 운영하는 범용 AI 트레이딩 하네스. GitHub 오픈소스로 공유한다.

받는 사람의 경험: `git clone → npm install → npm start` → 브라우저에서 온보딩
위저드가 열리고, 완료하면 같은 서버가 운영 대시보드로 전환된다.

### 확정된 요구사항

| 항목 | 결정 |
|------|------|
| 시작 방식 | 새 저장소(`~/open-trader`). toss-autotrader에서 검증된 모듈(PaperBroker, 가드레일, 스토어 등)을 범용화해 이식. 기존 폴더는 완성 후 삭제 |
| 배포 형태 | GitHub 오픈소스 (README 설치 가이드, 면책 고지 포함) |
| 브로커 지원 | 순수 뼈대 — 내장 어댑터 없음. 사용자가 OpenAPI docs URL + API 키 입력 → **Claude가 어댑터 자동 생성** → 검증 게이트 통과 시 활성화 |
| 전략 | 자연어 문서(여러 개 가능). 없으면 온보딩 인터뷰로 Claude가 초안 생성 |
| 라이브 정책 | 페이퍼 기본 + 3중 잠금해제 (설정 + 환경변수 + 최초 1회 타이핑 확인) |
| 아키텍처 | 올인원 웹 온보딩 (B안) — 온보딩과 운영이 같은 서버, 같은 브라우저 |
| 프론트 | 토스증권 참고, **토스 다크(앱 무드) + 벤치마크 카드** (사용자 시안 선택 확정) |

### 핵심 원칙

1. **Claude는 판단만, 돈이 움직이는 경로는 전부 결정론적 코드.** 어댑터 생성도
   Claude가 하지만, 생성된 코드는 검증 게이트를 통과해야만 로드된다.
2. **불확실하면 거래하지 않는다.** 모든 에러의 기본 동작은 "아무것도 안 함".
3. **페이퍼 기본, 라이브는 3중 잠금.**
4. **이전 리뷰 교훈을 뼈대에 내장**: 포지션별 thesis 메모리(플립플롭 방지),
   벤치마크 대비 수익률, 일일 주문 상한·재매수 쿨다운·총노출 상한,
   체결-저장 트랜잭션 원자화, 페이퍼 체결에 스프레드 비용 모델 포함.

## 2. 아키텍처

Node.js + TypeScript 단일 프로세스. 모드는 설정 존재 여부로 자동 결정.

```
┌──────────────────────── open-trader 데몬 ────────────────────────┐
│ [온보딩 모드]  설정 없음 → 웹 온보딩 플로우 서빙                    │
│  Setup Orchestrator → Adapter Generator(claude -p)               │
│                     → Validation Gate → 활성화                    │
│                                                                  │
│ [운영 모드]  설정 완료 → 트레이딩 루프                              │
│  Scheduler → Brain Runner → Guardrails → Broker → Store(SQLite)  │
│      └──▶ BrokerAdapter (자동 생성 코드, adapters/<broker>/)       │
│                                                                  │
│  Dashboard Server(:3000) — 온보딩 UI + 운영 대시보드, SSE          │
└──────────────────────────────────────────────────────────────────┘
```

| 컴포넌트 | 역할 | 출처 |
|---------|------|------|
| **BrokerAdapter 규격** | 인증·시세·잔고·주문 표준 TypeScript 인터페이스 (§4) | 신규 |
| **Adapter Generator** | docs URL fetch → `claude -p`로 규격 구현 코드 생성 | 신규 |
| **Validation Gate** | 정적 검사 + 컴파일 + 읽기 전용 실연결 테스트 (§3) | 신규 |
| **Setup Orchestrator** | 온보딩 위저드 상태 머신, 진행 로그 SSE 스트리밍 | 신규 |
| **PaperBroker** | 가상 체결: 수수료·세금 + **스프레드 비용 모델**(설정 가능한 half-spread, 기본 0.05%) | 이식+개선 |
| **Guardrails** | §6의 7개 규칙, 코드 강제 | 이식+보강 |
| **Brain Runner** | `claude -p` 1회/사이클, strategy 문서 + thesis 주입, zod 스키마 검증, 1회 재시도 | 이식+보강 |
| **State Store** | SQLite(WAL). 체결 기록 + 브로커 상태 저장을 **단일 트랜잭션**으로 | 이식+수정 |
| **Scheduler** | 장중 사이클 틱 (기본 30분, config 조정). 장외 휴면 | 이식+수정 |
| **Dashboard** | 온보딩 + 운영 화면, 토스 다크 디자인 (§8) | 신규 |

## 3. 온보딩 플로우 & 어댑터 생성 파이프라인

5단계 위저드 (브라우저):

```
① 브로커 등록 → ② 어댑터 생성 → ③ 연결 테스트 → ④ 전략 설정 → ⑤ 운전 시작
```

**① 브로커 등록**: 브로커 이름, OpenAPI docs URL(복수 가능), API 키/시크릿,
계좌번호 입력. 시크릿은 `.env`(gitignore)에만 저장 — 브라우저 폼 → 로컬 서버
→ `.env` 경로 외에는 어디에도 남지 않는다.

**② 어댑터 생성 (핵심 루프)**:
1. docs URL fetch — OpenAPI JSON이면 파싱, HTML이면 텍스트 추출.
2. `claude -p`에 [BrokerAdapter 인터페이스 + 문서 내용 + 작성 규칙]을 주고
   TypeScript 어댑터 생성 → `adapters/<broker-id>/adapter.ts` 저장.
   진행 로그는 SSE로 화면에 실시간 표시.
3. **Validation Gate** (생성 코드는 untrusted input):
   - 정적 검사: import 화이트리스트(내장 fetch 외 fs/child_process/eval류 금지),
     네트워크 호출은 등록된 브로커 base URL로만, 시크릿 로깅 금지,
     시크릿 하드코딩 금지(런타임 환경변수 주입 규격 강제).
   - 컴파일: `tsc` 통과.
   - 실연결 테스트(읽기 전용 3종): `auth()` → `getQuotes()` 1건 → `getBalance()`.
     **주문 API는 검증 단계에서 절대 호출하지 않는다.**
4. 실패 시 에러를 Claude에 피드백해 재생성, 최대 3회. 3회 실패 시 생성 로그와
   함께 수동 개입 안내.
5. 통과한 어댑터만 레지스트리(`adapters/registry.json`)에 등록.

**④ 전략 설정**: 두 경로 —
- 업로드: 전략 문서(md/txt 복수) 드래그앤드롭 → `strategy/` 저장.
- 인터뷰: 성향(공격/중립/보수)·자금 규모·투자 기간·선호 섹터를 폼으로 받아
  Claude가 `strategy/strategy.md` 초안 생성 → 화면에서 즉시 편집 가능.

**종목 유니버스**: 두뇌가 후보로 삼는 종목 리스트(`strategy/universe.json`).
사용자가 직접 입력하거나, 인터뷰 경로에서는 전략 초안과 함께 Claude가
생성한다(어댑터의 `getQuotes`로 전 종목 유효성 검증 후 저장). 시세 테이블과
벤치마크(동일가중)는 이 유니버스를 기준으로 한다.

**⑤ 운전 시작**: 가드레일 수치 폼(기본값 제공) → `config.json` 저장,
모드 확인(PAPER 고지 + 면책 동의) → 대시보드 전환.

**재온보딩**: 대시보드 설정 메뉴에서 브로커 추가/재생성, 전략 교체 가능.
활성 브로커는 동시 1개(v1).

## 4. BrokerAdapter 규격

```typescript
interface BrokerAdapter {
  // 필수
  auth(): Promise<void>;                      // 토큰 발급/갱신 (만료 시 자동 재호출)
  getQuotes(symbols: string[]): Promise<Quote[]>;
  getBalance(): Promise<Balance>;             // 현금 + 보유 포지션
  isMarketOpen(): Promise<boolean>;
  // 선택 — 문서에 해당 API가 있으면 구현하도록 생성 프롬프트에 지시
  getCandles?(symbol: string, interval: string, count: number): Promise<Candle[]>;
  getOrderbook?(symbol: string): Promise<Orderbook>;
  // 라이브 전용 — 3중 잠금해제 전에는 호출 경로가 코드 레벨에서 차단
  submitOrder?(order: OrderRequest): Promise<OrderResult>;
  cancelOrder?(orderId: string): Promise<void>;
}
```

어댑터 반환값도 zod로 런타임 검증한다 — 생성 코드가 규격을 어기면 사이클을
스킵하고 "어댑터 재생성 권장"을 표시한다. `MockAdapter`(랜덤워크 + 시나리오
주입)는 하네스에 내장되어 어댑터 없이도 데모/테스트 운전이 가능하다.

## 5. 매매 사이클 & 두뇌 계약

사이클 주기 기본 30분 (config `cycleMinutes`). 10분 루프가 수수료 출혈을
만든다는 이전 리뷰 결론을 반영한 기본값이다.

```
틱 → 장 열림 확인 → 시세/캔들 수집 → 페이퍼 지정가 큐 체결 처리
 → 컨텍스트 조립:
   전략 문서 전문 + 계좌 상태 + 시세 테이블(가능하면 캔들 기반 등락률·이동평균 포함)
   + 포지션별 thesis + 최근 판단 20개 + 가드레일 잔여 한도
 → claude -p 1회 (JSON 스키마 강제. 실패 시 1회 재시도, 또 실패하면 사이클 스킵)
 → 가드레일 필터 → 체결
 → [체결 기록 + 브로커 상태]를 단일 SQLite 트랜잭션으로 저장
 → 자산 스냅샷 + 벤치마크(유니버스 동일가중 보유 가정) 기록 → SSE 푸시
```

**두뇌 출력 계약** (zod discriminatedUnion):

```json
{
  "marketView": "시장 상황 한 줄",
  "decisions": [
    {
      "action": "BUY",
      "symbol": "005930",
      "quantity": 10,
      "orderType": "LIMIT",
      "limitPrice": 71200,
      "reasoning": "판단 근거 (대시보드 로그에 표시)",
      "thesis": { "why": "진입 근거", "target": "+6%", "stop": "-3%", "exitCondition": "청산 조건" }
    }
  ]
}
```

- BUY는 `thesis` 필수 → 포지션에 저장되어 이후 사이클마다 프롬프트에 주입.
- SELL의 `reasoning`에는 해당 포지션 thesis 대비 어떤 조건이 충족됐는지 쓰게 한다.
- HOLD는 `reasoning`만.

## 6. 가드레일 (코드 강제, 온보딩 ⑤단계에서 설정)

| 규칙 | 기본값 | 비고 |
|------|--------|------|
| 종목당 최대 비중 | 총자산의 20% | |
| 1회 주문 금액 상한 | 총자산의 10% | |
| 사이클당 최대 주문 | 3건 | |
| 일일 손실 한도 | -3% 도달 시 당일 신규 매수 정지 (매도 허용) | dayOpenEquity는 장 시작 30분 내에만 초기화 |
| 일일 최대 주문 수 | 10건 | 수수료 출혈 차단 |
| 동일 종목 재진입 쿨다운 | 매도 후 60분 | 플립플롭 차단 |
| 총 노출 상한 | 총자산의 80% | 풀베팅 방지 |

수량 정수·양수 검증, NaN/비유한 가격 차단, 시세 없는 종목 거부 등 기존
검증 로직은 그대로 이식한다. 거부된 주문도 사유와 함께 로그에 남는다.

**라이브 3중 잠금**: ① `config.json: "mode": "live"` ② 환경변수
`OPEN_TRADER_LIVE=1` ③ 최초 라이브 주문 직전 대시보드에서 계좌번호 끝 4자리
타이핑 확인. 하나라도 없으면 `submitOrder` 경로가 차단되고 페이퍼로 동작한다.

## 7. 페이퍼 체결 규칙

- 가상 시드 기본 1,000만 원 (설정 가능)
- MARKET: 매수 = ask(없으면 lastPrice + half-spread), 매도 = bid(없으면 lastPrice − half-spread). half-spread 기본 0.05%, config 조정
- LIMIT: 이후 틱에서 시세 도달 시 체결, 장 마감 시 미체결 자동 취소
- 수수료(기본 0.015%) + 매도 세금(기본 0.18%) — 요율은 config

## 8. 프론트엔드 (토스 다크 + 벤치마크 카드 — 시안 확정)

배경 `#101013`, 카드 `#1b1d22`(radius 16px), 수익 빨강 `#f04452`,
손실 파랑 `#3182f6`, 보조 텍스트 `#8b95a1`. 시스템 폰트(Pretendard 우선).

**운영 대시보드 구성** (확정 시안 기준):
1. 헤더: 로고, 모드 배지(PAPER/LIVE), 브로커 연결 상태, 다음 사이클 시각, 가드레일 상태
2. 상단 3카드: 총자산(누적/당일 수익률) · **vs KOSPI 벤치마크**(초과수익 %p) · 오늘 거래(일일 상한 대비 카운트 + 수수료 누적)
3. 자산 추이 차트(uPlot): 내 자산 vs 벤치마크 오버레이, 일중/1주/전체
4. 보유 포지션 테이블: 종목, 수량, 평단, 평가손익
5. AI 판단 로그(최신순): 시각, 액션 배지, 체결/거부, reasoning, thesis 표시. 가드레일 거부 기록 포함

**온보딩 위저드**: 같은 다크 톤, 5단계 진행 표시, 어댑터 생성 로그 실시간
스트리밍, 면책 고지 동의 체크.

벤치마크는 유니버스 동일가중 보유를 기본으로 하고, 어댑터가 지수 시세를
제공하면 KOSPI로 대체한다.

## 9. 에러 처리 & 무인 운영

| 상황 | 대응 |
|------|------|
| 어댑터 API 실패/타임아웃 | 사이클 스킵. 3회 연속 실패 시 대시보드 경고 + macOS 알림(`osascript`) |
| claude 세션 만료/rate-limit | stderr 패턴 감지 → "claude login 필요"를 대시보드·OS 알림으로 구분 표시. 매매 중단 |
| 생성 어댑터 런타임 비정상 응답 | zod 검증 실패 → 사이클 스킵 + "어댑터 재생성 권장" |
| 노트북 슬립 복귀 | dayOpenEquity 초기화는 장 시작 30분 내로 제한. 놓친 사이클은 스킵 |
| 데몬 크래시 | 단일 트랜잭션 저장이므로 SQLite에서 일관 복원 |
| 토큰 만료 | 어댑터 `auth()` 자동 재호출 |
| 429 rate limit | `Retry-After` 준수 후 1회 재시도 (생성 프롬프트 규칙에 포함) |

## 10. 테스트

1. **유닛**: PaperBroker(스프레드·수수료 포함), 가드레일 7규칙 전수, 두뇌 스키마(thesis 포함), Validation Gate 정적 검사기
2. **통합**: MockAdapter + claude 스텁 → 전체 사이클 1회, 트랜잭션 원자성·thesis 저장 검증
3. **생성 파이프라인**: 가짜 OpenAPI 문서 → 생성 → 게이트 시나리오 (위험 코드 주입 시 차단 확인 — fs 접근, 외부 URL 호출, 시크릿 하드코딩)
4. **E2E**: Playwright — 온보딩 위저드 전체 플로우 + 대시보드 핵심 표시

## 11. 프로젝트 구조

```
~/open-trader/
├── src/
│   ├── core/          # 타입, config, 사이클, 스케줄러
│   ├── broker/        # PaperBroker, BrokerAdapter 규격, MockAdapter
│   ├── brain/         # 프롬프트 조립, claude 러너, 스키마
│   ├── guardrails/
│   ├── setup/         # 온보딩 오케스트레이터, Adapter Generator, Validation Gate
│   └── server/        # HTTP + SSE, 온보딩/운영 라우팅
├── adapters/          # 자동 생성 어댑터 (gitignore)
├── strategy/          # 전략 문서 (gitignore)
├── public/            # 온보딩 + 대시보드 정적 자원
├── data/              # SQLite (gitignore)
├── .env.example
└── README.md          # 3줄 설치, 면책 고지
```

## 12. 범위 밖 (명시)

- 멀티 브로커 동시 운영 (활성 1개만)
- 미국/해외 주식 특화 처리 — 어댑터가 지원하면 동작은 하되 보장하지 않음
- 백테스팅 엔진
- 모바일 앱, 원격 접근, 사용자 인증 (로컬 전용 가정)
- 코드 레벨 전략 플러그인 (전략은 자연어 문서만)

## 13. 면책 및 공유 정책

- README 최상단과 온보딩 첫 화면에 투자 손실 자기책임 고지.
- 시크릿은 `.env`에만 저장, `adapters/`·`strategy/`·`data/`·`.env`는 gitignore —
  포크/공유 시 개인 정보가 저장소에 남지 않는 구조.
- 라이선스: MIT.
