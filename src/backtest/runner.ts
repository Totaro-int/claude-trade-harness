import type { AppConfig } from '../core/config.js';
import type { BrainOutput, Candle, Decision, IndicatorRow, OrderRequest, Quote, UniverseEntry } from '../core/types.js';
import { PaperBroker } from '../broker/paper.js';
import { checkOrder } from '../guardrails/index.js';
import { buildPrompt } from '../brain/prompt.js';

export interface BacktestInput {
  candlesBySymbol: Map<string, Candle[]>;  // 종목별 캔들, 시간순, 인덱스 기준 동일 길이/정렬
  universe: UniverseEntry[];
  config: AppConfig;
  strategyDocs: string;
  brain: (prompt: string) => Promise<BrainOutput>;  // 주입 — CLI는 실제 runBrain, 테스트는 스텁
  startIndex?: number;   // 매매 시작 막대 (기본 20, ma20에 데이터가 있도록)
  onBar?: (i: number, equity: number, benchmark: number) => void;
}

export interface BacktestReport {
  bars: number;
  trades: number;
  feesTotal: number;        // 수수료 + 세금
  initialCash: number;
  finalEquity: number;
  totalReturnPct: number;
  benchmarkReturnPct: number;   // 유니버스 동일가중 buy-and-hold ([startIndex, end])
  excessPct: number;            // totalReturnPct - benchmarkReturnPct (정직한 점수판)
  maxDrawdownPct: number;       // equity 곡선 peak-to-trough
  equityCurve: Array<{ i: number; equity: number; benchmark: number }>;
}

/** cycle.ts collectIndicators와 동일한 수식 — candles[0..i]에서 ma5/ma20/change5d 산출 */
function computeIndicators(candlesBySymbol: Map<string, Candle[]>, universe: UniverseEntry[], i: number): IndicatorRow[] {
  const out: IndicatorRow[] = [];
  for (const u of universe) {
    const candles = candlesBySymbol.get(u.symbol);
    if (!candles) continue;
    const closes = candles.slice(0, i + 1).map(c => c.close);
    if (closes.length < 6) continue;
    const ma = (n: number) => Math.round(closes.slice(-n).reduce((a, b) => a + b, 0) / n);
    out.push({
      symbol: u.symbol,
      ma5: ma(5),
      ma20: closes.length >= 20 ? ma(20) : undefined,
      change5d: Number(((closes.at(-1)! / closes.at(-6)! - 1) * 100).toFixed(2)),
    });
  }
  return out;
}

/** cycle.ts toOrder와 동일 */
function toOrder(d: Decision, quotes: Map<string, Quote>): OrderRequest | null {
  if (!d.symbol || d.quantity == null || d.quantity <= 0 || !d.orderType) return null;
  if (d.orderType === 'LIMIT' && !d.limitPrice) return null;
  const name = quotes.get(d.symbol)?.name ?? d.symbol;
  return { side: d.action as 'BUY' | 'SELL', symbol: d.symbol, name, quantity: d.quantity, orderType: d.orderType, limitPrice: d.limitPrice };
}

