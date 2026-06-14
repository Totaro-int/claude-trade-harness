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

export type FillResult =
  | { status: 'FILLED'; fillPrice: number; fee: number; tax: number }
  | { status: 'PENDING' }
  | { status: 'REJECTED'; reason: string };

export type FilledResult = Extract<FillResult, { status: 'FILLED' }>;

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

/** 청산된 포지션의 thesis 결과 기록 — 두뇌가 과거 매매에서 배우게 하는 메모리. */
export interface Reflection {
  ts: string;            // 청산 시각 ISO
  symbol: string;
  name: string;
  why: string;           // 진입 당시 thesis.why
  target: string;        // thesis.target
  stop: string;          // thesis.stop
  entryPrice: number;    // 청산 시점 avgPrice
  exitPrice: number;     // 체결가
  pnlPct: number;        // (exit/entry - 1) * 100
  heldHours: number;     // 보유 시간(시간), 음수면 0으로 클램프 (일봉 백테스트에선 0)
  result: 'WIN' | 'LOSS';
}

export interface IndicatorRow {
  symbol: string;
  ma5?: number;
  ma20?: number;
  change5d?: number;    // 5거래일 등락률 %
  rsi14?: number;       // RSI(14), 0~100 — 과매수/과매도
  atrPct?: number;      // ATR(14) ÷ 현재가 × 100 (%) — 변동성
  drawdownPct?: number; // 최근 20봉 고점 대비 낙폭 (%, ≥0)
  volume?: number;      // 최근 봉 거래량
}
