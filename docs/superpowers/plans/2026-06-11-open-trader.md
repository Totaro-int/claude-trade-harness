# open-trader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 어떤 증권사든 OpenAPI 문서 URL + API 키 입력으로 Claude가 어댑터를 자동 생성·검증해 연결하고, 자연어 전략 문서로 자동매매를 운영하는 공유 가능한 범용 AI 트레이딩 하네스.

**Architecture:** Node/TS 단일 데몬. 설정 부재 시 웹 온보딩 모드(어댑터 생성 파이프라인), 설정 완료 시 운영 모드(스케줄러→두뇌→가드레일→브로커→SQLite). 검증된 모듈은 `/Users/songseungju/toss-autotrader`에서 이식. 스펙: `docs/superpowers/specs/2026-06-11-open-trader-design.md`.

**Tech Stack:** Node 20+, TypeScript(ESM/NodeNext), tsx, vitest, better-sqlite3(WAL), zod, uPlot, Playwright, `claude -p` CLI.

**이식 원본 경로**: `/Users/songseungju/toss-autotrader` (이하 `$OLD`). 모든 작업 디렉토리는 `/Users/songseungju/open-trader`.

**공통 규칙**:
- 퍼센트 한도(가드레일)는 정수 퍼센트(20 = 20%), 요율(fee/tax/halfSpread)은 소수(0.00015).
- 커밋은 각 태스크 마지막 단계에서 수행.
- `cp` 후 import 경로는 항상 새 디렉토리 구조에 맞게 수정한다 (각 태스크에 명시).

---

### Task 1: 프로젝트 골격

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `playwright.config.ts`, `.gitignore`, `.env.example`

- [ ] **Step 1: package.json 작성**

```json
{
  "name": "open-trader",
  "version": "0.1.0",
  "description": "Universal AI auto-trading harness — bring your broker's OpenAPI docs, Claude builds the adapter",
  "private": true,
  "type": "module",
  "license": "MIT",
  "scripts": {
    "dev": "tsx src/main.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "e2e": "playwright test"
  },
  "dependencies": {
    "better-sqlite3": "^12.10.0",
    "uplot": "^1.6.32",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@playwright/test": "^1.60.0",
    "@types/better-sqlite3": "^7.6.13",
    "@types/node": "^25.9.3",
    "tsx": "^4.22.4",
    "typescript": "^6.0.3",
    "vitest": "^4.1.8"
  }
}
```

- [ ] **Step 2: 설정 파일 이식**

Run:
```bash
cd /Users/songseungju/open-trader
cp /Users/songseungju/toss-autotrader/tsconfig.json .
cp /Users/songseungju/toss-autotrader/vitest.config.ts .
cp /Users/songseungju/toss-autotrader/playwright.config.ts .
mkdir -p src/core src/broker src/brain src/guardrails src/setup src/server public tests/fixtures e2e adapters strategy data
```

- [ ] **Step 3: .gitignore 작성**

```
node_modules/
data/
adapters/
strategy/
.env
.superpowers/
test-results/
playwright-report/
```

- [ ] **Step 4: .env.example 작성**

```
# 온보딩 위저드가 자동으로 .env를 생성합니다. 수동 설정 시 참고용.
BROKER_API_KEY=
BROKER_API_SECRET=
BROKER_ACCOUNT_NO=
# 라이브 잠금해제 2단계 (1단계: config.json mode, 3단계: 대시보드 확인)
OPEN_TRADER_LIVE=
```

- [ ] **Step 5: 설치 및 커밋**

Run: `npm install && npx tsc --noEmit`
Expected: 에러 없음 (소스 없으므로 통과)

```bash
git add -A && git commit -m "chore: 프로젝트 골격"
```

---

### Task 2: 코어 타입 + BrokerAdapter 규격

**Files:**
- Create: `src/core/types.ts`, `src/broker/adapter.ts`
- Test: `tests/adapter-wrap.test.ts`

- [ ] **Step 1: src/core/types.ts 작성** ($OLD/src/types.ts 기반 + Thesis/Candle/Orderbook/Balance 추가)

```typescript
export type Side = 'BUY' | 'SELL';
export type OrderType = 'LIMIT' | 'MARKET';

export interface Quote {
  symbol: string;
  name: string;
  price: number;       // 현재가
  bid: number;         // 매수호가 (매도 체결 기준)
  ask: number;         // 매도호가 (매수 체결 기준)
  changeRate: number;  // 당일 등락률 % (모르면 0)
  volume: number;      // 모르면 0
}

export interface Candle {
  time: string;   // ISO 또는 YYYY-MM-DD
  open: number; high: number; low: number; close: number; volume: number;
}

export interface OrderbookLevel { price: number; quantity: number }
export interface Orderbook { symbol: string; bids: OrderbookLevel[]; asks: OrderbookLevel[] }

export interface BalancePosition { symbol: string; name: string; quantity: number; avgPrice: number }
export interface Balance { cash: number; positions: BalancePosition[] }

export interface Thesis {
  why: string;           // 진입 근거
  target: string;        // 목표 (예: "+6%")
  stop: string;          // 손절 (예: "-3%")
  exitCondition: string; // 청산 조건
}

export interface Position {
  symbol: string;
  name: string;
  quantity: number;
  avgPrice: number;
  thesis?: Thesis;
  openedAt?: string; // ISO
}

export interface OrderRequest {
  side: Side;
  symbol: string;
  name: string;
  quantity: number;
  orderType: OrderType;
  limitPrice?: number;
}

export interface FillResult {
  status: 'FILLED' | 'PENDING' | 'REJECTED';
  reason?: string;
  fillPrice?: number;
  fee?: number;
  tax?: number;
}

export interface OrderResult { orderId: string; status: 'ACCEPTED' | 'REJECTED'; reason?: string }

export interface Decision {
  action: 'BUY' | 'SELL' | 'HOLD';
  symbol?: string;
  quantity?: number;
  orderType?: OrderType;
  limitPrice?: number;
  reasoning: string;
  thesis?: Thesis; // BUY 시 필수 (스키마에서 강제)
}

export interface BrainOutput {
  marketView: string;
  decisions: Decision[];
}

export interface UniverseEntry { symbol: string; name: string }

export interface IndicatorRow {
  symbol: string;
  ma5?: number;
  ma20?: number;
  change5d?: number; // 5거래일 등락률 %
}
```

- [ ] **Step 2: 실패하는 테스트 작성** — `tests/adapter-wrap.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import { wrapAdapter, type BrokerAdapter } from '../src/broker/adapter.js';

const goodQuote = { symbol: '005930', name: '삼성전자', price: 70000, bid: 69900, ask: 70100, changeRate: 1.2, volume: 1000 };

function fake(overrides: Partial<BrokerAdapter> = {}): BrokerAdapter {
  return {
    id: 'fake',
    auth: async () => {},
    getQuotes: async () => [goodQuote],
    getBalance: async () => ({ cash: 1_000_000, positions: [] }),
    isMarketOpen: async () => true,
    ...overrides,
  };
}

describe('wrapAdapter', () => {
  it('정상 응답은 그대로 통과', async () => {
    const a = wrapAdapter(fake());
    expect(await a.getQuotes(['005930'])).toEqual([goodQuote]);
    expect((await a.getBalance()).cash).toBe(1_000_000);
  });

  it('스키마 위반 응답은 AdapterContractError', async () => {
    const a = wrapAdapter(fake({ getQuotes: async () => [{ symbol: '005930', price: 'oops' }] as never }));
    await expect(a.getQuotes(['005930'])).rejects.toThrow(/어댑터 응답이 규격에 맞지 않습니다/);
  });

  it('가격이 NaN/음수면 거부', async () => {
    const a = wrapAdapter(fake({ getQuotes: async () => [{ ...goodQuote, price: -1 }] }));
    await expect(a.getQuotes(['005930'])).rejects.toThrow();
  });

  it('선택 메서드가 없으면 wrapped에도 없음', () => {
    const a = wrapAdapter(fake());
    expect(a.getCandles).toBeUndefined();
  });
});
```

- [ ] **Step 3: 실패 확인**

Run: `npx vitest run tests/adapter-wrap.test.ts`
Expected: FAIL — `wrapAdapter` 미존재

- [ ] **Step 4: src/broker/adapter.ts 구현**

```typescript
import { z } from 'zod';
import type { Balance, Candle, Orderbook, OrderRequest, OrderResult, Quote } from '../core/types.js';

export interface AdapterEnv {
  apiKey: string;
  apiSecret: string;
  accountNo: string;
  baseUrl: string;
}

export interface HttpClient {
  get(path: string, init?: { headers?: Record<string, string> }): Promise<unknown>;
  post(path: string, body: unknown, init?: { headers?: Record<string, string> }): Promise<unknown>;
}

export interface BrokerAdapter {
  readonly id: string;
  auth(): Promise<void>;
  getQuotes(symbols: string[]): Promise<Quote[]>;
  getBalance(): Promise<Balance>;
  isMarketOpen(): Promise<boolean>;
  getCandles?(symbol: string, interval: 'day' | 'minute', count: number): Promise<Candle[]>;
  getOrderbook?(symbol: string): Promise<Orderbook>;
  submitOrder?(order: OrderRequest): Promise<OrderResult>;
  cancelOrder?(orderId: string): Promise<void>;
}

const positiveFinite = z.number().finite().positive();
const nonNegFinite = z.number().finite().nonnegative();

export const QuoteSchema = z.object({
  symbol: z.string().min(1),
  name: z.string(),
  price: positiveFinite,
  bid: positiveFinite,
  ask: positiveFinite,
  changeRate: z.number().finite(),
  volume: nonNegFinite,
});

export const CandleSchema = z.object({
  time: z.string().min(1),
  open: positiveFinite, high: positiveFinite, low: positiveFinite, close: positiveFinite,
  volume: nonNegFinite,
});

export const BalanceSchema = z.object({
  cash: nonNegFinite,
  positions: z.array(z.object({
    symbol: z.string().min(1), name: z.string(),
    quantity: z.number().int().nonnegative(), avgPrice: nonNegFinite,
  })),
});

export const OrderbookSchema = z.object({
  symbol: z.string().min(1),
  bids: z.array(z.object({ price: positiveFinite, quantity: nonNegFinite })),
  asks: z.array(z.object({ price: positiveFinite, quantity: nonNegFinite })),
});

export class AdapterContractError extends Error {
  constructor(method: string, detail: string) {
    super(`어댑터 응답이 규격에 맞지 않습니다 (${method}): ${detail}`);
  }
}

function validate<T>(method: string, schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new AdapterContractError(method, r.error.message);
  return r.data;
}

/** 생성된 어댑터를 런타임 zod 검증으로 감싼다. 규격 위반은 사이클 스킵으로 이어진다. */
export function wrapAdapter(a: BrokerAdapter): BrokerAdapter {
  const wrapped: BrokerAdapter = {
    id: a.id,
    auth: () => a.auth(),
    getQuotes: async (symbols) => validate('getQuotes', z.array(QuoteSchema), await a.getQuotes(symbols)),
    getBalance: async () => validate('getBalance', BalanceSchema, await a.getBalance()),
    isMarketOpen: async () => validate('isMarketOpen', z.boolean(), await a.isMarketOpen()),
  };
  if (a.getCandles) wrapped.getCandles = async (s, i, c) => validate('getCandles', z.array(CandleSchema), await a.getCandles!(s, i, c));
  if (a.getOrderbook) wrapped.getOrderbook = async (s) => validate('getOrderbook', OrderbookSchema, await a.getOrderbook!(s));
  if (a.submitOrder) wrapped.submitOrder = (o) => a.submitOrder!(o);
  if (a.cancelOrder) wrapped.cancelOrder = (id) => a.cancelOrder!(id);
  return wrapped;
}
```

- [ ] **Step 5: 통과 확인 + 커밋**

Run: `npx vitest run tests/adapter-wrap.test.ts` → PASS

```bash
git add -A && git commit -m "feat: 코어 타입 + BrokerAdapter 규격/런타임 검증"
```

---

### Task 3: Config

**Files:**
- Create: `src/core/config.ts`
- Test: `tests/config.test.ts`

- [ ] **Step 1: 테스트 이식 + 신규 필드 테스트 추가**

Run: `cp $OLD/tests/config.test.ts tests/config.test.ts`
이식 후 import를 `../src/core/config.js`로 수정하고, `dataSource` 관련 단언 줄을 모두 삭제한 뒤 아래 테스트를 파일 끝에 추가:

```typescript
it('신규 기본값: cycleMinutes 30, halfSpreadPct, 신규 가드레일', () => {
  const c = loadConfig('/nonexistent/config.json');
  expect(c.cycleMinutes).toBe(30);
  expect(c.halfSpreadPct).toBe(0.0005);
  expect(c.guardrails.maxOrdersPerDay).toBe(10);
  expect(c.guardrails.reentryCooldownMin).toBe(60);
  expect(c.guardrails.maxTotalExposurePct).toBe(80);
  expect(c.brokerId).toBe('');
});
```

- [ ] **Step 2: 실패 확인** — `npx vitest run tests/config.test.ts` → FAIL

- [ ] **Step 3: src/core/config.ts 작성** ($OLD/src/config.ts 기반, 전체 교체본)

```typescript
import { readFileSync, existsSync } from 'node:fs';

export interface GuardrailLimits {
  maxPositionPct: number;       // 종목당 최대 비중 (정수 %)
  maxOrderPct: number;          // 1회 주문 금액 상한 (정수 %)
  maxOrdersPerCycle: number;
  dailyLossLimitPct: number;    // 양수로 표기 (3 = -3% 도달 시)
  maxOrdersPerDay: number;
  reentryCooldownMin: number;   // 매도 후 동일 종목 재매수 금지 시간(분)
  maxTotalExposurePct: number;  // 총 주식 노출 상한 (정수 %)
}

export interface AppConfig {
  mode: 'paper' | 'live';
  brokerId: string;             // adapters/<brokerId>/ — 빈 문자열이면 미설정(온보딩 모드)
  initialCash: number;
  feeRate: number;
  taxRate: number;
  halfSpreadPct: number;        // bid==ask 폴백 시 적용할 half-spread (소수, 0.0005 = 0.05%)
  cycleMinutes: number;
  guardrails: GuardrailLimits;
  claudeCmd: string;
  dbPath: string;
  port: number;
}

const DEFAULTS: AppConfig = {
  mode: 'paper',
  brokerId: '',
  initialCash: 10_000_000,
  feeRate: 0.00015,
  taxRate: 0.0018,
  halfSpreadPct: 0.0005,
  cycleMinutes: 30,
  guardrails: {
    maxPositionPct: 20,
    maxOrderPct: 10,
    maxOrdersPerCycle: 3,
    dailyLossLimitPct: 3,
    maxOrdersPerDay: 10,
    reentryCooldownMin: 60,
    maxTotalExposurePct: 80,
  },
  claudeCmd: 'claude',
  dbPath: 'data/state.db',
  port: 3000,
};

export function loadConfig(path = 'config.json'): AppConfig {
  if (!existsSync(path)) return structuredClone(DEFAULTS);
  let file: Partial<AppConfig>;
  try {
    file = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    throw new Error(`설정 파일이 올바른 JSON이 아닙니다 (${path}): ${(err as Error).message}`);
  }
  return {
    ...structuredClone(DEFAULTS),
    ...file,
    guardrails: { ...DEFAULTS.guardrails, ...(file.guardrails ?? {}) },
  };
}

export function isConfigured(path = 'config.json'): boolean {
  return existsSync(path) && loadConfig(path).brokerId !== '';
}
```

- [ ] **Step 4: 통과 확인 + 커밋** — `npx vitest run tests/config.test.ts` → PASS

```bash
git add -A && git commit -m "feat: config 이식 + 신규 가드레일/스프레드 필드"
```

---

### Task 4: PaperBroker 이식 (+ half-spread, thesis)

**Files:**
- Create: `src/broker/paper.ts`
- Test: `tests/paper-broker.test.ts`

- [ ] **Step 1: 원본 이식**

