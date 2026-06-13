import type { FillResult, FilledResult, OrderRequest, Position, Quote, Thesis } from '../core/types.js';

export interface PendingOrder extends OrderRequest {
  id: number;
  limitPrice: number; // PENDING은 항상 LIMIT
}

export interface BrokerRates { feeRate: number; taxRate: number; halfSpreadPct: number }

interface BrokerState {
  cash: number;
  positions: Position[];
  pending: PendingOrder[];
  nextOrderId: number;
}

export class PaperBroker {
  #cash: number;
  #positions = new Map<string, Position>();
  #pending: PendingOrder[] = [];
  #nextOrderId = 1;
  readonly #rates: BrokerRates;

  constructor(opts: { initialCash: number } & BrokerRates) {
    this.#cash = opts.initialCash;
    this.#rates = { feeRate: opts.feeRate, taxRate: opts.taxRate, halfSpreadPct: opts.halfSpreadPct };
  }

  get cash(): number { return this.#cash; }
  get positions(): Position[] { return [...this.#positions.values()].map(p => ({ ...p })); }
  get pendingOrders(): PendingOrder[] { return this.#pending.map(o => ({ ...o })); }

  submit(order: OrderRequest, quotes: Map<string, Quote>): FillResult {
    const q = quotes.get(order.symbol);
    if (!q) return { status: 'REJECTED', reason: `시세 없음: ${order.symbol}` };
    if (order.quantity <= 0 || !Number.isInteger(order.quantity)) {
      return { status: 'REJECTED', reason: `잘못된 수량: ${order.quantity}` };
    }
    if (order.orderType === 'MARKET') {
      return this.#fill(order, this.#execPrice(order.side, q));
    }
    if (!order.limitPrice || order.limitPrice <= 0) {
      return { status: 'REJECTED', reason: '지정가 누락' };
    }
    // 즉시 체결 가능한 지정가는 바로 체결
    if (order.side === 'BUY' && q.ask <= order.limitPrice) return this.#fill(order, q.ask);
    if (order.side === 'SELL' && q.bid >= order.limitPrice) return this.#fill(order, q.bid);
    this.#pending.push({ ...order, id: this.#nextOrderId++, limitPrice: order.limitPrice });
    return { status: 'PENDING' };
  }

  /**
   * 새 시세 틱에서 대기 지정가 주문 체결 시도. 체결된 주문 목록만 반환.
   * - 트리거 기준: 현재가(q.price)
   * - 체결가: 지정가(order.limitPrice)
   * - 체결 실패(현금 부족 등) 시 해당 주문은 큐에 유지됨 (소실 금지)
   */
  onTick(quotes: Map<string, Quote>): Array<{ order: PendingOrder; result: FilledResult }> {
    const fills: Array<{ order: PendingOrder; result: FilledResult }> = [];
    this.#pending = this.#pending.filter(order => {
      const q = quotes.get(order.symbol);
      if (!q) return true;
      const crossed = order.side === 'BUY' ? q.price <= order.limitPrice : q.price >= order.limitPrice;
      if (!crossed) return true;
      const result = this.#fill(order, order.limitPrice);
      if (result.status !== 'FILLED') return true; // 체결 실패(현금 부족 등) → 큐 유지
      fills.push({ order, result });
      return false;
    });
    return fills;
  }

  /** 장 마감 시 미체결 지정가 전부 취소. 취소된 주문 반환(방어적 복사). */
  cancelAllPending(): PendingOrder[] {
    const canceled = this.#pending.map(o => ({ ...o }));
    this.#pending = [];
    return canceled;
  }

  equity(quotes: Map<string, Quote>): number {
    let total = this.#cash;
    for (const p of this.#positions.values()) {
      // 시세 없는 종목은 평단가로 평가(보수적 폴백)
      total += (quotes.get(p.symbol)?.price ?? p.avgPrice) * p.quantity;
    }
    return total;
  }

  /** bid==ask(스프레드 정보 없음)이면 현실적 half-spread를 적용한 체결가 산출 */
  #execPrice(side: 'BUY' | 'SELL', q: Quote): number {
    if (q.bid !== q.ask) return side === 'BUY' ? q.ask : q.bid;
    // 저가주에서 반올림이 0이 되어 슬리피지가 사라지는 것 방지: halfSpreadPct>0이면 최소 1원
    const raw = q.price * this.#rates.halfSpreadPct;
    const spread = raw > 0 ? Math.max(1, Math.round(raw)) : 0;
    return side === 'BUY' ? q.price + spread : q.price - spread;
  }

  /**
   * 포지션에 thesis를 저장한다.
   * @returns 포지션이 존재하면 `true`, 포지션 없음(no-op)이면 `false`
   */
  setThesis(symbol: string, thesis: Thesis): boolean {
    const pos = this.#positions.get(symbol);
    if (!pos) return false;
    this.#positions.set(symbol, { ...pos, thesis, openedAt: pos.openedAt ?? new Date().toISOString() });
    return true;
  }

  #fill(order: OrderRequest, px: number): FillResult {
    const value = px * order.quantity;
    const fee = Math.round(value * this.#rates.feeRate);
    if (order.side === 'BUY') {
      if (value + fee > this.#cash) {
        return { status: 'REJECTED', reason: `현금 부족 (필요 ${value + fee}, 보유 ${Math.floor(this.#cash)})` };
      }
      this.#cash -= value + fee;
      this.#cash = Math.round(this.#cash);
      const pos = this.#positions.get(order.symbol);
      if (pos) {
        // avgPrice: 수수료 제외 주당 취득단가(가중평균)
        this.#positions.set(order.symbol, {
          ...pos,
          avgPrice: Math.round((pos.avgPrice * pos.quantity + value) / (pos.quantity + order.quantity)),
          quantity: pos.quantity + order.quantity,
        });
      } else {
        this.#positions.set(order.symbol, {
          symbol: order.symbol, name: order.name, quantity: order.quantity, avgPrice: px,
          openedAt: new Date().toISOString(),
        });
      }
      return { status: 'FILLED', fillPrice: px, fee, tax: 0 };
    }
    // SELL
    const pos = this.#positions.get(order.symbol);
    if (!pos || pos.quantity < order.quantity) {
      return { status: 'REJECTED', reason: `보유량 부족 (보유 ${pos?.quantity ?? 0}, 요청 ${order.quantity})` };
    }
    const tax = Math.round(value * this.#rates.taxRate);
    this.#cash += value - fee - tax;
    this.#cash = Math.round(this.#cash);
    if (pos.quantity === order.quantity) {
      this.#positions.delete(order.symbol);
    } else {
      this.#positions.set(order.symbol, { ...pos, quantity: pos.quantity - order.quantity });
    }
    return { status: 'FILLED', fillPrice: px, fee, tax };
  }

  toJSON(): BrokerState {
    return {
      cash: this.#cash,
      positions: this.positions,
      pending: this.pendingOrders,
      nextOrderId: this.#nextOrderId,
    };
  }

  static fromJSON(state: BrokerState, rates: BrokerRates): PaperBroker {
    if (!Number.isFinite(state.cash) || state.cash < 0) throw new Error(`복원 실패: 잘못된 cash 값 (${state.cash})`);
    if (!Number.isInteger(state.nextOrderId) || state.nextOrderId < 1) throw new Error(`복원 실패: 잘못된 nextOrderId (${state.nextOrderId})`);
    const b = new PaperBroker({ initialCash: state.cash, ...rates });
    for (const p of state.positions) b.#positions.set(p.symbol, { ...p });
    b.#pending = state.pending.map(o => ({ ...o }));
    b.#nextOrderId = state.nextOrderId;
    return b;
  }
}
