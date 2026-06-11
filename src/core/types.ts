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