```bash
cp $OLD/src/broker/paper.ts src/broker/paper.ts
cp $OLD/tests/paper-broker.test.ts tests/paper-broker.test.ts
```
`src/broker/paper.ts`의 import를 `'../core/types.js'`로, 테스트 import를 `'../src/broker/paper.js'`로 수정.

- [ ] **Step 2: 신규 동작 테스트 추가** — `tests/paper-broker.test.ts` 끝에 추가

```typescript
describe('half-spread & thesis', () => {
  const q = (over: Partial<Quote> = {}): Quote =>
    ({ symbol: 'A', name: 'A', price: 100000, bid: 100000, ask: 100000, changeRate: 0, volume: 0, ...over });
  const mkBroker = () => new PaperBroker({ initialCash: 10_000_000, feeRate: 0, taxRate: 0, halfSpreadPct: 0.001 });

  it('bid==ask이면 MARKET 매수는 price*(1+half)로 체결', () => {
    const b = mkBroker();
    const r = b.submit({ side: 'BUY', symbol: 'A', name: 'A', quantity: 1, orderType: 'MARKET' }, new Map([['A', q()]]));
    expect(r.fillPrice).toBe(100100); // 100000 * 1.001
  });

  it('bid!=ask이면 기존처럼 호가로 체결', () => {
    const b = mkBroker();
    const r = b.submit({ side: 'BUY', symbol: 'A', name: 'A', quantity: 1, orderType: 'MARKET' },
      new Map([['A', q({ bid: 99900, ask: 100200 })]]));
    expect(r.fillPrice).toBe(100200);
  });

  it('setThesis로 포지션에 thesis 저장, toJSON/fromJSON 왕복 보존', () => {
    const b = mkBroker();
    b.submit({ side: 'BUY', symbol: 'A', name: 'A', quantity: 1, orderType: 'MARKET' }, new Map([['A', q()]]));
    b.setThesis('A', { why: 'w', target: '+6%', stop: '-3%', exitCondition: 'x' });
    const restored = PaperBroker.fromJSON(b.toJSON(), { feeRate: 0, taxRate: 0, halfSpreadPct: 0.001 });
    expect(restored.positions[0]!.thesis?.target).toBe('+6%');
  });
});
```
파일 상단 import에 `Quote` 타입과 `PaperBroker`가 이미 있는지 확인하고 없으면 추가.

- [ ] **Step 3: 실패 확인** — `npx vitest run tests/paper-broker.test.ts` → 신규 3건 FAIL (기존 이식 테스트는 PASS여야 함. 기존 테스트가 깨지면 import 수정 누락)

- [ ] **Step 4: paper.ts 수정**

(a) `BrokerRates`를 `{ feeRate: number; taxRate: number; halfSpreadPct: number }`로 확장하고 생성자/`fromJSON` 시그니처 반영.

(b) `submit`의 MARKET 분기를 다음으로 교체:

```typescript
    if (order.orderType === 'MARKET') {
      return this.#fill(order, this.#execPrice(order.side, q));
    }
```

(c) 클래스에 메서드 추가:

```typescript
  /** bid==ask(스프레드 정보 없음)이면 현실적 half-spread를 적용한 체결가 산출 */
  #execPrice(side: 'BUY' | 'SELL', q: Quote): number {
    if (q.bid !== q.ask) return side === 'BUY' ? q.ask : q.bid;
    const adj = side === 'BUY' ? 1 + this.#rates.halfSpreadPct : 1 - this.#rates.halfSpreadPct;
    return Math.round(q.price * adj);
  }

  setThesis(symbol: string, thesis: Thesis): void {
    const pos = this.#positions.get(symbol);
    if (pos) this.#positions.set(symbol, { ...pos, thesis, openedAt: pos.openedAt ?? new Date().toISOString() });
  }
```
상단 import에 `Thesis` 추가. 즉시 체결 가능 지정가 분기(`q.ask <= limitPrice` 등)는 그대로 둔다 — 지정가 체결은 지정가 자체가 비용을 내포.

- [ ] **Step 5: 통과 확인 + 커밋** — `npx vitest run tests/paper-broker.test.ts` → 전체 PASS

```bash
git add -A && git commit -m "feat: PaperBroker 이식 + half-spread 모델 + thesis 보존"
```

---

### Task 5: Guardrails 이식 + 3규칙 추가

**Files:**
- Create: `src/guardrails/index.ts`
- Test: `tests/guardrails.test.ts`

- [ ] **Step 1: 이식**

```bash
cp $OLD/src/guardrails.ts src/guardrails/index.ts
cp $OLD/tests/guardrails.test.ts tests/guardrails.test.ts
```
import 수정: `'./config.js'` → `'../core/config.js'`, `'./types.js'` → `'../core/types.js'`; 테스트는 `'../src/guardrails/index.js'`, `'../src/core/config.js'` 등. 기존 테스트의 `GuardrailLimits` 객체 리터럴에 신규 3필드(`maxOrdersPerDay: 10, reentryCooldownMin: 60, maxTotalExposurePct: 80`)를 추가해 컴파일을 맞춘다. 기존 ctx 리터럴에는 `ordersToday: 0, lastSellAt: null, now: new Date(), totalPositionValue: 0`을 추가.

- [ ] **Step 2: 신규 규칙 테스트 추가** — 파일 끝에:

```typescript
describe('신규 가드레일', () => {
  const limits: GuardrailLimits = {
    maxPositionPct: 20, maxOrderPct: 10, maxOrdersPerCycle: 3, dailyLossLimitPct: 3,
    maxOrdersPerDay: 10, reentryCooldownMin: 60, maxTotalExposurePct: 80,
  };
  const quote: Quote = { symbol: 'A', name: 'A', price: 10000, bid: 10000, ask: 10000, changeRate: 0, volume: 0 };
  const baseCtx = (over: Partial<GuardrailContext> = {}): GuardrailContext => ({
    equity: 10_000_000, positions: [], quotes: new Map([['A', quote]]),
    dailyPnlPct: 0, ordersThisCycle: 0, ordersToday: 0, lastSellAt: null,
    now: new Date('2026-06-11T05:00:00Z'), totalPositionValue: 0, ...over,
  });
  const buy = { side: 'BUY' as const, symbol: 'A', name: 'A', quantity: 10, orderType: 'MARKET' as const };

  it('일일 주문 수 초과 시 거부', () => {
    expect(checkOrder(buy, baseCtx({ ordersToday: 10 }), limits).allowed).toBe(false);
  });

  it('재진입 쿨다운 내 매수 거부, 경과 후 허용', () => {
    const sold30minAgo = new Date('2026-06-11T04:30:00Z').toISOString();
    expect(checkOrder(buy, baseCtx({ lastSellAt: sold30minAgo }), limits).allowed).toBe(false);
    const sold2hAgo = new Date('2026-06-11T03:00:00Z').toISOString();
    expect(checkOrder(buy, baseCtx({ lastSellAt: sold2hAgo }), limits).allowed).toBe(true);
  });

  it('총 노출 상한 초과 거부', () => {
    // 보유 평가 790만 + 신규 10만 = 800만 = 80% 경계 초과 케이스
    expect(checkOrder(buy, baseCtx({ totalPositionValue: 7_950_000 }), limits).allowed).toBe(false);
  });

  it('쿨다운/일일상한은 SELL에 적용 안 됨', () => {
    const sell = { ...buy, side: 'SELL' as const };
    expect(checkOrder(sell, baseCtx({ ordersToday: 99, lastSellAt: new Date().toISOString() }), limits).allowed).toBe(true);
  });
});
```

- [ ] **Step 3: 실패 확인** — `npx vitest run tests/guardrails.test.ts` → 신규 FAIL

- [ ] **Step 4: index.ts 수정**

`GuardrailContext`에 필드 추가:

```typescript
export interface GuardrailContext {
  equity: number;
  positions: Position[];
  quotes: Map<string, Quote>;
  dailyPnlPct: number;
  ordersThisCycle: number;
  ordersToday: number;
  lastSellAt: string | null;     // 이 주문 종목의 마지막 매도 시각 (ISO)
  now: Date;
  totalPositionValue: number;    // 전 종목 보유 평가액 합
}
```

`checkOrder`에서 `if (order.side === 'SELL') return { allowed: true };` 바로 **위**(사이클 한도 체크 다음, 시세 체크 다음 위치 유지)에 매수 전용 검사들이 오도록, SELL early-return은 그대로 두고 그 **아래**(일일 손실 체크 위)에 추가:

```typescript
  if (ctx.ordersToday >= limits.maxOrdersPerDay) {
    return { allowed: false, reason: `일일 최대 주문 수(${limits.maxOrdersPerDay}건) 초과` };
  }

  if (ctx.lastSellAt) {
    const elapsedMin = (ctx.now.getTime() - new Date(ctx.lastSellAt).getTime()) / 60_000;
    if (elapsedMin < limits.reentryCooldownMin) {
      return { allowed: false, reason: `재진입 쿨다운 — 매도 후 ${limits.reentryCooldownMin}분 경과 전 (${Math.round(elapsedMin)}분 경과)` };
    }
  }
```

기존 종목 비중 체크 아래(return true 직전)에 추가:

```typescript
  const maxExposure = (ctx.equity * limits.maxTotalExposurePct) / 100;
  if (ctx.totalPositionValue + orderValue > maxExposure) {
    return {
      allowed: false,
      reason: `총 노출 상한(총자산의 ${limits.maxTotalExposurePct}%) 초과 — 현재 ${Math.round(ctx.totalPositionValue).toLocaleString()}원 + 신규 ${Math.round(orderValue).toLocaleString()}원`,
    };
  }
```

- [ ] **Step 5: 통과 확인 + 커밋** — `npx vitest run tests/guardrails.test.ts` → 전체 PASS

```bash
git add -A && git commit -m "feat: 가드레일 이식 + 일일상한/쿨다운/총노출 규칙"
```

---

### Task 6: Store 이식 + 원자 트랜잭션 + 벤치마크 컬럼

**Files:**
- Create: `src/core/store.ts`
- Test: `tests/store.test.ts`

- [ ] **Step 1: 이식**

```bash
cp $OLD/src/store.ts src/core/store.ts
cp $OLD/tests/store.test.ts tests/store.test.ts
```
테스트 import를 `'../src/core/store.js'`로 수정.

- [ ] **Step 2: 신규 테스트 추가** — `tests/store.test.ts` 끝에:

```typescript
describe('atomic & benchmark & thesis', () => {
  it('atomic 내부에서 throw하면 아무것도 기록되지 않는다', () => {
    const s = new Store(':memory:');
    expect(() => s.atomic(() => {
      s.recordTrade({ ts: 't', side: 'BUY', symbol: 'A', name: 'A', quantity: 1, price: 100, fee: 0, tax: 0 });
      throw new Error('boom');
    })).toThrow('boom');
    expect(s.getTrades(10)).toHaveLength(0);
  });

  it('snapshot에 benchmark 저장/조회', () => {
    const s = new Store(':memory:');
    s.recordSnapshot({ ts: 't', equity: 100, cash: 50, dailyPnlPct: 0, benchmark: 99.5 });
    expect(s.getSnapshots(1)[0]!.benchmark).toBe(99.5);
  });

  it('decision에 thesis JSON 저장/조회', () => {
    const s = new Store(':memory:');
    s.recordDecision({
      ts: 't', action: 'BUY', symbol: 'A', name: 'A', quantity: 1, orderType: 'MARKET',
      limitPrice: null, reasoning: 'r', status: 'FILLED', rejectReason: null, marketView: 'm',
      thesis: JSON.stringify({ why: 'w', target: '+6%', stop: '-3%', exitCondition: 'x' }),
    });
    expect(JSON.parse(s.getDecisions(1)[0]!.thesis!).target).toBe('+6%');
  });
});
```

- [ ] **Step 3: 실패 확인** — `npx vitest run tests/store.test.ts` → 신규 FAIL

- [ ] **Step 4: store.ts 수정**

(a) `SnapshotRow`에 `benchmark: number | null;` 추가, `DecisionRow`에 `thesis?: string | null;` 추가.
(b) CREATE TABLE의 snapshots에 `benchmark REAL`, decisions에 `thesis TEXT` 컬럼 추가.
(c) `recordSnapshot`/`getSnapshots`, `recordDecision`/`getDecisions`의 INSERT/SELECT 컬럼 목록에 반영 (`s.benchmark ?? null`, `d.thesis ?? null`).
(d) 클래스에 추가:

```typescript
  /** 콜백 안의 모든 기록을 단일 SQLite 트랜잭션으로 묶는다 (체결-상태 원자성). 콜백은 동기여야 한다. */
  atomic<T>(fn: () => T): T {
    return this.#db.transaction(fn)();
  }
```

- [ ] **Step 5: 통과 확인 + 커밋** — 전체 PASS 후:

```bash
git add -A && git commit -m "feat: Store 이식 + atomic 트랜잭션 + benchmark/thesis 컬럼"
```

---

### Task 7: MockAdapter (BrokerAdapter 구현)

**Files:**
- Create: `src/broker/mock.ts`
- Test: `tests/mock-adapter.test.ts`

- [ ] **Step 1: 테스트 작성** — $OLD의 mock 테스트는 인터페이스가 다르므로 새로 작성:

```typescript
import { describe, it, expect } from 'vitest';
import { MockAdapter } from '../src/broker/mock.js';

describe('MockAdapter', () => {
  const universe = [{ symbol: '005930', name: '삼성전자' }, { symbol: '000660', name: 'SK하이닉스' }];

  it('같은 seed면 같은 가격 시퀀스 (결정론)', async () => {
    const a = new MockAdapter(universe, 42);
    const b = new MockAdapter(universe, 42);
    expect(await a.getQuotes(['005930'])).toEqual(await b.getQuotes(['005930']));
  });

  it('advance()로 가격이 랜덤워크', async () => {
    const a = new MockAdapter(universe, 42);
    const before = (await a.getQuotes(['005930']))[0]!.price;
    a.advance();
    const after = (await a.getQuotes(['005930']))[0]!.price;
    expect(after).not.toBe(before);
    expect(Math.abs(after / before - 1)).toBeLessThan(0.011);
  });

  it('getBalance는 빈 계좌, isMarketOpen은 항상 true, getCandles 20개 반환', async () => {
    const a = new MockAdapter(universe, 1);
    expect((await a.getBalance()).positions).toEqual([]);
    expect(await a.isMarketOpen()).toBe(true);
    expect(await a.getCandles('005930', 'day', 20)).toHaveLength(20);
  });

  it('setPrice로 시나리오 주입', async () => {
    const a = new MockAdapter(universe, 1);
    a.setPrice('005930', 50000);
    expect((await a.getQuotes(['005930']))[0]!.price).toBe(50000);
  });
});
```

- [ ] **Step 2: 실패 확인** — `npx vitest run tests/mock-adapter.test.ts` → FAIL

- [ ] **Step 3: 구현** — `$OLD/src/market/mock.ts`의 mulberry32 PRNG·랜덤워크·setPrice 로직을 가져와 `BrokerAdapter`로 재포장:

