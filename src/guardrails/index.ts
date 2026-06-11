import type { GuardrailLimits } from '../core/config.js';
import type { OrderRequest, Position, Quote } from '../core/types.js';

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

export interface GuardrailVerdict {
  allowed: boolean;
  reason?: string;
}

export function checkOrder(
  order: OrderRequest,
  ctx: GuardrailContext,
  limits: GuardrailLimits,
): GuardrailVerdict {
  if (ctx.ordersThisCycle >= limits.maxOrdersPerCycle) {
    return { allowed: false, reason: `사이클당 최대 주문 수(${limits.maxOrdersPerCycle}건) 초과` };
  }

  const q = ctx.quotes.get(order.symbol);
  if (!q) return { allowed: false, reason: `시세 없음: ${order.symbol}` };

  if (!Number.isInteger(order.quantity) || order.quantity <= 0) {
    return { allowed: false, reason: `유효하지 않은 수량: ${order.quantity}` };
  }

  if (order.side === 'SELL') return { allowed: true }; // 매도는 항상 허용(손절 경로). 수량 검증은 브로커가 수행. 단, 사이클 주문 수와 수량 유효성 검증은 위에서 이미 적용됨

  if (ctx.ordersToday >= limits.maxOrdersPerDay) {
    return { allowed: false, reason: `일일 최대 주문 수(${limits.maxOrdersPerDay}건) 초과` };
  }

  if (ctx.lastSellAt) {
    const elapsedMin = (ctx.now.getTime() - new Date(ctx.lastSellAt).getTime()) / 60_000;
    if (elapsedMin < limits.reentryCooldownMin) {
      return { allowed: false, reason: `재진입 쿨다운 — 매도 후 ${limits.reentryCooldownMin}분 경과 전 (${Math.round(elapsedMin)}분 경과)` };
    }
  }

  if (ctx.dailyPnlPct <= -limits.dailyLossLimitPct) {
    return {
      allowed: false,
      reason: `일일 손실 한도(-${limits.dailyLossLimitPct}%) 도달 — 당일 신규 매수 정지`,
    };
  }

  const px = order.limitPrice ?? q.ask;
  if (!Number.isFinite(px) || px <= 0) {
    return { allowed: false, reason: `유효하지 않은 가격: ${px}` };
  }
  const orderValue = px * order.quantity;

  const maxOrderValue = (ctx.equity * limits.maxOrderPct) / 100;
  if (orderValue > maxOrderValue) {
    return {
      allowed: false,
      reason: `주문 금액 ${Math.round(orderValue).toLocaleString()}원이 1회 상한(총자산의 ${limits.maxOrderPct}% = ${Math.round(maxOrderValue).toLocaleString()}원) 초과`,
    };
  }

  const held = ctx.positions.find(p => p.symbol === order.symbol);
  const heldValue = held ? held.quantity * q.price : 0; // 보유분은 현재가로 평가, 신규 주문은 ask/지정가 기준 — 의도된 비대칭
  const maxPositionValue = (ctx.equity * limits.maxPositionPct) / 100;
  if (heldValue + orderValue > maxPositionValue) {
    return {
      allowed: false,
      reason: `종목 비중 상한(총자산의 ${limits.maxPositionPct}%) 초과 — 보유 ${Math.round(heldValue).toLocaleString()}원 + 신규 ${Math.round(orderValue).toLocaleString()}원`,
    };
  }

  const maxExposure = (ctx.equity * limits.maxTotalExposurePct) / 100;
  if (ctx.totalPositionValue + orderValue > maxExposure) {
    return {
      allowed: false,
      reason: `총 노출 상한(총자산의 ${limits.maxTotalExposurePct}%) 초과 — 현재 ${Math.round(ctx.totalPositionValue).toLocaleString()}원 + 신규 ${Math.round(orderValue).toLocaleString()}원`,
    };
  }

  return { allowed: true };
}
