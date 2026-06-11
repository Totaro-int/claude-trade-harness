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

// zod v4: ZodTypeDef is not exported; use ZodType<T> directly and cast the parsed output
function validate<T>(method: string, schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new AdapterContractError(method, r.error.message);
  return r.data as T;
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