```typescript
import type { BrokerAdapter } from './adapter.js';
import type { Balance, Candle, Quote, UniverseEntry } from '../core/types.js';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class MockAdapter implements BrokerAdapter {
  readonly id = 'mock';
  #prices = new Map<string, number>();
  #names = new Map<string, string>();
  #rand: () => number;

  constructor(universe: UniverseEntry[], seed = 42) {
    this.#rand = mulberry32(seed);
    for (const u of universe) {
      this.#names.set(u.symbol, u.name);
      this.#prices.set(u.symbol, Math.round((10_000 + this.#rand() * 190_000) / 100) * 100);
    }
  }

  async auth(): Promise<void> {}

  async getQuotes(symbols: string[]): Promise<Quote[]> {
    return symbols.filter(s => this.#prices.has(s)).map(s => {
      const price = this.#prices.get(s)!;
      return { symbol: s, name: this.#names.get(s) ?? s, price, bid: price, ask: price, changeRate: 0, volume: Math.round(this.#rand() * 1_000_000) };
    });
  }

  async getBalance(): Promise<Balance> { return { cash: 0, positions: [] }; }
  async isMarketOpen(): Promise<boolean> { return true; }

  async getCandles(symbol: string, _interval: 'day' | 'minute', count: number): Promise<Candle[]> {
    const base = this.#prices.get(symbol) ?? 50_000;
    const out: Candle[] = [];
    let px = base;
    for (let i = count - 1; i >= 0; i--) {
      px = Math.max(100, Math.round(px * (1 + (this.#rand() - 0.5) * 0.02)));
      const d = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
      out.push({ time: d, open: px, high: Math.round(px * 1.01), low: Math.round(px * 0.99), close: px, volume: 100_000 });
    }
    return out;
  }

  /** 페이퍼 사이클마다 ±0.5% 랜덤워크 */
  advance(): void {
    for (const [s, p] of this.#prices) {
      this.#prices.set(s, Math.max(100, Math.round(p * (1 + (this.#rand() - 0.5) * 0.01))));
    }
  }

  /** 테스트 시나리오 주입 */
  setPrice(symbol: string, price: number): void { this.#prices.set(symbol, price); }
}
```

- [ ] **Step 4: 통과 확인 + 커밋** — PASS 후:

```bash
git add -A && git commit -m "feat: MockAdapter (BrokerAdapter 규격 구현)"
```

---

### Task 8: Brain 프롬프트 (전략 문서·thesis·지표 주입)

**Files:**
- Create: `src/brain/prompt.ts`
- Test: `tests/brain-prompt.test.ts`

- [ ] **Step 1: 테스트 작성**

```typescript
import { describe, it, expect } from 'vitest';
import { buildPrompt } from '../src/brain/prompt.js';

const base = {
  strategyDocs: '# 내 전략\n저평가 우량주 분할매수',
  cash: 5_000_000, equity: 10_000_000, dailyPnlPct: -1.2,
  positions: [{ symbol: '005930', name: '삼성전자', quantity: 10, avgPrice: 70000,
    thesis: { why: '반도체 회복', target: '+6%', stop: '-3%', exitCondition: '20일선 이탈' } }],
  quotes: [{ symbol: '005930', name: '삼성전자', price: 71000, bid: 70900, ask: 71100, changeRate: 1.4, volume: 1000 }],
  indicators: [{ symbol: '005930', ma5: 70500, ma20: 69800, change5d: 2.1 }],
  recentDecisions: ['2026-06-11 BUY 삼성전자 10 [FILLED] — 반등 기대'],
  limits: { maxPositionPct: 20, maxOrderPct: 10, maxOrdersPerCycle: 3, dailyLossLimitPct: 3,
    maxOrdersPerDay: 10, reentryCooldownMin: 60, maxTotalExposurePct: 80 },
  ordersToday: 2,
};

describe('buildPrompt', () => {
  it('전략 문서·thesis·지표·잔여 한도가 모두 포함된다', () => {
    const p = buildPrompt(base);
    expect(p).toContain('저평가 우량주 분할매수');
    expect(p).toContain('반도체 회복');       // thesis.why
    expect(p).toContain('20일선 이탈');        // exitCondition
    expect(p).toContain('70,500');             // ma5
    expect(p).toContain('2/10');               // ordersToday/maxOrdersPerDay
    expect(p).toContain('"thesis"');           // 출력 스키마 안내
  });

  it('지표 없으면 "지표 데이터 없음" 명시 (환각 억제)', () => {
    const p = buildPrompt({ ...base, indicators: [] });
    expect(p).toContain('지표 데이터 없음');
  });
});
```

- [ ] **Step 2: 실패 확인** — `npx vitest run tests/brain-prompt.test.ts` → FAIL

- [ ] **Step 3: 구현** — `src/brain/prompt.ts` (신규 작성, $OLD 버전 대체):

```typescript
import type { GuardrailLimits } from '../core/config.js';
import type { IndicatorRow, Position, Quote } from '../core/types.js';

export interface PromptInput {
  strategyDocs: string;          // strategy/*.md 전체를 이어붙인 텍스트
  cash: number;
  equity: number;
  dailyPnlPct: number;
  positions: Position[];
  quotes: Quote[];
  indicators: IndicatorRow[];
  recentDecisions: string[];     // 최근 20개 요약 (최신순)
  limits: GuardrailLimits;
  ordersToday: number;
}

const won = (n: number) => Math.round(n).toLocaleString('ko-KR');

export function buildPrompt(i: PromptInput): string {
  const ind = new Map(i.indicators.map(r => [r.symbol, r]));
  const quoteRows = i.quotes.map(q => {
    const r = ind.get(q.symbol);
    const extra = r
      ? `${r.ma5 ? won(r.ma5) : '-'} | ${r.ma20 ? won(r.ma20) : '-'} | ${r.change5d != null ? r.change5d.toFixed(1) + '%' : '-'}`
      : '- | - | -';
    return `| ${q.name} | ${q.symbol} | ${won(q.price)} | ${q.changeRate}% | ${extra} |`;
  }).join('\n');

  const posRows = i.positions.length === 0 ? '(없음)' : i.positions.map(p => {
    const cur = i.quotes.find(q => q.symbol === p.symbol)?.price ?? p.avgPrice;
    const pnl = ((cur / p.avgPrice - 1) * 100).toFixed(2);
    const t = p.thesis
      ? `thesis: ${p.thesis.why} / 목표 ${p.thesis.target} / 손절 ${p.thesis.stop} / 청산조건 ${p.thesis.exitCondition}`
      : 'thesis 없음';
    return `- ${p.name}(${p.symbol}) ${p.quantity}주 @ ${won(p.avgPrice)} (평가 ${pnl}%) — ${t}`;
  }).join('\n');

  const recent = i.recentDecisions.length === 0 ? '(없음)' : i.recentDecisions.map(d => `- ${d}`).join('\n');
  const noIndicators = i.indicators.length === 0;

  return `당신은 자동매매 시스템의 의사결정 엔진입니다. 아래 전략 문서를 따르되, 확신이 없으면 HOLD 하십시오.
거래에는 비용(수수료+세금+스프레드, 왕복 약 0.3%)이 들므로 잦은 회전매매는 그 자체로 손실입니다.

## 전략 문서
${i.strategyDocs}

## 계좌 상태
- 현금: ${won(i.cash)}원 / 총자산: ${won(i.equity)}원 / 당일 손익: ${i.dailyPnlPct.toFixed(2)}%
- 오늘 주문: ${i.ordersToday}/${i.limits.maxOrdersPerDay}건

## 보유 포지션 (각 포지션의 thesis는 당신이 진입 시 세운 논지입니다. 청산 판단은 thesis 기준으로.)
${posRows}

## 시세 (현재가 | 등락률 | 5일선 | 20일선 | 5일등락)
${noIndicators ? '※ 지표 데이터 없음 — 현재가 외 정보는 추정하지 말 것.' : ''}
| 종목명 | 코드 | 현재가 | 등락률 | 5일선 | 20일선 | 5일등락 |
|--------|------|--------|--------|-------|--------|---------|
${quoteRows}

## 최근 판단 (최신순 20개)
\`\`\`
${recent}
\`\`\`

## 제약 (코드로 강제됨 — 위반 주문은 거부됩니다)
- 종목당 비중 ≤ ${i.limits.maxPositionPct}%, 1회 주문 ≤ 총자산의 ${i.limits.maxOrderPct}%
- 사이클당 ≤ ${i.limits.maxOrdersPerCycle}건, 일일 ≤ ${i.limits.maxOrdersPerDay}건, 총 노출 ≤ ${i.limits.maxTotalExposurePct}%
- 매도 후 같은 종목 재매수는 ${i.limits.reentryCooldownMin}분 쿨다운

## 출력 형식 (JSON만, 다른 텍스트 금지)
{
  "marketView": "시장 상황 한 줄",
  "decisions": [
    { "action": "BUY", "symbol": "코드", "quantity": 정수, "orderType": "LIMIT"|"MARKET", "limitPrice": 숫자(LIMIT시),
      "reasoning": "근거", "thesis": { "why": "진입 근거", "target": "+N%", "stop": "-N%", "exitCondition": "청산 조건" } },
    { "action": "SELL", "symbol": "코드", "quantity": 정수, "orderType": "MARKET", "reasoning": "thesis 대비 어떤 조건 충족/위반인지" },
    { "action": "HOLD", "reasoning": "관망 이유" }
  ]
}
BUY에는 thesis가 반드시 필요합니다. 관망이면 decisions에 HOLD 하나만 넣으십시오.`;
}
```

- [ ] **Step 4: 통과 확인 + 커밋**

```bash
git add -A && git commit -m "feat: 두뇌 프롬프트 — 전략 문서/thesis/지표 주입"
```

---

### Task 9: Brain 러너 + 스키마 (thesis 강제, 세션 만료 감지)

**Files:**
- Create: `src/brain/runner.ts`, `src/brain/schema.ts`
- Test: `tests/brain.test.ts` (+ fixtures)

- [ ] **Step 1: 이식**

```bash
cp $OLD/src/brain/runner.ts src/brain/runner.ts
cp $OLD/tests/brain.test.ts tests/brain.test.ts
cp $OLD/tests/fixtures/claude-stub.sh $OLD/tests/fixtures/claude-stub-invalid.sh $OLD/tests/fixtures/claude-stub-trailing.sh tests/fixtures/
```
import 경로 수정 (`'../core/types.js'` 등). 기존 runner.ts 안의 zod 스키마 정의 부분을 `src/brain/schema.ts`로 분리한다 (아래 Step 4).

- [ ] **Step 2: 신규 테스트 추가** — `tests/brain.test.ts` 끝에:

```typescript
describe('thesis 스키마 & 세션 만료', () => {
  it('BUY인데 thesis 없으면 스키마 거부', () => {
    const r = BrainOutputSchema.safeParse({
      marketView: 'm',
      decisions: [{ action: 'BUY', symbol: 'A', quantity: 1, orderType: 'MARKET', reasoning: 'r' }],
    });
    expect(r.success).toBe(false);
  });

  it('SELL/HOLD는 thesis 불필요', () => {
    const r = BrainOutputSchema.safeParse({
      marketView: 'm',
      decisions: [
        { action: 'SELL', symbol: 'A', quantity: 1, orderType: 'MARKET', reasoning: 'r' },
        { action: 'HOLD', reasoning: 'r' },
      ],
    });
    expect(r.success).toBe(true);
  });

  it('세션 만료 stderr 패턴이면 BrainAuthError', async () => {
    // fixtures/claude-stub-auth-error.sh: stderr로 로그인 요구 메시지 출력 후 exit 1
    await expect(runBrain('p', { claudeCmd: 'tests/fixtures/claude-stub-auth-error.sh', timeoutMs: 5000 }))
      .rejects.toThrow(BrainAuthError);
  });
});
```

새 fixture `tests/fixtures/claude-stub-auth-error.sh` 작성 후 `chmod +x`:

```bash
#!/bin/bash
echo "Invalid API key. Please run /login or claude login to authenticate." >&2
exit 1
```

- [ ] **Step 3: 실패 확인** — `npx vitest run tests/brain.test.ts` → 신규 FAIL

- [ ] **Step 4: schema.ts 분리 + thesis 강제**

`src/brain/schema.ts`:

```typescript
import { z } from 'zod';

const ThesisSchema = z.object({
  why: z.string().min(1), target: z.string().min(1),
  stop: z.string().min(1), exitCondition: z.string().min(1),
});

const HoldSchema = z.object({ action: z.literal('HOLD'), reasoning: z.string().min(1) });

const TradeBase = {
  symbol: z.string().min(1),
  quantity: z.number().int().positive(),
  orderType: z.enum(['LIMIT', 'MARKET']),
  limitPrice: z.number().positive().optional(),
  reasoning: z.string().min(1),
};

const BuySchema = z.object({ action: z.literal('BUY'), ...TradeBase, thesis: ThesisSchema });
const SellSchema = z.object({ action: z.literal('SELL'), ...TradeBase, thesis: ThesisSchema.optional() });

export const BrainOutputSchema = z.object({
  marketView: z.string(),
  decisions: z.array(z.discriminatedUnion('action', [BuySchema, SellSchema, HoldSchema])),
});
```

`runner.ts`: 기존 스키마 정의를 삭제하고 `import { BrainOutputSchema } from './schema.js';`로 교체. 그리고 파일에 추가:

```typescript
export class BrainAuthError extends Error {}

const AUTH_PATTERNS = /please run.*login|claude login|invalid api key|not authenticated|usage limit|rate.?limit/i;

function classifyError(err: unknown): Error {
  const msg = String((err as { stderr?: string; message?: string })?.stderr ?? '') + String((err as Error)?.message ?? '');
  if (AUTH_PATTERNS.test(msg)) return new BrainAuthError(`claude CLI 인증/한도 문제: ${msg.slice(0, 200)}`);
  return err as Error;
}
```

`runBrain`의 각 시도 catch에서 `lastErr = classifyError(err);`로 감싸고, `BrainAuthError`면 재시도 없이 즉시 throw 한다. 테스트가 import할 수 있도록 `runner.ts`에서 `BrainOutputSchema`를 re-export: `export { BrainOutputSchema } from './schema.js';`

또한 `runClaudeText(prompt, opts): Promise<string>`를 export 한다 — 기존 runBrain 내부의 [execFile 호출 → envelope 파싱 → result 텍스트 반환] 부분을 이 함수로 추출하고 runBrain이 이를 사용하게 리팩토링 (Task 13의 생성기가 재사용).

- [ ] **Step 5: 통과 확인 + 커밋** — `npx vitest run tests/brain.test.ts` → 전체 PASS

```bash
git add -A && git commit -m "feat: 두뇌 러너 이식 + thesis 스키마 강제 + 세션만료 감지"
```

---

### Task 10: 사이클 오케스트레이터 (원자 저장·벤치마크·thesis·신규 가드레일 연동)

**Files:**
- Create: `src/core/cycle.ts`
- Test: `tests/cycle.test.ts`

- [ ] **Step 1: 테스트 이식 후 구조 맞춤**

```bash
cp $OLD/tests/cycle.test.ts tests/cycle.test.ts
```
import 경로를 새 구조(`'../src/core/cycle.js'`, `'../src/broker/mock.js'` 등)로 수정. `CycleDeps`에서 `adapter`는 이제 `MockAdapter`(BrokerAdapter), `universe`는 동일. deps 리터럴에 `strategyDocs: '테스트 전략'`을 추가.

- [ ] **Step 2: 신규 테스트 추가** — 파일 끝에:

```typescript
describe('신규 사이클 동작', () => {
  it('BUY 체결 시 thesis가 포지션에 저장된다', async () => {
    const { deps, broker } = makeDeps({   // 기존 테스트의 헬퍼 재사용 (없으면 동일 패턴으로 구성)
      brain: async () => ({
        marketView: 'm',
        decisions: [{ action: 'BUY', symbol: SYM, quantity: 1, orderType: 'MARKET', reasoning: 'r',
          thesis: { why: 'w', target: '+5%', stop: '-2%', exitCondition: 'x' } }],
      }),
    });
    await runCycle(deps);
    expect(broker.positions[0]!.thesis?.why).toBe('w');
  });

  it('스냅샷에 benchmark가 기록되고 첫 사이클에 baseline KV가 생긴다', async () => {
    const { deps, store } = makeDeps({ brain: async () => ({ marketView: 'm', decisions: [{ action: 'HOLD', reasoning: 'r' }] }) });
    await runCycle(deps);
    expect(store.getKV('benchmarkBaseline')).not.toBeNull();
    expect(store.getSnapshots(1)[0]!.benchmark).not.toBeNull();
  });

  it('SELL 체결 시 lastSell KV가 갱신된다', async () => {
    const { deps, broker, store } = makeDeps({
      brain: async () => ({ marketView: 'm', decisions: [{ action: 'SELL', symbol: SYM, quantity: 1, orderType: 'MARKET', reasoning: 'r' }] }),
      presetPosition: { symbol: SYM, quantity: 2, avgPrice: 1000 },
    });
    await runCycle(deps);
    expect(store.getKV(`lastSell:${SYM}`)).not.toBeNull();
  });

  it('ordersToday KV가 체결마다 증가한다', async () => {
    const { deps, store } = makeDeps({
      brain: async () => ({ marketView: 'm', decisions: [{ action: 'BUY', symbol: SYM, quantity: 1, orderType: 'MARKET', reasoning: 'r',
        thesis: { why: 'w', target: '+5%', stop: '-2%', exitCondition: 'x' } }] }),
    });
    await runCycle(deps);
    const key = [...Array(1)].map(() => `ordersToday:${new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' })}`)[0]!;
    expect(Number(store.getKV(key))).toBe(1);
  });
});
```
(기존 이식 테스트에 `makeDeps` 헬퍼가 없다면, 기존 테스트의 deps 구성 코드를 `makeDeps({brain, presetPosition?})` 함수로 추출해 공용화한다.)

- [ ] **Step 3: 실패 확인** — `npx vitest run tests/cycle.test.ts` → FAIL

- [ ] **Step 4: src/core/cycle.ts 작성** ($OLD/src/cycle.ts 기반 전면 재작성):

```typescript
import type { EventEmitter } from 'node:events';
import type { AppConfig } from './config.js';
import type { PaperBroker } from '../broker/paper.js';
import type { BrokerAdapter } from '../broker/adapter.js';
import type { Store, TradeRow, DecisionRow } from './store.js';
import type { BrainOutput, Decision, IndicatorRow, OrderRequest, Quote, UniverseEntry } from './types.js';
import { checkOrder } from '../guardrails/index.js';
import { buildPrompt } from '../brain/prompt.js';

