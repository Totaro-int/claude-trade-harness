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
  /** 전 종목 보유 평가액 합 = Σ(quantity × 현재가). 호출자가 정확히 계산해 전달해야 함 — 0을 넣으면 총노출 가드가 무력화된다. */
  totalPositionValue: number;
  /** 이 주문 종목을 보유한 시간(분). minHoldMin 가드용. null/미지정이면 minHold 판정을 건너뛴다(일봉 백테스트 등). */
  heldMinutes?: number | null;
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

  // SELL은 일일상한/재진입 쿨다운에서 면제 — 손절 경로를 항상 열어 두기 위함. maxOrdersPerCycle과 수량 유효성 검증은 위에서 이미 적용됨.
  if (order.side === 'SELL') {
    // 회전율 억제: 최소 보유시간 미달이면서 '이익' 실현인 매도만 거부. 평가손(손절) 매도는 항상 허용.
    if (limits.minHoldMin > 0 && ctx.heldMinutes != null && ctx.heldMinutes < limits.minHoldMin) {
      const held = ctx.positions.find(p => p.symbol === order.symbol);
      const pnlPct = held && held.avgPrice > 0 ? (q.price / held.avgPrice - 1) * 100 : 0;
      if (pnlPct > 0) {
        return {
          allowed: false,
          reason: `최소 보유시간 미달 (${Math.round(ctx.heldMinutes)}/${limits.minHoldMin}분) — 이익 실현 보류 (손절은 허용)`,
        };
      }
    }
    return { allowed: true };
  }

  if (ctx.ordersToday >= limits.maxOrdersPerDay) {
    return { allowed: false, reason: `일일 최대 주문 수(${limits.maxOrdersPerDay}건) 초과` };
  }

  if (ctx.lastSellAt) {
    const parsed = new Date(ctx.lastSellAt).getTime();
    if (!Number.isFinite(parsed)) {
      // fail-safe: 판정 불가 시 거부 (불확실하면 거래하지 않는다)
      return { allowed: false, reason: `lastSellAt 값이 유효하지 않음: ${ctx.lastSellAt}` };
    }
    // 음수 경과(클럭 스큐/미래 타임스탬프)는 쿨다운 이내로 취급 — 안전한 방향
    const elapsedMin = (ctx.now.getTime() - parsed) / 60_000;
    if (elapsedMin < limits.reentryCooldownMin) {
      return { allowed: false, reason: `재진입 쿨다운 — 매도 후 ${limits.reentryCooldownMin}분 경과 전 (${Math.max(0, Math.round(elapsedMin))}분 경과)` };
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