export async function runBacktest(input: BacktestInput): Promise<BacktestReport> {
  const { candlesBySymbol, universe, config, strategyDocs, brain, onBar } = input;

  // ── 검증 ──
  const arrays = [...candlesBySymbol.values()];
  if (arrays.length === 0) throw new Error('백테스트할 캔들이 없습니다');
  if (arrays.some(a => a.length === 0)) throw new Error('빈 캔들 배열이 있습니다');
  const N = arrays[0]!.length;
  if (arrays.some(a => a.length !== N)) {
    throw new Error('모든 종목의 캔들 길이가 같아야 합니다 (인덱스 정렬 가정)');
  }
  const start = input.startIndex ?? 20;
  if (N <= start) throw new Error(`캔들이 부족합니다 (필요 > ${start}개, 보유 ${N}개)`);

  const nameOf = new Map(universe.map(u => [u.symbol, u.name]));
  const symbolsAtBar = (i: number): string[] =>
    [...candlesBySymbol.entries()].filter(([, c]) => c[i] != null).map(([s]) => s);

  // 막대 i의 시세 Map (bid==ask==close → PaperBroker가 half-spread 적용, 현실적)
  function quotesAt(i: number): Map<string, Quote> {
    const m = new Map<string, Quote>();
    for (const sym of symbolsAtBar(i)) {
      const c = candlesBySymbol.get(sym)![i]!;
      const prev = i > 0 ? candlesBySymbol.get(sym)![i - 1]?.close : undefined;
      const changeRate = prev ? (c.close / prev - 1) * 100 : 0;
      m.set(sym, {
        symbol: sym, name: nameOf.get(sym) ?? sym,
        price: c.close, bid: c.close, ask: c.close, changeRate, volume: c.volume,
      });
    }
    return m;
  }

  const broker = new PaperBroker({
    initialCash: config.initialCash,
    feeRate: config.feeRate, taxRate: config.taxRate, halfSpreadPct: config.halfSpreadPct,
  });
  const initialCash = config.initialCash;

  // 벤치마크 기준선 = 막대 start의 종가
  const baseSymbols = symbolsAtBar(start);
  const baseline = new Map<string, number>(baseSymbols.map(s => [s, candlesBySymbol.get(s)![start]!.close]));
  function benchmarkAt(i: number): number {
    const ratios: number[] = [];
    for (const s of symbolsAtBar(i)) {
      const p0 = baseline.get(s);
      if (p0 != null && p0 > 0) ratios.push(candlesBySymbol.get(s)![i]!.close / p0);
    }
    if (ratios.length === 0) return initialCash;
    return initialCash * (ratios.reduce((a, b) => a + b, 0) / ratios.length);
  }

  const equityCurve: BacktestReport['equityCurve'] = [];
  let trades = 0;
  let feesTotal = 0;
  let peak = -Infinity;
  let maxDrawdownPct = 0;
  let prevEquity = initialCash;
  let lastQuotes = quotesAt(start);

  for (let i = start; i < N; i++) {
    const quotes = quotesAt(i);
    lastQuotes = quotes;

    // 1) 대기 지정가 체결 먼저
    const fills = broker.onTick(quotes);
    for (const { result } of fills) {
      trades++;
      feesTotal += (result.fee ?? 0) + (result.tax ?? 0);
    }

    // 2) 지표
    const indicators = computeIndicators(candlesBySymbol, universe, i);

    // 3) equity / dailyPnl (전 막대 대비)
    const equityBefore = broker.equity(quotes);
    const dailyPnlPct = prevEquity > 0 ? ((equityBefore - prevEquity) / prevEquity) * 100 : 0;

    // 일봉 1막대 = 1일 → ordersToday는 막대마다 리셋. 60분 쿨다운은 일봉 단위에서 의미 없으므로 lastSellAt:null.
    let ordersToday = 0;
    let ordersThisCycle = 0;

    // 4) 두뇌 (주입됨 — 백테스트는 claude를 직접 호출하지 않음)
    const output = await brain(buildPrompt({
      strategyDocs,
      cash: broker.cash, equity: equityBefore, dailyPnlPct,
      positions: broker.positions, quotes: [...quotes.values()], indicators,
      recentDecisions: [],
      limits: config.guardrails, ordersToday,
    }));

    // 5) 판단 실행
    const now = new Date(i * 86_400_000);
    for (const decision of output.decisions) {
      if (decision.action === 'HOLD') continue;
      const order = toOrder(decision, quotes);
      if (!order) continue;

      const verdict = checkOrder(order, {
        equity: equityBefore, positions: broker.positions, quotes, dailyPnlPct,
        ordersThisCycle, ordersToday, lastSellAt: null, now,
        totalPositionValue: broker.positions.reduce((s, p) => s + (quotes.get(p.symbol)?.price ?? p.avgPrice) * p.quantity, 0),
      }, config.guardrails);
      if (!verdict.allowed) continue;

      const result = broker.submit(order, quotes);
      if (result.status === 'FILLED') {
        ordersThisCycle++; ordersToday++;
        trades++;
        feesTotal += (result.fee ?? 0) + (result.tax ?? 0);
        if (decision.action === 'BUY' && decision.thesis) broker.setThesis(order.symbol, decision.thesis);
      } else if (result.status === 'PENDING') {
        ordersThisCycle++; ordersToday++;
        // 미체결 지정가는 큐에 유지 — 다음 막대 onTick에서 체결 시도
      }
    }

    // 6) 기록
    const equity = broker.equity(quotes);
    const benchmark = benchmarkAt(i);
    equityCurve.push({ i, equity, benchmark });

    if (equity > peak) peak = equity;
    if (peak > 0) {
      const dd = ((peak - equity) / peak) * 100;
      if (dd > maxDrawdownPct) maxDrawdownPct = dd;
    }

    prevEquity = equity;
    onBar?.(i, equity, benchmark);
  }

  const finalEquity = broker.equity(lastQuotes);
  const totalReturnPct = ((finalEquity / initialCash) - 1) * 100;
  const benchmarkReturnPct = ((benchmarkAt(N - 1) / initialCash) - 1) * 100;

  return {
    bars: equityCurve.length,
    trades,
    feesTotal,
    initialCash,
    finalEquity,
    totalReturnPct,
    benchmarkReturnPct,
    excessPct: totalReturnPct - benchmarkReturnPct,
    maxDrawdownPct,
    equityCurve,
  };
}