export interface CycleDeps {
  config: AppConfig;
  universe: UniverseEntry[];
  adapter: BrokerAdapter & { advance?: () => void };
  broker: PaperBroker;
  store: Store;
  strategyDocs: string;
  brain: (prompt: string) => Promise<BrainOutput>;
  events?: EventEmitter;
}

export interface CycleResult { skipped: boolean; reason?: string }

const kstDate = (d: Date) => d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
const nowISO = () => new Date().toISOString();

// KST 09:00~09:30 — dayOpenEquity 초기화 허용 시간창 (슬립 복귀 오염 방지)
function inDayOpenWindow(d: Date): boolean {
  const hm = d.toLocaleTimeString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 5);
  return hm >= '09:00' && hm <= '09:30';
}

export async function runCycle(deps: CycleDeps): Promise<CycleResult> {
  const { adapter, broker, store, config, universe } = deps;
  adapter.advance?.();

  // 1) 시세
  const symbols = [...new Set([...universe.map(u => u.symbol), ...broker.positions.map(p => p.symbol)])];
  let quoteList: Quote[];
  try {
    quoteList = await adapter.getQuotes(symbols);
  } catch (err) {
    recordError(store, `시세 조회 실패: ${String(err)}`);
    deps.events?.emit('update');
    return { skipped: true, reason: String(err) };
  }
  const quotes = new Map<string, Quote>(quoteList.map(q => [q.symbol, q]));

  // 2) 지표 (어댑터가 캔들 지원 시)
  const indicators = await collectIndicators(adapter, universe);

  // 3) dayOpenEquity — 시간창 안에서만 초기화. 창 밖 첫 실행이면 전일 마지막 스냅샷 폴백
  const today = kstDate(new Date());
  const dayKey = `dayOpenEquity:${today}`;
  if (store.getKV(dayKey) === null) {
    const fallback = store.getSnapshots(1)[0]?.equity ?? broker.equity(quotes);
    const v = inDayOpenWindow(new Date()) ? broker.equity(quotes) : fallback;
    store.setKV(dayKey, String(v));
  }
  const dayOpenEquity = Number(store.getKV(dayKey));

  // 4) 대기 지정가 체결 — 기록은 사이클 끝에 원자 저장
  const tickTrades: TradeRow[] = broker.onTick(quotes).map(({ order, result }) => ({
    ts: nowISO(), side: order.side, symbol: order.symbol, name: order.name,
    quantity: order.quantity, price: result.fillPrice!, fee: result.fee!, tax: result.tax!,
  }));

  const equity = broker.equity(quotes);
  const dailyPnlPct = dayOpenEquity > 0 ? ((equity - dayOpenEquity) / dayOpenEquity) * 100 : 0;
  const ordersTodayKey = `ordersToday:${today}`;
  let ordersToday = Number(store.getKV(ordersTodayKey) ?? '0');

  // 5) 두뇌
  let output: BrainOutput;
  try {
    output = await deps.brain(buildPrompt({
      strategyDocs: deps.strategyDocs,
      cash: broker.cash, equity, dailyPnlPct,
      positions: broker.positions, quotes: quoteList, indicators,
      recentDecisions: store.getDecisions(20).map(d =>
        `${d.ts} ${d.action} ${d.name ?? ''} ${d.quantity ?? ''} [${d.status}] — ${d.reasoning}`.trim()),
      limits: config.guardrails, ordersToday,
    }));
  } catch (err) {
    finishCycle(deps, quotes, dailyPnlPct, tickTrades, [errorRow(`브레인 호출 실패: ${String(err)}`)], ordersToday, ordersTodayKey);
    return { skipped: true, reason: String(err) };
  }

  // 6) 판단 실행 — 기록 행은 모아서 원자 저장
  const trades: TradeRow[] = [...tickTrades];
  const decisionRows: DecisionRow[] = [];
  const sellTimes: Array<[string, string]> = [];
  let ordersThisCycle = 0;

  for (const decision of output.decisions) {
    if (decision.action === 'HOLD') { decisionRows.push(toRow(decision, output.marketView, 'HOLD', null)); continue; }
    const order = toOrder(decision, quotes);
    if (!order) { decisionRows.push(toRow(decision, output.marketView, 'REJECTED', '주문 필드 불완전')); continue; }

    const verdict = checkOrder(order, {
      equity, positions: broker.positions, quotes, dailyPnlPct, ordersThisCycle,
      ordersToday, lastSellAt: store.getKV(`lastSell:${order.symbol}`), now: new Date(),
      totalPositionValue: broker.positions.reduce((s, p) => s + (quotes.get(p.symbol)?.price ?? p.avgPrice) * p.quantity, 0),
    }, config.guardrails);
    if (!verdict.allowed) { decisionRows.push(toRow(decision, output.marketView, 'REJECTED', verdict.reason!, order.name)); continue; }

    const result = broker.submit(order, quotes);
    if (result.status === 'FILLED') {
      ordersThisCycle++; ordersToday++;
      trades.push({ ts: nowISO(), side: order.side, symbol: order.symbol, name: order.name,
        quantity: order.quantity, price: result.fillPrice!, fee: result.fee!, tax: result.tax! });
      if (decision.action === 'BUY' && decision.thesis) broker.setThesis(order.symbol, decision.thesis);
      if (decision.action === 'SELL') sellTimes.push([order.symbol, nowISO()]);
      decisionRows.push(toRow(decision, output.marketView, 'FILLED', null, order.name));
    } else if (result.status === 'PENDING') {
      ordersThisCycle++; ordersToday++;
      if (decision.action === 'BUY' && decision.thesis) {
        // PENDING 매수의 thesis는 체결 시점에 알 수 없으므로 KV에 보관했다가 onTick 체결 후 적용
        store.setKV(`pendingThesis:${order.symbol}`, JSON.stringify(decision.thesis));
      }
      decisionRows.push(toRow(decision, output.marketView, 'PENDING', null, order.name));
    } else {
      decisionRows.push(toRow(decision, output.marketView, 'REJECTED', result.reason!, order.name));
    }
  }

  // tick 체결된 매수에 보관된 thesis 적용
  for (const t of tickTrades) {
    if (t.side === 'BUY') {
      const pt = store.getKV(`pendingThesis:${t.symbol}`);
      if (pt) { broker.setThesis(t.symbol, JSON.parse(pt)); store.setKV(`pendingThesis:${t.symbol}`, ''); }
    }
    if (t.side === 'SELL') sellTimes.push([t.symbol, t.ts]);
  }

  finishCycle(deps, quotes, dailyPnlPct, trades, decisionRows, ordersToday, ordersTodayKey, sellTimes);
  return { skipped: false };
}

async function collectIndicators(adapter: BrokerAdapter, universe: UniverseEntry[]): Promise<IndicatorRow[]> {
  if (!adapter.getCandles) return [];
  const out: IndicatorRow[] = [];
  for (const u of universe) {
    try {
      const c = await adapter.getCandles(u.symbol, 'day', 20);
      if (c.length < 6) continue;
      const closes = c.map(x => x.close);
      const ma = (n: number) => Math.round(closes.slice(-n).reduce((a, b) => a + b, 0) / n);
      out.push({
        symbol: u.symbol, ma5: ma(5), ma20: closes.length >= 20 ? ma(20) : undefined,
        change5d: Number(((closes.at(-1)! / closes.at(-6)! - 1) * 100).toFixed(2)),
      });
    } catch { /* 지표는 best-effort — 실패 시 해당 종목만 생략 */ }
  }
  return out;
}

function toOrder(d: Decision, quotes: Map<string, Quote>): OrderRequest | null {
  if (!d.symbol || !d.quantity || !d.orderType) return null;
  if (d.orderType === 'LIMIT' && !d.limitPrice) return null;
  const name = quotes.get(d.symbol)?.name ?? d.symbol;
  return { side: d.action as 'BUY' | 'SELL', symbol: d.symbol, name, quantity: d.quantity, orderType: d.orderType, limitPrice: d.limitPrice };
}

function toRow(d: Decision, marketView: string, status: string, rejectReason: string | null, name?: string): DecisionRow {
  return {
    ts: nowISO(), action: d.action, symbol: d.symbol ?? null, name: name ?? d.symbol ?? null,
    quantity: d.quantity ?? null, orderType: d.orderType ?? null, limitPrice: d.limitPrice ?? null,
    reasoning: d.reasoning, status, rejectReason, marketView,
    thesis: d.thesis ? JSON.stringify(d.thesis) : null,
  };
}

function errorRow(msg: string): DecisionRow {
  return { ts: nowISO(), action: 'HOLD', symbol: null, name: null, quantity: null, orderType: null,
    limitPrice: null, reasoning: msg, status: 'ERROR', rejectReason: null, marketView: '', thesis: null };
}

function recordError(store: Store, msg: string): void {
  store.recordDecision(errorRow(msg));
}

function computeBenchmark(store: Store, quotes: Map<string, Quote>, universe: UniverseEntry[], initialCash: number): number | null {
  const baselineRaw = store.getKV('benchmarkBaseline');
  if (!baselineRaw) {
    const baseline: Record<string, number> = {};
    for (const u of universe) { const q = quotes.get(u.symbol); if (q) baseline[u.symbol] = q.price; }
    if (Object.keys(baseline).length === 0) return null;
    store.setKV('benchmarkBaseline', JSON.stringify(baseline));
    return initialCash;
  }
  const baseline = JSON.parse(baselineRaw) as Record<string, number>;
  const ratios = Object.entries(baseline)
    .map(([s, p0]) => { const q = quotes.get(s); return q ? q.price / p0 : null; })
    .filter((x): x is number => x !== null);
  if (ratios.length === 0) return null;
  return Math.round(initialCash * (ratios.reduce((a, b) => a + b, 0) / ratios.length));
}

function finishCycle(
  deps: CycleDeps, quotes: Map<string, Quote>, dailyPnlPct: number,
  trades: TradeRow[], decisionRows: DecisionRow[],
  ordersToday: number, ordersTodayKey: string, sellTimes: Array<[string, string]> = [],
): void {
  const { broker, store, universe, config } = deps;
  const equity = broker.equity(quotes);
  const benchmark = computeBenchmark(store, quotes, universe, config.initialCash);
  // 체결·판단·상태를 단일 트랜잭션으로 — 크래시 시 불일치 방지
  store.atomic(() => {
    for (const t of trades) store.recordTrade(t);
    for (const d of decisionRows) store.recordDecision(d);
    store.recordSnapshot({ ts: nowISO(), equity, cash: broker.cash, dailyPnlPct, benchmark });
    store.setKV('broker', JSON.stringify(broker.toJSON()));
    store.setKV('lastQuotes', JSON.stringify([...quotes.values()]));
    store.setKV(ordersTodayKey, String(ordersToday));
    for (const [sym, ts] of sellTimes) store.setKV(`lastSell:${sym}`, ts);
  });
  deps.events?.emit('update');
}
```

- [ ] **Step 5: 통과 확인 + 전체 회귀** — `npx vitest run` → 전체 PASS

```bash
git add -A && git commit -m "feat: 사이클 — 원자 저장/벤치마크/thesis/신규 가드레일 연동"
```

---

### Task 11: 스케줄러 이식

**Files:**
- Create: `src/core/scheduler.ts`
- Test: `tests/scheduler.test.ts`

- [ ] **Step 1: 그대로 이식 (로직 변경 없음)**

```bash
cp $OLD/src/scheduler.ts src/core/scheduler.ts
cp $OLD/tests/scheduler.test.ts tests/scheduler.test.ts
```
import 경로만 새 구조에 맞게 수정 (scheduler가 참조하는 타입이 있으면 `'./config.js'` → 상대 경로 확인). `isMarketOpen` 시그니처는 동일(Promise<boolean>)이므로 어댑터 교체 영향 없음.

- [ ] **Step 2: 검증 + 커밋** — `npx vitest run tests/scheduler.test.ts` → PASS

```bash
git add -A && git commit -m "feat: 스케줄러 이식"
```

---

### Task 12: HttpClient + 정적 검사기 (Validation Gate 1/2)

**Files:**
- Create: `src/setup/http-client.ts`, `src/setup/static-check.ts`
- Test: `tests/static-check.test.ts`, `tests/http-client.test.ts`

- [ ] **Step 1: 테스트 작성** — `tests/static-check.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { checkAdapterSource } from '../src/setup/static-check.js';

const SECRETS = ['sk-real-key-123', 'secret-xyz'];
const ok = `
import type { BrokerAdapter, AdapterEnv, HttpClient } from '../../src/broker/adapter.js';
export function createAdapter(env: AdapterEnv, http: HttpClient): BrokerAdapter {
  let token = '';
  return {
    id: 'demo',
    async auth() { const r = await http.post('/oauth2/token', { key: env.apiKey }) as { access_token: string }; token = r.access_token; },
    async getQuotes(symbols) { return await http.get('/quotes?s=' + symbols.join(','), { headers: { Authorization: token } }) as never; },
    async getBalance() { return await http.get('/balance') as never; },
    async isMarketOpen() { return true; },
  };
}`;

describe('checkAdapterSource', () => {
  it('규격 준수 코드는 위반 없음', () => {
    expect(checkAdapterSource(ok, SECRETS)).toEqual([]);
  });
  it.each([
    ['fs 접근', `import fs from 'node:fs';`],
    ['child_process', `import { exec } from 'child_process';`],
    ['값 import', `import { z } from 'zod';`],
    ['동적 import', `const m = await import('node:fs');`],
    ['eval', `eval('1+1');`],
    ['직접 fetch', `await fetch('https://evil.com');`],
    ['process 접근', `const k = process.env.SECRET;`],
    ['require', `const fs = require('fs');`],
  ])('%s 차단', (_label, snippet) => {
    expect(checkAdapterSource(ok + '\n' + snippet, SECRETS).length).toBeGreaterThan(0);
  });
  it('시크릿 하드코딩 차단', () => {
    expect(checkAdapterSource(ok + `\nconst k = 'sk-real-key-123';`, SECRETS).length).toBeGreaterThan(0);
  });
  it('createAdapter export 없으면 위반', () => {
    expect(checkAdapterSource(`export const x = 1;`, SECRETS).length).toBeGreaterThan(0);
  });
});
```

`tests/http-client.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { createHttpClient } from '../src/setup/http-client.js';

