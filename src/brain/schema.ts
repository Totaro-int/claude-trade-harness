import { z } from 'zod';

const ThesisSchema = z.object({
  why: z.string().min(1),
  target: z.string().min(1),
  stop: z.string().min(1),
  exitCondition: z.string().min(1),
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
