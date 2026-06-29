# ai-berkshire 이식 설계 (open-trader)

ai-berkshire(가치투자 리서치 프레임워크, Python 스킬 모음)를 open-trader 하네스로
**전체 이식**한다. 목표는 토스 OpenAPI로 **실제 보유 종목을 받아 4대가 관점으로 평가하고,
어떻게 투자하면 좋을지 분석**하는 advisory 하네스.

## 방향 전환의 핵심

- 산출물: **주문(JSON) → 보유종목 진단 리포트**.
- 그 결과 **돈이 움직이는 경로(검증 안 된 `submitOrder`·가드레일·페이퍼 체결)가 불필요**해지고
  최대 리스크가 제거된다. (기존 trading 경로는 당장 삭제하지 않고 advisory와 병존시킨 뒤 정리.)
- Claude 호출은 기존 `src/brain/runner.ts`(`runClaude`/`runClaudeText`)를 재사용한다.
  ai-berkshire의 Team/Task 멀티에이전트는 **병렬 `runClaude` 서브프로세스**로 옮긴다.

## 데이터 소스 (사용자 결정: 전체)

| 소스 | 제공 | 비고 |
|---|---|---|
| 토스 OpenAPI | 보유종목·현금·시세·캔들·호가 | `getBalance()`가 실보유(KR) 반환 |
| Claude 웹리서치 | 재무·뉴스·경영진·해자 (펀더멘털) | 각 마스터 렌즈 에이전트가 WebSearch |
| 한국 재무 API(DART 등) | 결정론적 재무 수치 | 후속 어댑터로 추가 (Phase 7) |

토스는 펀더멘털을 안 주므로, 4대가 분석의 펀더멘털은 Claude 웹리서치가 채운다(ai-berkshire의
`investment-team`·`earnings-review`·`news-pulse` 방식과 동일).

## ai-berkshire → open-trader 매핑

| ai-berkshire | 이식 위치 | 상태 |
|---|---|---|
| `tools/financial_rigor.py` | `src/research/rigor.ts` | Phase 1 |
| 4대가 프레임워크 + anti-bias(CLAUDE.md) | `src/research/masters.ts` | Phase 2 |
| `investment-team.md` (4-에이전트 병렬+종합) | `src/research/panel.ts` | Phase 3 |
| `portfolio-review.md` (집중도·상관·기회비용·스트레스) | `src/research/portfolio.ts` | Phase 4 |
| 리포트 출력/저장 (`reports/*`) | `src/research/report.ts` + store | Phase 5 |
| 엔트리포인트 `/portfolio-review` | `src/review/main.ts` (`npm run review`) | Phase 6 |
| 재무 API 어댑터 | `src/research/fundamentals/` | Phase 7 (후속) |

## 4대가 렌즈 (investment-team 매핑)

| 렌즈 | 마스터 | 분석축 |
|---|---|---|
| business | 段永平(돤융핑) | 비즈니스 모델·해자·차별화·정가권 |
| financial | 巴菲特(버핏) | 재무·수익성·현금흐름·안전마진·estimation |
| industry | 芒格(멍거) | 산업 격국·경쟁·산업체인 |
| risk | 李录(리루) | 리스크·경영진·장기 확실성 |

## anti-bias 핵심 (CLAUDE.md 원칙 이식)

- 객관 우선: 사실/관점 분리, "데이터에 따르면" 표현.
- 정반양면: 모든 핵심 판단에 반대 논거 동반.
- 정보충실도 A/B/C 등급(자료량 ≠ 확실성).
- 불확실하면 "데이터 부족" 정직 표기, 추측으로 프레임 채우지 않기.
- red-line veto: 기존 `skeptic.ts` 구조 재사용.
- thesis에 confidence(A/B/C) + invalidation(반증조건) 추가.

## 단계별 실행 (각 단계 독립 검증)

1. **Phase 1 — rigor.ts**: financial_rigor 순수함수 포팅 + 단위테스트. LLM 무관, TDD 토대.
   - `verifyMarketCap`, `verifyValuation`, `crossValidate`, `threeScenario`, `benford`.
2. **Phase 2 — masters.ts**: 4 렌즈 프롬프트 빌더 + anti-bias 프리앰블 + zod 출력 스키마.
3. **Phase 3 — panel.ts**: 종목 1개 → 4 렌즈 병렬 `runClaude` → team-lead 종합 판정.
4. **Phase 4 — portfolio.ts**: 토스 getBalance → 종목별 panel → 포트폴리오 집계.
5. **Phase 5 — report.ts**: `reports/portfolio-latest.md` + 종목별 리포트 + store + 대시보드.
6. **Phase 6 — review/main.ts**: 엔트리포인트·토스 어댑터 연결·config·`npm run review`.
7. **Phase 7 — fundamentals 어댑터**: DART 등 결정론적 재무 소스(후속).

## 검산 게이트 (실측 1회 후 추가)

financial 렌즈가 `metrics`(price·sharesOutstanding·reportedMarketCap·eps·bvps)를 구조화 출력하고,
`src/research/rigor-gate.ts`의 `checkLensMetrics`가 받는 즉시 `verifyMarketCap`을 돌려 편차>5%면
`CompanyAnalysis.rigorWarnings`에 담아 리포트 최상단에 🚨로 박는다. LLM의 "검산했다"는 말을
신뢰하지 않고 코드로 강제. (실측에서 삼성 시총을 5배 환각한 사례를 잡기 위함.)

## 검증 기준

- Phase 1: `npm test` rigor 테스트 그린 (Python 출력과 수치 일치).
- Phase 3: 단일 종목 리포트가 4 렌즈+종합 구조로 생성.
- Phase 4: 실보유 N종목 → portfolio-latest.md 생성, 집중도/기회비용/스트레스 포함.