describe('createHttpClient', () => {
  it('path는 baseUrl 기준으로만 요청, 절대 URL은 거부', async () => {
    const calls: string[] = [];
    const fetcher = vi.fn(async (url: string) => { calls.push(url); return new Response('{"ok":true}', { status: 200 }); });
    const http = createHttpClient('https://api.broker.com', fetcher as never);
    await http.get('/v1/quotes');
    expect(calls[0]).toBe('https://api.broker.com/v1/quotes');
    await expect(http.get('https://evil.com/x')).rejects.toThrow(/상대 경로만/);
  });

  it('429 + Retry-After 시 1회 재시도', async () => {
    let n = 0;
    const fetcher = vi.fn(async () => {
      n++;
      return n === 1
        ? new Response('', { status: 429, headers: { 'Retry-After': '0' } })
        : new Response('{"ok":true}', { status: 200 });
    });
    const http = createHttpClient('https://api.broker.com', fetcher as never);
    expect(await http.get('/x')).toEqual({ ok: true });
    expect(n).toBe(2);
  });

  it('5xx는 에러', async () => {
    const fetcher = vi.fn(async () => new Response('oops', { status: 500 }));
    const http = createHttpClient('https://api.broker.com', fetcher as never);
    await expect(http.get('/x')).rejects.toThrow(/HTTP 500/);
  });
});
```

- [ ] **Step 2: 실패 확인** — 두 테스트 모두 FAIL

- [ ] **Step 3: 구현** — `src/setup/http-client.ts`:

```typescript
import type { HttpClient } from '../broker/adapter.js';

type Fetcher = typeof globalThis.fetch;

