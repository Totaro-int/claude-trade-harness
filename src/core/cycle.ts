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
    store.recordDecision(errorRow(`시세 조회 실패: ${String(err)}`));
    deps.events?.emit('update');
    return { skipped: true, reason: String(err) };
  }
  const quotes = new Map<string, Quote>(quoteList.map(q => [q.symbol, q]));

  // 2) 지표 (어댑터가 캔들 지원 시)
  const indicators = await collectIndicators(adapter, universe);

  // 3) dayOpenEquity — 시간창 안에서만 현재 equity로 초기화. 창 밖 첫 실행이면 마지막 스냅샷 폴백
  const today = kstDate(new Date());
  const dayKey = `dayOpenEquity:${today}`;
  if (store.getKV(dayKey) === null) {
    const fallback = store.getSnapshots(1)[0]?.equity ?? broker.equity(quotes);
    const v = inDayOpenWindow(new Date()) ? broker.equity(quotes) : fallback;
    store.setKV(dayKey, String(v));
  }
  const dayOpenEquity = Number(store.getKV(dayKey));

  // 4) 대기 지정가 체결 — 기록은 사이클 끝에 원자 저장
  const tickFills = broker.onTick(quotes);
  const tickTrades: TradeRow[] = tickFills.map(({ order, result }) => ({
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
    finishCycle(deps, quotes, dailyPnlPct, tickTrades, [errorRow(`브레인 호출 실패: ${String(err)}`)], ordersToday, ordersTodayKey, sellTimesFrom(tickTrades));
    return { skipped: true, reason: String(err) };
  }

  // 6) 판단 실행 — 기록 행은 모아서 원자 저장
  const trades: TradeRow[] = [...tickTrades];
  const decisionRows: DecisionRow[] = [];
  const sellTimes: Array<[string, string]> = sellTimesFrom(tickTrades);
  let ordersThisCycle = 0;

  for (const decision of output.decisions) {
    if (decision.action === 'HOLD') { decisionRows.push(toRow(decision, output.marketView, 'HOLD', null)); continue; }
    const order = toOrder(decision, quotes);
    if (!order) {
      decisionRows.push(toRow(decision, output.marketView, 'REJECTED', '주문 필드 불완전 (symbol/quantity/orderType 누락)'));
      continue;
    }

    const verdict = checkOrder(order, {
      equity, positions: broker.positions, quotes, dailyPnlPct, ordersThisCycle,
      ordersToday, lastSellAt: store.getKV(`lastSell:${order.symbol}`), now: new Date(),
      totalPositionValue: broker.positions.reduce((s, p) => s + (quotes.get(p.symbol)?.price ?? p.avgPrice) * p.quantity, 0),
    }, config.guardrails);
    if (!verdict.allowed) {
      decisionRows.push(toRow(decision, output.marketView, 'REJECTED', verdict.reason!, order.name));
      continue;
    }

    const result = broker.submit(order, quotes);
    // ordersToday는 '오늘 제출한 주문 수' — PENDING 시점에 1회 계상, 이후 틱 체결 시 재계상 없음
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
        // PENDING 매수의 thesis는 체결 시점에 적용하기 위해 KV에 보관 (onTick 체결 후 setThesis)
        store.setKV(`pendingThesis:${order.symbol}`, JSON.stringify(decision.thesis));
      }
      decisionRows.push(toRow(decision, output.marketView, 'PENDING', null, order.name));
    } else {
      decisionRows.push(toRow(decision, output.marketView, 'REJECTED', result.reason!, order.name));
    }
  }

  // 이번 틱에 체결된 매수에 보관된 thesis 적용
  for (const t of tickTrades) {
    if (t.side === 'BUY') {
      const pt = store.getKV(`pendingThesis:${t.symbol}`);
      if (pt) { broker.setThesis(t.symbol, JSON.parse(pt) as import('./types.js').Thesis); store.deleteKV(`pendingThesis:${t.symbol}`); }
    }
  }

  finishCycle(deps, quotes, dailyPnlPct, trades, decisionRows, ordersToday, ordersTodayKey, sellTimes);
  return { skipped: false };
}

function sellTimesFrom(tickTrades: TradeRow[]): Array<[string, string]> {
  return tickTrades.filter(t => t.side === 'SELL').map(t => [t.symbol, t.ts]);
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
    } catch { /* 지표는 best-effort — 실패한 종목만 생략, 사이클은 계속 */ }
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

function computeBenchmark(store: Store, quotes: Map<string, Quote>, universe: UniverseEntry[], initialCash: number): { value: number | null; newBaseline?: Record<string, number> } {
  const baselineRaw = store.getKV('benchmarkBaseline');
  if (!baselineRaw) {
    const baseline: Record<string, number> = {};
    for (const u of universe) { const q = quotes.get(u.symbol); if (q) baseline[u.symbol] = q.price; }
    if (Object.keys(baseline).length === 0) return { value: null };
    return { value: initialCash, newBaseline: baseline };
  }
  const baseline = JSON.parse(baselineRaw) as Record<string, number>;
  const ratios = Object.entries(baseline)
    .map(([s, p0]) => { const q = quotes.get(s); return q ? q.price / p0 : null; })
    .filter((x): x is number => x !== null);
  if (ratios.length === 0) return { value: null };
  return { value: Math.round(initialCash * (ratios.reduce((a, b) => a + b, 0) / ratios.length)) };
}

function finishCycle(
  deps: CycleDeps, quotes: Map<string, Quote>, dailyPnlPct: number,
  trades: TradeRow[], decisionRows: DecisionRow[],
  ordersToday: number, ordersTodayKey: string, sellTimes: Array<[string, string]>,
): void {
  const { broker, store, universe, config } = deps;
  const equity = broker.equity(quotes);
  const { value: benchmark, newBaseline } = computeBenchmark(store, quotes, universe, config.initialCash);
  // 체결·판단·스냅샷·브로커 상태를 단일 트랜잭션으로 — 크래시 시 기록-상태 불일치 방지
  store.atomic(() => {
    for (const t of trades) store.recordTrade(t);
    for (const d of decisionRows) store.recordDecision(d);
    store.recordSnapshot({ ts: nowISO(), equity, cash: broker.cash, dailyPnlPct, benchmark });
    store.setKV('broker', JSON.stringify(broker.toJSON()));
    store.setKV('lastQuotes', JSON.stringify([...quotes.values()]));
    store.setKV(ordersTodayKey, String(ordersToday));
    for (const [sym, ts] of sellTimes) store.setKV(`lastSell:${sym}`, ts);
    if (newBaseline) store.setKV('benchmarkBaseline', JSON.stringify(newBaseline));
  });
  deps.events?.emit('update');
}
