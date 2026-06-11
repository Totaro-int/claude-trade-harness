import { z } from 'zod';

const ThesisSchema = z.object({
  why: z.string().min(1),
  target: z.string().min(1),
  stop: z.string().min(1),
  exitCondition: z.string().min(1),
});

// HOLD는 전역 관망 — 종목별 hold가 아니라 "이번 사이클은 아무것도 안 함"
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
  // 빈 문자열 허용 — 표시용 필드 때문에 전체 판단을 거부하지 않는다 (fail-safe)
  marketView: z.string(),
  decisions: z.array(z.discriminatedUnion('action', [BuySchema, SellSchema, HoldSchema])),
});