/** 생성 어댑터에 주입되는 유일한 네트워크 통로. base URL 밖으로 못 나간다. */
export function createHttpClient(baseUrl: string, fetcher: Fetcher = globalThis.fetch): HttpClient {
  const base = baseUrl.replace(/\/$/, '');

  async function request(method: 'GET' | 'POST', path: string, body?: unknown, init?: { headers?: Record<string, string> }): Promise<unknown> {
    if (/^[a-z]+:\/\//i.test(path)) throw new Error(`상대 경로만 허용됩니다: ${path}`);
    const url = base + (path.startsWith('/') ? path : '/' + path);
    const doFetch = () => fetcher(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    let res = await doFetch();
    if (res.status === 429) {
      const wait = Math.min(Number(res.headers.get('Retry-After') ?? '1'), 30);
      await new Promise(r => setTimeout(r, wait * 1000));
      res = await doFetch();
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} ${method} ${path}: ${(await res.text()).slice(0, 300)}`);
    const text = await res.text();
    try { return JSON.parse(text); } catch { return text; }
  }

  return {
    get: (path, init) => request('GET', path, undefined, init),
    post: (path, body, init) => request('POST', path, body, init),
  };
}
```

`src/setup/static-check.ts`:

```typescript
/** 생성된 어댑터 소스의 금지 패턴 검사. 위반 사유 목록 반환 (빈 배열 = 통과). */
const BANNED: Array<[RegExp, string]> = [
  [/\brequire\s*\(/, 'require() 금지'],
  [/\bimport\s*\(/, '동적 import 금지'],
  [/^\s*import\s+(?!type\b)/m, 'import type 외의 import 금지 (런타임 기능은 주입된 http만 사용)'],
  [/\beval\s*\(/, 'eval 금지'],
  [/new\s+Function/, 'new Function 금지'],
  [/\bprocess\b/, 'process 접근 금지 (시크릿은 env 인자로 주입됨)'],
  [/\bfetch\s*\(/, '직접 fetch 금지 (주입된 http 클라이언트만 사용)'],
  [/child_process|node:fs|\bfs\.|node:net|node:dns|XMLHttpRequest|WebSocket/, '시스템/네트워크 모듈 금지'],
  [/globalThis/, 'globalThis 접근 금지'],
];

export function checkAdapterSource(src: string, secrets: string[]): string[] {
  const violations: string[] = [];
  for (const [re, reason] of BANNED) if (re.test(src)) violations.push(reason);
  for (const s of secrets) {
    if (s.length >= 6 && src.includes(s)) violations.push('시크릿 값이 코드에 하드코딩됨');
  }
  if (!/export\s+function\s+createAdapter\s*\(/.test(src)) {
    violations.push('export function createAdapter(env, http) 누락');
  }
  return violations;
}
```

- [ ] **Step 4: 통과 확인 + 커밋** — 두 테스트 PASS

```bash
git add -A && git commit -m "feat: HttpClient(베이스URL 강제) + 어댑터 정적 검사기"
```

---

### Task 13: Adapter Generator (claude 코드 생성 + 재시도 루프)

**Files:**
- Create: `src/setup/generator.ts`
- Test: `tests/generator.test.ts` (+ fixture)

- [ ] **Step 1: fixture 작성** — `tests/fixtures/claude-stub-adapter.sh` (chmod +x). 코드 블록을 포함한 envelope JSON을 출력:

```bash
#!/bin/bash
# stdin 소비 후 어댑터 코드가 든 envelope 출력
cat > /dev/null
cat <<'EOF'
{"result":"생성했습니다.\n```typescript\nimport type { BrokerAdapter, AdapterEnv, HttpClient } from '../../src/broker/adapter.js';\nexport function createAdapter(env: AdapterEnv, http: HttpClient): BrokerAdapter {\n  return {\n    id: 'stub',\n    async auth() {},\n    async getQuotes(symbols) { return symbols.map(s => ({ symbol: s, name: s, price: 1000, bid: 1000, ask: 1000, changeRate: 0, volume: 0 })); },\n    async getBalance() { return { cash: 0, positions: [] }; },\n    async isMarketOpen() { return true; },\n  };\n}\n```"}
EOF
```

- [ ] **Step 2: 테스트 작성** — `tests/generator.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateAdapter } from '../src/setup/generator.js';

describe('generateAdapter', () => {
  it('스텁 claude로 어댑터 생성 → 정적 검사 통과 → 파일 저장', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'gen-'));
    const r = await generateAdapter({
      brokerId: 'stub',
      docsText: '# Fake API docs\nGET /quotes',
      env: { apiKey: 'k', apiSecret: 's', accountNo: 'a', baseUrl: 'https://api.example.com' },
      claudeCmd: 'tests/fixtures/claude-stub-adapter.sh',
      outDir,
      maxAttempts: 1,
      onProgress: () => {},
    });
    expect(r.ok).toBe(true);
    expect(readFileSync(join(outDir, 'adapter.ts'), 'utf-8')).toContain('createAdapter');
  });

  it('정적 검사 실패 코드는 재시도 후 실패 보고', async () => {
    // claude-stub-invalid.sh는 JSON 아닌 출력 → 코드 추출 실패 경로
    const outDir = mkdtempSync(join(tmpdir(), 'gen-'));
    const r = await generateAdapter({
      brokerId: 'bad', docsText: 'x',
      env: { apiKey: 'k', apiSecret: 's', accountNo: 'a', baseUrl: 'https://api.example.com' },
      claudeCmd: 'tests/fixtures/claude-stub-invalid.sh', outDir, maxAttempts: 2, onProgress: () => {},
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });
});
```

- [ ] **Step 3: 실패 확인** → FAIL

- [ ] **Step 4: 구현** — `src/setup/generator.ts`:

```typescript
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AdapterEnv } from '../broker/adapter.js';
import { runClaudeText } from '../brain/runner.js';
import { checkAdapterSource } from './static-check.js';

export interface GenerateInput {
  brokerId: string;
  docsText: string;
  env: AdapterEnv;
  claudeCmd: string;
  outDir: string;          // adapters/<brokerId>
  maxAttempts?: number;    // 기본 3
  onProgress: (msg: string) => void;
}

export interface GenerateResult { ok: boolean; path?: string; error?: string }

function buildGenPrompt(docsText: string, feedback: string | null): string {
  return `당신은 증권사 OpenAPI 어댑터 코드 생성기입니다. 아래 API 문서를 읽고 BrokerAdapter를 구현하십시오.

## 작성 규칙 (위반 시 자동 거부됨)
- 출력은 TypeScript 코드 블록 1개만. 설명 최소화.
- 첫 줄: import type { BrokerAdapter, AdapterEnv, HttpClient } from '../../src/broker/adapter.js';
- 그 외 import 일절 금지. 네트워크는 인자로 받은 http(get/post)만 사용. http의 path는 상대 경로.
- 시크릿은 env.apiKey/env.apiSecret/env.accountNo로만 참조. 하드코딩·로깅 금지.
- export function createAdapter(env: AdapterEnv, http: HttpClient): BrokerAdapter
- 필수 구현: auth(토큰 보관은 클로저 변수), getQuotes, getBalance, isMarketOpen.
- 문서에 캔들/호가/주문 API가 있으면 getCandles/getOrderbook/submitOrder/cancelOrder도 구현.
- Quote 규격: { symbol, name, price, bid, ask, changeRate, volume } — 모르는 값은 name=symbol, bid=ask=price, changeRate=0, volume=0.
- isMarketOpen: 문서에 장운영 API가 없으면 KST 09:00~15:30 평일 여부로 계산.
${feedback ? `\n## 직전 시도 실패 사유 (반드시 수정)\n${feedback}\n` : ''}
## API 문서
${docsText.slice(0, 60_000)}`;
}

function extractCode(text: string): string | null {
  const m = text.match(/```(?:typescript|ts)?\n([\s\S]*?)```/);
  return m ? m[1]!.trim() : null;
}

export async function generateAdapter(input: GenerateInput): Promise<GenerateResult> {
  const max = input.maxAttempts ?? 3;
  const secrets = [input.env.apiKey, input.env.apiSecret].filter(Boolean);
  let feedback: string | null = null;

  for (let attempt = 1; attempt <= max; attempt++) {
    input.onProgress(`어댑터 생성 시도 ${attempt}/${max}...`);
    let text: string;
    try {
      text = await runClaudeText(buildGenPrompt(input.docsText, feedback), { claudeCmd: input.claudeCmd, timeoutMs: 300_000 });
    } catch (err) {
      feedback = `claude 호출 실패: ${String(err)}`;
      continue;
    }
    const code = extractCode(text);
    if (!code) { feedback = '응답에 TypeScript 코드 블록이 없음'; input.onProgress('코드 블록 추출 실패'); continue; }

    const violations = checkAdapterSource(code, secrets);
    if (violations.length > 0) {
      feedback = `정적 검사 위반: ${violations.join('; ')}`;
      input.onProgress(`정적 검사 실패: ${violations.join(', ')}`);
      continue;
    }

    mkdirSync(input.outDir, { recursive: true });
    const path = join(input.outDir, 'adapter.ts');
    writeFileSync(path, code);

    try {
      execFileSync('npx', ['tsc', '--noEmit', '--module', 'nodenext', '--moduleResolution', 'nodenext',
        '--target', 'es2022', '--strict', path], { stdio: 'pipe' });
    } catch (err) {
      feedback = `컴파일 실패: ${String((err as { stdout?: Buffer }).stdout ?? err).slice(0, 2000)}`;
      input.onProgress('컴파일 실패 — 재생성');
      continue;
    }

    input.onProgress('정적 검사·컴파일 통과');
    return { ok: true, path };
  }
  return { ok: false, error: feedback ?? '알 수 없는 실패' };
}
```

참고: `runClaudeText`는 Task 9에서 export됨. 시그니처가 다르면 Task 9 쪽을 기준으로 맞춘다.

- [ ] **Step 5: 통과 확인 + 커밋**

```bash
git add -A && git commit -m "feat: 어댑터 생성기 — claude 코드생성 + 검사/컴파일 재시도 루프"
```

---

### Task 14: Adapter Loader + 연결 테스트 (Validation Gate 2/2)

**Files:**
- Create: `src/broker/loader.ts`, `src/setup/connection-test.ts`
- Test: `tests/loader.test.ts`

- [ ] **Step 1: 테스트 작성**

```typescript
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAdapter } from '../src/broker/loader.js';
import { runConnectionTest } from '../src/setup/connection-test.js';

const GOOD = `
export function createAdapter(env, http) {
  return {
    id: 'tmp',
    async auth() {},
    async getQuotes(symbols) { return symbols.map(s => ({ symbol: s, name: s, price: 1000, bid: 1000, ask: 1000, changeRate: 0, volume: 0 })); },
    async getBalance() { return { cash: 5000, positions: [] }; },
    async isMarketOpen() { return true; },
  };
}`;

function writeTmpAdapter(code: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'adp-'));
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'adapter.mjs');
  writeFileSync(p, code);
  return p;
}

describe('loadAdapter + connection test', () => {
  const env = { apiKey: 'k', apiSecret: 's', accountNo: '12345678', baseUrl: 'https://api.example.com' };

  it('로드된 어댑터는 zod 래핑되어 동작', async () => {
    const a = await loadAdapter(writeTmpAdapter(GOOD), env);
    expect((await a.getQuotes(['A']))[0]!.price).toBe(1000);
  });

  it('연결 테스트: auth→quotes→balance 순서 성공 보고', async () => {
    const a = await loadAdapter(writeTmpAdapter(GOOD), env);
    const r = await runConnectionTest(a, 'A');
    expect(r.ok).toBe(true);
    expect(r.steps.map(s => s.name)).toEqual(['auth', 'getQuotes', 'getBalance']);
  });

  it('연결 테스트: 비정상 응답이면 실패 단계 보고', async () => {
    const BAD = GOOD.replace('price: 1000', 'price: -1');
    const a = await loadAdapter(writeTmpAdapter(BAD), env);
    const r = await runConnectionTest(a, 'A');
    expect(r.ok).toBe(false);
    expect(r.steps.find(s => !s.ok)!.name).toBe('getQuotes');
  });
});
```

- [ ] **Step 2: 실패 확인** → FAIL

- [ ] **Step 3: 구현** — `src/broker/loader.ts`:

```typescript
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { createHttpClient } from '../setup/http-client.js';
import { wrapAdapter, type AdapterEnv, type BrokerAdapter } from './adapter.js';

/**
 * 생성된 어댑터 모듈을 로드해 http 주입 + zod 래핑.
 * tsx 런타임에서는 .ts 직접 import 가능. 경로는 adapter.ts 또는 adapter.mjs.
 */
export async function loadAdapter(path: string, env: AdapterEnv): Promise<BrokerAdapter> {
  if (!existsSync(path)) throw new Error(`어댑터 파일 없음: ${path}`);
  const mod = await import(pathToFileURL(path).href) as { createAdapter?: (env: AdapterEnv, http: unknown) => BrokerAdapter };
  if (typeof mod.createAdapter !== 'function') throw new Error('어댑터에 createAdapter export가 없습니다');
  const http = createHttpClient(env.baseUrl);
  return wrapAdapter(mod.createAdapter(env, http));
}
```

`src/setup/connection-test.ts`:

```typescript
import type { BrokerAdapter } from '../broker/adapter.js';

export interface ConnStep { name: string; ok: boolean; detail: string }
export interface ConnResult { ok: boolean; steps: ConnStep[] }

/** 읽기 전용 3종 연결 테스트. 주문 API는 절대 호출하지 않는다. */
export async function runConnectionTest(adapter: BrokerAdapter, testSymbol: string): Promise<ConnResult> {
  const steps: ConnStep[] = [];
  const run = async (name: string, fn: () => Promise<string>) => {
    try { steps.push({ name, ok: true, detail: await fn() }); return true; }
    catch (err) { steps.push({ name, ok: false, detail: String(err).slice(0, 300) }); return false; }
  };

  if (!(await run('auth', async () => { await adapter.auth(); return '인증 성공'; }))) return { ok: false, steps };
  if (!(await run('getQuotes', async () => {
    const q = await adapter.getQuotes([testSymbol]);
    if (q.length === 0) throw new Error('시세 0건');
    return `${q[0]!.symbol} = ${q[0]!.price}`;
  }))) return { ok: false, steps };
  if (!(await run('getBalance', async () => {
    const b = await adapter.getBalance();
    return `현금 ${b.cash}, 포지션 ${b.positions.length}건`;
  }))) return { ok: false, steps };

  return { ok: true, steps };
}
```

- [ ] **Step 4: 통과 확인 + 커밋**

```bash
git add -A && git commit -m "feat: 어댑터 로더(zod 래핑) + 읽기전용 연결 테스트"
```

---

### Task 15: Setup Orchestrator (온보딩 상태 머신 + 전략/유니버스 생성)

**Files:**
- Create: `src/setup/orchestrator.ts`, `src/env.ts`
- Test: `tests/orchestrator.test.ts`

- [ ] **Step 1: src/env.ts 작성** (의존성 없는 .env 로더/세이버)

```typescript
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export function loadEnvFile(path = '.env'): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

export function saveEnvFile(vars: Record<string, string>, path = '.env'): void {
  const merged = { ...loadEnvFile(path), ...vars };
  writeFileSync(path, Object.entries(merged).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
}
```

- [ ] **Step 2: 테스트 작성** — `tests/orchestrator.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SetupOrchestrator } from '../src/setup/orchestrator.js';

function mkOrch() {
  const root = mkdtempSync(join(tmpdir(), 'setup-'));
  return { root, orch: new SetupOrchestrator({ rootDir: root, claudeCmd: 'tests/fixtures/claude-stub-strategy.sh' }) };
}

describe('SetupOrchestrator', () => {
  it('브로커 등록 시 .env에 시크릿 저장 (코드/설정엔 미포함)', async () => {
    const { root, orch } = mkOrch();
    await orch.registerBroker({ brokerId: 'demo', brokerName: '데모증권', docsUrls: [], baseUrl: 'https://api.demo.com', apiKey: 'KEY1', apiSecret: 'SEC1', accountNo: '111' });
    const env = readFileSync(join(root, '.env'), 'utf-8');
    expect(env).toContain('BROKER_API_KEY=KEY1');
    expect(orch.status().broker?.brokerId).toBe('demo');
    expect(JSON.stringify(orch.status())).not.toContain('SEC1'); // status에 시크릿 노출 금지
  });

  it('전략 업로드 → strategy/에 저장', async () => {
    const { root, orch } = mkOrch();
    await orch.saveStrategyDoc('my-strategy.md', '# 전략\n저평가 매수');
    expect(readFileSync(join(root, 'strategy/my-strategy.md'), 'utf-8')).toContain('저평가');
  });

  it('인터뷰 → claude 스텁이 strategy.md + universe.json 생성', async () => {
    const { root, orch } = mkOrch();
    await orch.generateStrategy({ risk: '중립', capital: 10_000_000, horizon: '스윙(수주)', sectors: ['반도체'] });
    expect(existsSync(join(root, 'strategy/strategy.md'))).toBe(true);
    expect(existsSync(join(root, 'strategy/universe.json'))).toBe(true);
  });

  it('finish → config.json 생성 (brokerId/가드레일 반영)', async () => {
    const { root, orch } = mkOrch();
    await orch.registerBroker({ brokerId: 'demo', brokerName: '데모증권', docsUrls: [], baseUrl: 'https://x.com', apiKey: 'k', apiSecret: 's', accountNo: '1' });
    await orch.finish({ mode: 'paper', guardrails: { maxPositionPct: 15 }, agreed: true });
    const cfg = JSON.parse(readFileSync(join(root, 'config.json'), 'utf-8'));
    expect(cfg.brokerId).toBe('demo');
    expect(cfg.guardrails.maxPositionPct).toBe(15);
  });

  it('면책 미동의 시 finish 거부', async () => {
    const { orch } = mkOrch();
    await expect(orch.finish({ mode: 'paper', guardrails: {}, agreed: false })).rejects.toThrow(/면책/);
  });
});
```

fixture `tests/fixtures/claude-stub-strategy.sh` (chmod +x):

```bash
#!/bin/bash
cat > /dev/null
cat <<'EOF'
{"result":"```json\n{\"strategyMd\":\"# 자동 생성 전략\\n중립 성향 스윙\",\"universe\":[{\"symbol\":\"005930\",\"name\":\"삼성전자\"}]}\n```"}
EOF
```

- [ ] **Step 3: 실패 확인** → FAIL

- [ ] **Step 4: 구현** — `src/setup/orchestrator.ts`:

```typescript
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { saveEnvFile } from '../env.js';
import { runClaudeText } from '../brain/runner.js';
import { generateAdapter, type GenerateResult } from './generator.js';
import { loadAdapter } from '../broker/loader.js';
import { runConnectionTest, type ConnResult } from './connection-test.js';
import type { AdapterEnv } from '../broker/adapter.js';

export interface BrokerReg {
  brokerId: string; brokerName: string; docsUrls: string[];
  baseUrl: string; apiKey: string; apiSecret: string; accountNo: string;
}

export interface SetupStatus {
  step: 'broker' | 'generate' | 'test' | 'strategy' | 'finish' | 'done';
  broker?: { brokerId: string; brokerName: string; baseUrl: string; docsUrls: string[] };
  adapterReady: boolean;
  strategyReady: boolean;
}

export class SetupOrchestrator {
  #root: string;
  #claudeCmd: string;
  #broker: BrokerReg | null = null;

  constructor(opts: { rootDir: string; claudeCmd: string }) {
    this.#root = opts.rootDir;
    this.#claudeCmd = opts.claudeCmd;
  }

  status(): SetupStatus {
    const adapterReady = this.#broker !== null
      && existsSync(join(this.#root, 'adapters', this.#broker.brokerId, 'adapter.ts'));
    const stratDir = join(this.#root, 'strategy');
    const strategyReady = existsSync(stratDir) && readdirSync(stratDir).some(f => f.endsWith('.md'));
    return {
      step: !this.#broker ? 'broker' : !adapterReady ? 'generate' : !strategyReady ? 'strategy' : 'finish',
      broker: this.#broker
        ? { brokerId: this.#broker.brokerId, brokerName: this.#broker.brokerName, baseUrl: this.#broker.baseUrl, docsUrls: this.#broker.docsUrls }
        : undefined,
      adapterReady, strategyReady,
    };
  }

  async registerBroker(reg: BrokerReg): Promise<void> {
    if (!/^[a-z0-9-]+$/.test(reg.brokerId)) throw new Error('brokerId는 소문자/숫자/하이픈만');
    this.#broker = reg;
    saveEnvFile({
      BROKER_API_KEY: reg.apiKey,
      BROKER_API_SECRET: reg.apiSecret,
      BROKER_ACCOUNT_NO: reg.accountNo,
    }, join(this.#root, '.env'));
    // 시크릿 제외 메타만 저장
    mkdirSync(join(this.#root, 'adapters'), { recursive: true });
    writeFileSync(join(this.#root, 'adapters', 'registry.json'), JSON.stringify({
      brokerId: reg.brokerId, brokerName: reg.brokerName, baseUrl: reg.baseUrl, docsUrls: reg.docsUrls,
    }, null, 2));
  }

  async fetchDocs(onProgress: (m: string) => void): Promise<string> {
    if (!this.#broker) throw new Error('브로커 미등록');
    const parts: string[] = [];
    for (const url of this.#broker.docsUrls) {
      onProgress(`문서 수집: ${url}`);
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`문서 fetch 실패 ${res.status}: ${url}`);
      const text = await res.text();
      // HTML이면 태그 제거, JSON(OpenAPI)이면 그대로
      parts.push(text.trimStart().startsWith('<') ? text.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ') : text);
    }
    return parts.join('\n\n---\n\n');
  }

  async generate(onProgress: (m: string) => void): Promise<GenerateResult> {
    if (!this.#broker) throw new Error('브로커 미등록');
    const docsText = this.#broker.docsUrls.length > 0 ? await this.fetchDocs(onProgress) : '(문서 URL 미제공 — 일반 REST 관례로 구현)';
    return generateAdapter({
      brokerId: this.#broker.brokerId, docsText, env: this.#env(),
      claudeCmd: this.#claudeCmd, outDir: join(this.#root, 'adapters', this.#broker.brokerId), onProgress,
    });
  }

  async testConnection(testSymbol: string): Promise<ConnResult> {
    if (!this.#broker) throw new Error('브로커 미등록');
    const adapter = await loadAdapter(join(this.#root, 'adapters', this.#broker.brokerId, 'adapter.ts'), this.#env());
    return runConnectionTest(adapter, testSymbol);
  }

  async saveStrategyDoc(filename: string, content: string): Promise<void> {
    if (!/^[\w.-]+\.(md|txt)$/.test(filename)) throw new Error('파일명은 영숫자 + .md/.txt만');
    mkdirSync(join(this.#root, 'strategy'), { recursive: true });
    writeFileSync(join(this.#root, 'strategy', filename), content);
  }

  async generateStrategy(profile: { risk: string; capital: number; horizon: string; sectors: string[] }): Promise<void> {
    const prompt = `투자 전략 문서와 종목 유니버스를 생성하십시오. JSON 코드블록 1개만 출력:
{"strategyMd": "마크다운 전략 문서 (매매기법/진입·청산 규칙/리스크 관리 포함)", "universe": [{"symbol": "종목코드", "name": "종목명"}, ...최대 30개]}
프로필: 성향 ${profile.risk}, 자금 ${profile.capital.toLocaleString()}원, 기간 ${profile.horizon}, 선호 ${profile.sectors.join(', ')}`;
    const text = await runClaudeText(prompt, { claudeCmd: this.#claudeCmd, timeoutMs: 300_000 });
    const m = text.match(/```(?:json)?\n([\s\S]*?)```/);
    if (!m) throw new Error('전략 생성 응답 파싱 실패');
    const parsed = JSON.parse(m[1]!) as { strategyMd: string; universe: Array<{ symbol: string; name: string }> };
    mkdirSync(join(this.#root, 'strategy'), { recursive: true });
    writeFileSync(join(this.#root, 'strategy', 'strategy.md'), parsed.strategyMd);
    writeFileSync(join(this.#root, 'strategy', 'universe.json'), JSON.stringify(parsed.universe, null, 2));
  }

  async finish(opts: { mode: 'paper' | 'live'; guardrails: Record<string, number>; agreed: boolean }): Promise<void> {
    if (!opts.agreed) throw new Error('면책 고지에 동의해야 시작할 수 있습니다');
    if (!this.#broker) throw new Error('브로커 미등록');
    const existing = existsSync(join(this.#root, 'config.json'))
      ? JSON.parse(readFileSync(join(this.#root, 'config.json'), 'utf-8')) : {};
    writeFileSync(join(this.#root, 'config.json'), JSON.stringify({
      ...existing, mode: opts.mode, brokerId: this.#broker.brokerId,
      guardrails: { ...(existing.guardrails ?? {}), ...opts.guardrails },
    }, null, 2));
  }

  #env(): AdapterEnv {
    const reg = this.#broker!;
    return { apiKey: reg.apiKey, apiSecret: reg.apiSecret, accountNo: reg.accountNo, baseUrl: reg.baseUrl };
  }
}
```

- [ ] **Step 5: 통과 확인 + 커밋**

```bash
git add -A && git commit -m "feat: 온보딩 오케스트레이터 — 브로커 등록/문서 수집/전략·유니버스 생성"
```

---

### Task 16: 서버 (모드 라우팅 + 온보딩 API + 운영 API)

**Files:**
- Create: `src/server/index.ts`
- Test: `tests/server.test.ts`

- [ ] **Step 1: 이식 + 확장 테스트**

```bash
cp $OLD/src/server.ts src/server/index.ts
cp $OLD/tests/server.test.ts tests/server.test.ts
```
import 경로를 새 구조로 수정. 기존 기능(GET /api/state, /events SSE, /vendor/uplot, 정적 서빙+경로탐색 차단, EADDRINUSE reject)은 그대로 유지.

테스트 끝에 추가:

```typescript
describe('온보딩 라우트', () => {
  it('setupMode=true면 /가 setup.html을 서빙', async () => {
    // 기존 startServer 테스트 헬퍼에 setupMode: true, orchestrator: 목 전달
    const res = await fetch(`http://localhost:${port}/`);
    expect(await res.text()).toContain('id="setup-root"');
  });
  it('POST /api/setup/broker → orchestrator.registerBroker 위임', async () => {
    const res = await fetch(`http://localhost:${port}/api/setup/broker`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brokerId: 'demo', brokerName: 'd', docsUrls: [], baseUrl: 'https://x.com', apiKey: 'k', apiSecret: 's', accountNo: '1' }),
    });
    expect(res.status).toBe(200);
  });
});
```
(서버 테스트 헬퍼의 기존 패턴에 맞춰 구체 코드는 이식된 테스트 구조를 따른다.)

- [ ] **Step 2: 서버 확장 구현** — `startServer` 옵션에 추가:

```typescript
export interface ServerDeps {
  // ...기존 필드 유지 (store, broker, config, events 등 이식본 그대로)
  setupMode: boolean;
  orchestrator?: SetupOrchestrator;
  onSetupComplete?: () => void;   // finish 후 main이 운영 모드로 전환할 때 사용
}
```

라우팅 추가 (기존 라우팅 분기에 삽입):

- `setupMode`일 때 `GET /` → `public/setup.html`
- `GET /api/setup/status` → `orchestrator.status()`
- `POST /api/setup/broker` → body JSON 파싱 → `registerBroker` (에러 시 400 + 메시지)
- `POST /api/setup/generate` → 즉시 202 응답 후 백그라운드에서 `orchestrator.generate(progress)` 실행. progress 메시지와 완료/실패는 `GET /api/setup/progress` SSE로 푸시 (기존 SSE 패턴 재사용, 별도 클라이언트 Set)
- `POST /api/setup/test` → `{ testSymbol }` 받아 `testConnection` 결과 JSON
- `POST /api/setup/strategy/upload` → `{ filename, content }` → `saveStrategyDoc`
- `POST /api/setup/strategy/interview` → 프로필 JSON → `generateStrategy` (이것도 진행 SSE)
- `POST /api/setup/finish` → `finish()` 후 `onSetupComplete?.()` 호출, `{ ok: true }` 응답
- 운영 모드 추가 라우트: `POST /api/live/confirm` → `{ last4 }`가 `process.env.BROKER_ACCOUNT_NO?.slice(-4)`와 일치하면 `store.setKV('liveConfirmed', '1')`

body 파싱 헬퍼 (서버 파일에 추가):

```typescript
async function readJson(req: IncomingMessage): Promise<unknown> {
  let data = '';
  for await (const chunk of req) { data += chunk; if (data.length > 1_000_000) throw new Error('body too large'); }
  return JSON.parse(data);
}
```

`GET /api/state` 응답에 추가 필드: `benchmark`(최근 스냅샷의 benchmark), `ordersToday`, `mode`, `brokerName`(registry.json에서).

- [ ] **Step 3: 통과 확인 + 커밋** — `npx vitest run tests/server.test.ts` → PASS

```bash
git add -A && git commit -m "feat: 서버 — 온보딩 라우트/진행 SSE/라이브 확인 API"
```

---

### Task 17: 온보딩 위저드 UI (토스 다크)

**Files:**
- Create: `public/setup.html`, `public/setup.js`, `public/style.css`

**디자인 토큰 (스펙 §8 — 확정 시안)**: 배경 `#101013`, 카드 `#1b1d22` radius 16px, 수익/강조빨강 `#f04452`, 파랑 `#3182f6`, 보조텍스트 `#8b95a1`, 본문 `#e4e6ea`, 폰트 `Pretendard, -apple-system, sans-serif`.

- [ ] **Step 1: public/style.css 작성** — 공용 토큰 + 카드/버튼/폼/배지/로그 스타일:

```css
:root {
  --bg: #101013; --card: #1b1d22; --card-2: #15171b; --line: #26292f;
  --text: #e4e6ea; --sub: #8b95a1; --red: #f04452; --blue: #3182f6; --green: #00d082;
  --radius: 16px;
}
* { box-sizing: border-box; margin: 0; }
body { background: var(--bg); color: var(--text); font-family: Pretendard, -apple-system, 'Apple SD Gothic Neo', sans-serif; }
.wrap { max-width: 760px; margin: 0 auto; padding: 24px 16px 64px; }
.card { background: var(--card); border-radius: var(--radius); padding: 18px; margin-bottom: 10px; }
.sub { color: var(--sub); font-size: 12px; }
.badge { display: inline-block; padding: 4px 10px; border-radius: 20px; font-size: 11px; font-weight: 700; background: #2a3038; color: var(--sub); }
.badge.live { background: rgba(240,68,82,.15); color: var(--red); }
.badge.ok { background: rgba(0,208,130,.12); color: var(--green); }
button.primary { background: var(--blue); color: #fff; border: 0; border-radius: 12px; padding: 12px 20px; font-size: 14px; font-weight: 700; cursor: pointer; width: 100%; }
button.primary:disabled { opacity: .4; cursor: default; }
button.primary:hover:not(:disabled) { filter: brightness(1.1); }
input, textarea, select { background: var(--card-2); border: 1px solid var(--line); color: var(--text); border-radius: 10px; padding: 11px 12px; font-size: 14px; width: 100%; margin-top: 6px; }
input:focus, textarea:focus { outline: none; border-color: var(--blue); }
label { display: block; margin-top: 14px; font-size: 13px; color: var(--sub); }
.steps { display: flex; gap: 6px; margin-bottom: 18px; }
.steps .dot { flex: 1; height: 4px; border-radius: 2px; background: var(--line); }
.steps .dot.on { background: var(--blue); }
.log { background: var(--card-2); border-radius: 10px; padding: 12px; font-family: ui-monospace, monospace; font-size: 12px; max-height: 240px; overflow-y: auto; white-space: pre-wrap; color: var(--sub); }
.up { color: var(--red); } .down { color: var(--blue); }
h1 { font-size: 17px; font-weight: 800; }
h2 { font-size: 15px; font-weight: 700; margin-bottom: 8px; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
td, th { padding: 9px 4px; border-bottom: 1px solid var(--line); text-align: left; }
th { color: var(--sub); font-weight: 500; font-size: 11px; }
td.num, th.num { text-align: right; }
.row { display: flex; justify-content: space-between; align-items: center; }
.grid3 { display: grid; grid-template-columns: 2fr 1fr 1fr; gap: 10px; }
@media (max-width: 640px) { .grid3 { grid-template-columns: 1fr; } }
```

- [ ] **Step 2: public/setup.html 작성** — 5단계 위저드 컨테이너:

```html
<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>open-trader 설정</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <div class="wrap" id="setup-root">
    <div class="row" style="margin-bottom:18px">
      <h1>open-trader 시작하기</h1>
      <span class="badge">SETUP</span>
    </div>
    <div class="steps" id="steps">
      <div class="dot on"></div><div class="dot"></div><div class="dot"></div><div class="dot"></div><div class="dot"></div>
    </div>

    <section class="card" id="step-broker">
      <h2>① 증권사 연결</h2>
      <p class="sub">증권사 OpenAPI 문서 URL과 API 키를 입력하면 Claude가 어댑터를 자동 생성합니다. 키는 이 컴퓨터의 .env 파일에만 저장됩니다.</p>
      <label>증권사 이름 <input id="brokerName" placeholder="예: 한국투자증권"></label>
      <label>브로커 ID (영문 소문자) <input id="brokerId" placeholder="예: kis"></label>
      <label>API Base URL <input id="baseUrl" placeholder="https://openapi.example.com"></label>
      <label>OpenAPI 문서 URL (줄바꿈으로 여러 개) <textarea id="docsUrls" rows="3" placeholder="https://.../openapi.json"></textarea></label>
      <label>API Key <input id="apiKey" type="password"></label>
      <label>API Secret <input id="apiSecret" type="password"></label>
      <label>계좌번호 <input id="accountNo"></label>
      <button class="primary" id="btn-broker" style="margin-top:18px">어댑터 생성 시작</button>
    </section>

    <section class="card" id="step-generate" hidden>
      <h2>② 어댑터 생성 중</h2>
      <p class="sub">Claude가 API 문서를 읽고 어댑터 코드를 작성합니다. 생성된 코드는 정적 검사·컴파일·실연결 테스트를 통과해야 활성화됩니다.</p>
      <div class="log" id="gen-log"></div>
    </section>

    <section class="card" id="step-test" hidden>
      <h2>③ 연결 테스트</h2>
      <label>테스트 종목코드 <input id="testSymbol" placeholder="예: 005930"></label>
      <button class="primary" id="btn-test" style="margin-top:14px">인증 → 시세 → 잔고 테스트</button>
      <div class="log" id="test-log" style="margin-top:12px"></div>
    </section>

    <section class="card" id="step-strategy" hidden>
      <h2>④ 전략 설정</h2>
      <p class="sub">전략 문서를 업로드하거나, 몇 가지 질문에 답하면 Claude가 초안을 만들어줍니다.</p>
      <label>전략 문서 직접 입력 (Markdown) <textarea id="strategyText" rows="6" placeholder="# 내 전략..."></textarea></label>
      <button class="primary" id="btn-strategy-upload" style="margin-top:10px">이 문서 사용</button>
      <hr style="border-color:var(--line);margin:18px 0">
      <p class="sub">또는 인터뷰로 생성:</p>
      <label>성향 <select id="risk"><option>보수</option><option selected>중립</option><option>공격</option></select></label>
      <label>투자 기간 <select id="horizon"><option>단기(수일)</option><option selected>스윙(수주)</option><option>중장기(수개월)</option></select></label>
      <label>선호 섹터 (쉼표 구분) <input id="sectors" placeholder="반도체, 2차전지"></label>
      <button class="primary" id="btn-strategy-gen" style="margin-top:14px">Claude에게 전략 생성 요청</button>
      <div class="log" id="strategy-log" style="margin-top:12px" hidden></div>
    </section>

    <section class="card" id="step-finish" hidden>
      <h2>⑤ 운전 시작</h2>
      <p class="sub">가드레일은 코드로 강제됩니다. 기본값을 권장합니다.</p>
      <label>종목당 최대 비중 % <input id="g-maxPositionPct" type="number" value="20"></label>
      <label>일일 최대 주문 수 <input id="g-maxOrdersPerDay" type="number" value="10"></label>
      <label>일일 손실 한도 % (도달 시 매수 정지) <input id="g-dailyLossLimitPct" type="number" value="3"></label>
      <div class="card" style="background:var(--card-2);margin-top:16px">
        <p class="sub">⚠ 모든 운전은 <b style="color:var(--text)">페이퍼 모드(가상 체결)</b>로 시작합니다. 이 소프트웨어는 투자 손실에 대해 어떤 책임도 지지 않으며, 모든 매매 결과는 사용자 본인 책임입니다.</p>
        <label style="display:flex;gap:8px;align-items:center;margin-top:10px"><input type="checkbox" id="agree" style="width:auto"> 위 내용을 이해했고 동의합니다</label>
      </div>
      <button class="primary" id="btn-finish" style="margin-top:16px">페이퍼 트레이딩 시작</button>
    </section>
  </div>
  <script src="/setup.js"></script>
</body>
</html>
```

- [ ] **Step 3: public/setup.js 작성** — 위저드 로직 (모든 동적 텍스트는 textContent로 — XSS 금지):

```javascript
const $ = (id) => document.getElementById(id);
const show = (id) => {
  for (const s of document.querySelectorAll('section.card')) s.hidden = true;
  $(id).hidden = false;
  const order = ['step-broker', 'step-generate', 'step-test', 'step-strategy', 'step-finish'];
  document.querySelectorAll('#steps .dot').forEach((d, i) => d.classList.toggle('on', i <= order.indexOf(id)));
};
const appendLog = (el, msg) => { el.textContent += msg + '\n'; el.scrollTop = el.scrollHeight; };

async function post(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(await res.text());
  return res.status === 202 ? null : res.json();
}

$('btn-broker').onclick = async () => {
  $('btn-broker').disabled = true;
  try {
    await post('/api/setup/broker', {
      brokerName: $('brokerName').value.trim(), brokerId: $('brokerId').value.trim(),
      baseUrl: $('baseUrl').value.trim(),
      docsUrls: $('docsUrls').value.split('\n').map(s => s.trim()).filter(Boolean),
      apiKey: $('apiKey').value, apiSecret: $('apiSecret').value, accountNo: $('accountNo').value.trim(),
    });
    show('step-generate');
    const es = new EventSource('/api/setup/progress');
    es.onmessage = (e) => {
      const d = JSON.parse(e.data);
      appendLog($('gen-log'), d.message);
      if (d.done) { es.close(); d.ok ? show('step-test') : appendLog($('gen-log'), '❌ 생성 실패 — 문서 URL을 확인하고 새로고침 후 재시도하세요.'); }
    };
    await post('/api/setup/generate', {});
  } catch (err) {
    alert('등록 실패: ' + err.message);
    $('btn-broker').disabled = false;
  }
};

$('btn-test').onclick = async () => {
  $('test-log').textContent = '';
  try {
    const r = await post('/api/setup/test', { testSymbol: $('testSymbol').value.trim() });
    for (const s of r.steps) appendLog($('test-log'), `${s.ok ? '✓' : '✗'} ${s.name}: ${s.detail}`);
    if (r.ok) { appendLog($('test-log'), '연결 성공 — 전략 설정으로 이동합니다.'); setTimeout(() => show('step-strategy'), 800); }
  } catch (err) { appendLog($('test-log'), '테스트 실패: ' + err.message); }
};

$('btn-strategy-upload').onclick = async () => {
  await post('/api/setup/strategy/upload', { filename: 'strategy.md', content: $('strategyText').value });
  show('step-finish');
};

$('btn-strategy-gen').onclick = async () => {
  $('strategy-log').hidden = false;
  appendLog($('strategy-log'), 'Claude가 전략을 작성 중...');
  try {
    await post('/api/setup/strategy/interview', {
      risk: $('risk').value, capital: 10000000, horizon: $('horizon').value,
      sectors: $('sectors').value.split(',').map(s => s.trim()).filter(Boolean),
    });
    appendLog($('strategy-log'), '완료 — strategy/strategy.md 생성됨');
    setTimeout(() => show('step-finish'), 800);
  } catch (err) { appendLog($('strategy-log'), '실패: ' + err.message); }
};

$('btn-finish').onclick = async () => {
  try {
    await post('/api/setup/finish', {
      mode: 'paper', agreed: $('agree').checked,
      guardrails: {
        maxPositionPct: Number($('g-maxPositionPct').value),
        maxOrdersPerDay: Number($('g-maxOrdersPerDay').value),
        dailyLossLimitPct: Number($('g-dailyLossLimitPct').value),
      },
    });
    document.body.innerHTML = '<div class="wrap"><div class="card"><h2>설정 완료</h2><p class="sub">대시보드로 이동합니다...</p></div></div>';
    setTimeout(() => location.href = '/', 1500);
  } catch (err) { alert(err.message); }
};

// 새로고침 시 진행 단계 복원
fetch('/api/setup/status').then(r => r.json()).then(s => {
  if (s.step === 'strategy') show('step-strategy');
  else if (s.step === 'finish') show('step-finish');
  else if (s.step === 'generate' || s.step === 'test') show('step-test');
});
```

- [ ] **Step 4: 수동 확인 + 커밋**

Run: `npx tsc --noEmit && npx vitest run`
Expected: 전체 PASS (UI는 Task 20 E2E에서 검증)

```bash
git add -A && git commit -m "feat: 온보딩 위저드 UI (토스 다크)"
```

---

### Task 18: 운영 대시보드 UI (토스 다크 + 벤치마크 카드)

**Files:**
- Create: `public/index.html`, `public/app.js`

- [ ] **Step 1: public/index.html 작성** — 확정 레이아웃 (상단 3카드 / 차트 / 포지션 / AI 로그):

```html
<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>open-trader</title>
  <link rel="stylesheet" href="/style.css">
  <link rel="stylesheet" href="/vendor/uplot.min.css">
</head>
<body>
  <div class="wrap">
    <div class="row" style="margin-bottom:18px">
      <div class="row" style="gap:10px">
        <h1>open-trader</h1>
        <span class="badge" id="mode-badge">PAPER</span>
        <span class="badge ok" id="broker-badge">연결 확인 중…</span>
      </div>
      <span class="sub" id="status-line">—</span>
    </div>
    <div class="card" id="warn-banner" hidden style="border:1px solid var(--red)">
      <span class="sub" id="warn-text" style="color:var(--red)"></span>
    </div>

    <div class="grid3">
      <div class="card">
        <div class="sub">총자산</div>
        <div id="equity" style="font-size:28px;font-weight:800;margin:2px 0">—</div>
        <div id="pnl" style="font-size:13px;font-weight:600">—</div>
      </div>
      <div class="card">
        <div class="sub">vs 벤치마크</div>
        <div id="bench-diff" style="font-size:22px;font-weight:800;margin:2px 0">—</div>
        <div class="sub" id="bench-abs">—</div>
      </div>
      <div class="card">
        <div class="sub">오늘 거래</div>
        <div id="orders-today" style="font-size:22px;font-weight:800;margin:2px 0">—</div>
        <div class="sub" id="fees-today">—</div>
      </div>
    </div>

    <div class="card">
      <div class="row" style="margin-bottom:8px">
        <h2 style="margin:0">자산 추이</h2>
        <span class="sub"><span class="up">— 내 자산</span> &nbsp;<span style="color:#566070">— 벤치마크</span></span>
      </div>
      <div id="chart"></div>
    </div>

    <div class="card">
      <h2 id="positions-title">보유 포지션</h2>
      <table>
        <thead><tr><th>종목</th><th class="num">수량</th><th class="num">평단</th><th class="num">현재가</th><th class="num">평가손익</th></tr></thead>
        <tbody id="positions"></tbody>
      </table>
    </div>

    <div class="card">
      <h2>AI 판단 로그</h2>
      <div id="decisions"></div>
    </div>
  </div>
  <script src="/vendor/uplot.iife.min.js"></script>
  <script src="/app.js"></script>
</body>
</html>
```

- [ ] **Step 2: public/app.js 작성** — $OLD/public/app.js의 SSE·uPlot·렌더 패턴을 기반으로 하되 다음을 반영 (전체 재작성):

```javascript
const $ = (id) => document.getElementById(id);
const won = (n) => Math.round(n).toLocaleString('ko-KR') + '원';
const pct = (n) => (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
const cls = (n) => (n >= 0 ? 'up' : 'down');
let chart;

function render(s) {
  // 헤더
  $('mode-badge').textContent = s.mode.toUpperCase();
  $('mode-badge').classList.toggle('live', s.mode === 'live');
  $('broker-badge').textContent = '● ' + (s.brokerName || 'mock') + ' 연결됨';
  $('status-line').textContent = `마지막 업데이트 ${new Date(s.updatedAt).toLocaleTimeString('ko-KR')} · 가드레일 정상`;
  $('warn-banner').hidden = !s.warning;
  if (s.warning) $('warn-text').textContent = s.warning;

  // 3카드
  const totalPnlPct = (s.equity / s.initialCash - 1) * 100;
  $('equity').textContent = won(s.equity);
  $('pnl').textContent = `${won(s.equity - s.initialCash).replace('-', '−')} (${pct(totalPnlPct)}) · 오늘 ${pct(s.dailyPnlPct)}`;
  $('pnl').className = cls(totalPnlPct);

  if (s.benchmark) {
    const benchPct = (s.benchmark / s.initialCash - 1) * 100;
    const diff = totalPnlPct - benchPct;
    $('bench-diff').textContent = (diff >= 0 ? '+' : '') + diff.toFixed(2) + '%p';
    $('bench-diff').className = cls(diff);
    $('bench-abs').textContent = '벤치마크 ' + pct(benchPct);
  }

  $('orders-today').textContent = `${s.ordersToday}/${s.maxOrdersPerDay}건`;
  $('fees-today').textContent = `수수료·세금 누적 ${won(s.feesTotal ?? 0)}`;

  // 포지션
  $('positions-title').textContent = `보유 포지션 ${s.positions.length}`;
  const tbody = $('positions');
  tbody.textContent = '';
  for (const p of s.positions) {
    const cur = s.quotes?.[p.symbol]?.price ?? p.avgPrice;
    const pnlP = (cur / p.avgPrice - 1) * 100;
    const tr = document.createElement('tr');
    for (const [text, klass] of [
      [p.name, ''], [p.quantity + '주', 'num'], [won(p.avgPrice), 'num'],
      [won(cur), 'num'], [pct(pnlP), 'num ' + cls(pnlP)],
    ]) {
      const td = document.createElement('td');
      td.textContent = text; td.className = klass; tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }

  // 판단 로그 (textContent만 — XSS 방지)
  const box = $('decisions');
  box.textContent = '';
  for (const d of s.decisions) {
    const item = document.createElement('div');
    item.style.cssText = 'padding:10px;background:var(--card-2);border-radius:10px;margin-bottom:8px';
    const head = document.createElement('div');
    head.className = 'sub';
    head.textContent = `${new Date(d.ts).toLocaleTimeString('ko-KR')} · ${d.action} ${d.name ?? ''} ${d.quantity ?? ''} · ${d.status}${d.rejectReason ? ' — ' + d.rejectReason : ''}`;
    const body = document.createElement('div');
    body.style.cssText = 'font-size:12.5px;margin-top:4px;line-height:1.55';
    body.textContent = d.reasoning + (d.thesis ? ` [thesis: ${JSON.parse(d.thesis).target} / ${JSON.parse(d.thesis).stop}]` : '');
    item.append(head, body);
    box.appendChild(item);
  }

  // 차트: 내 자산 vs 벤치마크
  const xs = s.snapshots.map(r => new Date(r.ts).getTime() / 1000);
  const equitySeries = s.snapshots.map(r => r.equity);
  const benchSeries = s.snapshots.map(r => r.benchmark);
  const data = [xs, equitySeries, benchSeries];
  if (!chart) {
    chart = new uPlot({
      width: Math.min(720, document.body.clientWidth - 64), height: 200,
      series: [{}, { stroke: '#f04452', width: 2 }, { stroke: '#566070', width: 1.5, dash: [4, 4] }],
      axes: [{ stroke: '#8b95a1', grid: { stroke: '#26292f' } }, { stroke: '#8b95a1', grid: { stroke: '#26292f' } }],
      legend: { show: false },
    }, data, $('chart'));
  } else chart.setData(data);
}

async function load() {
  try { render(await (await fetch('/api/state')).json()); }
  catch { $('warn-banner').hidden = false; $('warn-text').textContent = '서버 응답 없음'; }
}
load();
const es = new EventSource('/events');
es.onmessage = (e) => { try { render(JSON.parse(e.data)); } catch { /* 무시 */ } };
setInterval(() => {
  const m = $('status-line').textContent.match(/(\d+:\d+:\d+)/);
  if (!m) return;
}, 30000);
```

`/api/state`가 위 필드(`initialCash`, `quotes`(symbol→quote 맵), `maxOrdersPerDay`, `feesTotal`, `snapshots`, `decisions`, `warning`, `updatedAt`)를 제공하도록 Task 16의 `buildState`를 보강한다 (`feesTotal`은 `SELECT SUM(fee+tax) FROM trades` 헬퍼 `store.totalFees()` 추가).

- [ ] **Step 3: 검증 + 커밋** — `npx tsc --noEmit && npx vitest run` → PASS

```bash
git add -A && git commit -m "feat: 운영 대시보드 — 토스 다크 + 벤치마크/오늘거래 카드"
```

---

### Task 19: main.ts 조립 + 라이브 3중 잠금

**Files:**
- Create: `src/main.ts`, `src/broker/live.ts`
- Test: `tests/live-lock.test.ts`

- [ ] **Step 1: 라이브 잠금 테스트**

```typescript
import { describe, it, expect } from 'vitest';
import { assertLiveUnlocked } from '../src/broker/live.js';

describe('라이브 3중 잠금', () => {
  const store = { getKV: (k: string) => (k === 'liveConfirmed' ? '1' : null) };
  it('세 조건 모두 충족 시에만 통과', () => {
    expect(() => assertLiveUnlocked('live', '1', store as never)).not.toThrow();
  });
  it.each([
    ['paper', '1', true], ['live', undefined, true], ['live', '1', false],
  ] as const)('mode=%s env=%s confirmed=%s → 차단', (mode, env, confirmed) => {
    const s = { getKV: () => (confirmed ? '1' : null) };
    expect(() => assertLiveUnlocked(mode, env, s as never)).toThrow(/라이브 잠금/);
  });
});
```

- [ ] **Step 2: 실패 확인** → FAIL

- [ ] **Step 3: src/broker/live.ts 구현**

```typescript
import type { Store } from '../core/store.js';

/**
 * 라이브 3중 잠금: ① config mode=live ② OPEN_TRADER_LIVE=1 ③ 대시보드 계좌 끝4자리 확인(KV liveConfirmed).
 * 하나라도 빠지면 throw — submitOrder 경로는 이 함수를 통과해야만 실행된다.
 */
export function assertLiveUnlocked(mode: string, envFlag: string | undefined, store: Pick<Store, 'getKV'>): void {
  if (mode !== 'live') throw new Error('라이브 잠금: config.json mode가 live가 아닙니다');
  if (envFlag !== '1') throw new Error('라이브 잠금: 환경변수 OPEN_TRADER_LIVE=1 필요');
  if (store.getKV('liveConfirmed') !== '1') throw new Error('라이브 잠금: 대시보드에서 계좌 확인 필요');
}
```

- [ ] **Step 4: src/main.ts 작성** ($OLD/src/main.ts 패턴 기반):

```typescript
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { loadConfig, isConfigured } from './core/config.js';
import { Store } from './core/store.js';
import { PaperBroker } from './broker/paper.js';
import { MockAdapter } from './broker/mock.js';
import { loadAdapter } from './broker/loader.js';
import { assertLiveUnlocked } from './broker/live.js';
import { loadEnvFile } from './env.js';
import { runCycle } from './core/cycle.js';
import { startScheduler } from './core/scheduler.js';
import { runBrain, BrainAuthError } from './brain/runner.js';
import { startServer } from './server/index.js';
import { SetupOrchestrator } from './setup/orchestrator.js';
import type { UniverseEntry } from './core/types.js';

const ROOT = process.cwd();

function notifyMac(msg: string): void {
  if (process.platform === 'darwin') {
    execFile('osascript', ['-e', `display notification ${JSON.stringify(msg)} with title "open-trader"`], () => {});
  }
}

function loadStrategyDocs(): string {
  const dir = join(ROOT, 'strategy');
  if (!existsSync(dir)) return '(전략 문서 없음 — 보수적으로 HOLD 위주로 판단할 것)';
  return readdirSync(dir).filter(f => f.endsWith('.md') || f.endsWith('.txt'))
    .map(f => readFileSync(join(dir, f), 'utf-8')).join('\n\n---\n\n') || '(전략 문서 없음)';
}

function loadUniverse(): UniverseEntry[] {
  const p = join(ROOT, 'strategy', 'universe.json');
  if (!existsSync(p)) throw new Error('strategy/universe.json 없음 — 온보딩을 먼저 완료하세요');
  return JSON.parse(readFileSync(p, 'utf-8'));
}

async function main(): Promise<void> {
  const config = loadConfig();
  const events = new EventEmitter();

  // ── 온보딩 모드 ───────────────────────────────────────────
  if (!isConfigured() && config.brokerId !== 'mock') {
    const orchestrator = new SetupOrchestrator({ rootDir: ROOT, claudeCmd: config.claudeCmd });
    await startServer({
      config, events, setupMode: true, orchestrator,
      onSetupComplete: () => {
        console.log('온보딩 완료 — 데몬을 재시작합니다.');
        setTimeout(() => process.exit(0), 500); // launchd/사용자가 재시작 → 운영 모드 진입
      },
    } as never);
    console.log(`온보딩: http://localhost:${config.port} 를 브라우저로 여세요`);
    return;
  }

  // ── 운영 모드 ────────────────────────────────────────────
  const store = new Store(config.dbPath);
  const universe = loadUniverse();
  const strategyDocs = loadStrategyDocs();

  const adapter = config.brokerId === 'mock'
    ? new MockAdapter(universe)
    : await loadAdapter(join(ROOT, 'adapters', config.brokerId, 'adapter.ts'), {
        ...{ apiKey: '', apiSecret: '', accountNo: '', baseUrl: '' },
        apiKey: loadEnvFile().BROKER_API_KEY ?? '',
        apiSecret: loadEnvFile().BROKER_API_SECRET ?? '',
        accountNo: loadEnvFile().BROKER_ACCOUNT_NO ?? '',
        baseUrl: JSON.parse(readFileSync(join(ROOT, 'adapters', 'registry.json'), 'utf-8')).baseUrl,
      });

  if (config.mode === 'live') {
    try {
      assertLiveUnlocked(config.mode, process.env.OPEN_TRADER_LIVE, store);
      console.error('라이브 모드는 v1에서 주문 연동이 검증되지 않았습니다. 페이퍼로 운전하세요.');
      process.exit(1); // LiveTossBroker 상당물은 별도 스펙 — 잠금 통과해도 v1은 거부
    } catch (err) {
      console.error(String(err));
      process.exit(1);
    }
  }

  const saved = store.getKV('broker');
  const rates = { feeRate: config.feeRate, taxRate: config.taxRate, halfSpreadPct: config.halfSpreadPct };
  const broker = saved ? PaperBroker.fromJSON(JSON.parse(saved), rates)
    : new PaperBroker({ initialCash: config.initialCash, ...rates });

  let consecutiveAuthErrors = 0;
  const deps = {
    config, universe, adapter, broker, store, strategyDocs, events,
    brain: async (prompt: string) => {
      try {
        const out = await runBrain(prompt, { claudeCmd: config.claudeCmd, timeoutMs: 180_000 });
        consecutiveAuthErrors = 0;
        return out;
      } catch (err) {
        if (err instanceof BrainAuthError && ++consecutiveAuthErrors <= 3) {
          store.setKV('warning', 'claude CLI 인증 필요 — 터미널에서 claude login 후 재시작하세요');
          notifyMac('claude 인증 만료 — 자동매매 중단됨');
        }
        throw err;
      }
    },
  };

  startScheduler({
    cycleMinutes: config.cycleMinutes,
    isMarketOpen: () => adapter.isMarketOpen(),
    runFn: () => runCycle(deps),
    onMarketClose: () => {
      broker.cancelAllPending();
      store.setKV('broker', JSON.stringify(broker.toJSON()));
    },
  });

  await startServer({ config, store, broker, events, setupMode: false } as never);
  console.log(`대시보드: http://localhost:${config.port} (모드: ${config.mode}, 브로커: ${config.brokerId})`);

  const shutdown = () => {
    store.setKV('broker', JSON.stringify(broker.toJSON()));
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(err => { console.error(err); process.exit(1); });
```

주: `startScheduler`/`startServer`의 실제 시그니처는 이식본(Task 11/16)을 따른다 — 불일치 시 이식본 시그니처가 기준.

- [ ] **Step 5: 데모 운전 확인**

`config.json`을 임시 생성해 mock으로 기동:

```bash
echo '{"brokerId":"mock","cycleMinutes":30}' > config.json
mkdir -p strategy
echo '[{"symbol":"005930","name":"삼성전자"},{"symbol":"000660","name":"SK하이닉스"}]' > strategy/universe.json
echo '# 데모 전략' > strategy/strategy.md
timeout 10 npx tsx src/main.ts || true
```
Expected: "대시보드: http://localhost:3000" 출력, 크래시 없음. 확인 후 `rm config.json` (데모 파일 정리 — strategy/는 gitignore라 무방).

- [ ] **Step 6: 테스트 + 커밋** — `npx vitest run` 전체 PASS

```bash
git add -A && git commit -m "feat: main 조립 — 온보딩/운영 모드 분기, 라이브 3중 잠금"
```

---

### Task 20: README · E2E · 최종 검증

**Files:**
- Create: `README.md`, `LICENSE`, `e2e/dashboard.spec.ts`, `e2e/serve-fixture.ts`

- [ ] **Step 1: LICENSE (MIT) 작성** — 표준 MIT 본문, copyright `2026 open-trader contributors`.

- [ ] **Step 2: README.md 작성**

```markdown
# open-trader

> ⚠️ **면책**: 이 소프트웨어는 교육·연구 목적의 오픈소스입니다. 모든 매매 판단과 손실은 전적으로 사용자 본인 책임입니다. 기본 모드는 가상 체결(페이퍼)이며, 실거래 전환은 권장하지 않습니다.

어떤 증권사든 OpenAPI 문서 URL + API 키만 넣으면 **Claude가 어댑터를 자동 생성**해 연결하고,
자연어 전략 문서로 자동매매를 돌리는 범용 AI 트레이딩 하네스.

## 시작하기 (3줄)

​```bash
git clone <repo> && cd open-trader
npm install
npm start   # 브라우저에서 온보딩이 열립니다
​```

요구사항: Node 20+, [Claude Code CLI](https://claude.com/claude-code) 로그인 상태 (구독 사용).

## 동작 원리

1. **온보딩**: 증권사 OpenAPI 문서 URL과 키를 입력 → Claude가 어댑터 코드 생성 → 정적 검사(금지 API)·컴파일·읽기전용 연결 테스트 통과 시 활성화
2. **운영**: 장중 30분 간격으로 Claude가 전략 문서 + 시세 + 포지션 thesis를 보고 판단 → 코드 가드레일 통과분만 체결(가상) → 대시보드에 실시간 표시
3. **안전**: 돈이 움직이는 경로는 전부 결정론적 코드. 모든 에러의 기본 동작은 "거래 안 함". 라이브는 3중 잠금.

## 설정

`config.json` 가드레일: 종목 비중/주문 상한/일일 손실/일일 주문 수/재진입 쿨다운/총 노출.
시크릿은 `.env`에만 저장되며 `adapters/`, `strategy/`, `data/`, `.env`는 git에 올라가지 않습니다.
```

`package.json` scripts에 `"start": "tsx src/main.ts"` 추가.

- [ ] **Step 3: E2E 이식·작성**

```bash
cp $OLD/e2e/serve-fixture.ts e2e/serve-fixture.ts
cp $OLD/e2e/dashboard.spec.ts e2e/dashboard.spec.ts
```
import/필드를 새 `/api/state` 구조에 맞게 수정하고, 테스트 추가:

```typescript
test('온보딩 페이지가 렌더링된다', async ({ page }) => {
  await page.goto('/setup.html');
  await expect(page.locator('#step-broker')).toBeVisible();
  await expect(page.locator('text=증권사 연결')).toBeVisible();
});

test('대시보드에 벤치마크 카드가 보인다', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#bench-diff')).toBeVisible();
});
```

- [ ] **Step 4: 최종 검증**

```bash
npx tsc --noEmit && npx vitest run && npx playwright test
```
Expected: 타입 클린, 유닛/통합 전체 PASS, e2e PASS

- [ ] **Step 5: 커밋**

```bash
git add -A && git commit -m "docs: README/LICENSE + e2e 검증"
```

---

## Self-Review 결과 (계획 작성 후 점검)

- **스펙 커버리지**: §3 온보딩(T15-17), 어댑터 생성·게이트(T12-14), §4 규격(T2), §5 사이클·thesis(T8-10), §6 가드레일(T5)·3중 잠금(T19), §7 페이퍼 스프레드(T4), §8 프론트(T17-18), §9 에러·알림(T9, T19), §10 테스트(각 태스크+T20), §11 구조(T1), §13 면책(T17, T20). 누락 없음.
- **타입 일관성**: `BrokerAdapter`/`AdapterEnv`/`HttpClient`(T2) ↔ generator 프롬프트(T13) ↔ loader(T14) 시그니처 일치 확인. `GuardrailContext` 확장(T5) ↔ cycle 호출부(T10) 일치. `runClaudeText`(T9) ↔ generator/orchestrator(T13/15) 일치.
- **주의**: 이식 태스크의 시그니처 충돌 시 **이식본이 기준** — 계획의 의사 시그니처는 이식 후 실물에 맞춘다 (T16, T19에 명시).
