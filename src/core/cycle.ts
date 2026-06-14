import type { EventEmitter } from 'node:events';
import type { AppConfig } from './config.js';
import type { PaperBroker } from '../broker/paper.js';
import type { BrokerAdapter } from '../broker/adapter.js';
import type { Store, TradeRow, DecisionRow } from './store.js';
import type { BrainOutput, Decision, IndicatorRow, Position, Quote, Reflection, UniverseEntry } from './types.js';
import { toOrder } from './orders.js';
import { checkOrder } from '../guardrails/index.js';
import { buildPrompt } from '../brain/prompt.js';
import { buildReflection, formatReflections, REFLECTION_LIMIT } from '../brain/reflection.js';
import { computeIndicatorRow } from './indicators.js';
import type { SkepticInput, SkepticVerdict } from '../brain/skeptic.js';

export interface CycleDeps {
  config: AppConfig;
  universe: UniverseEntry[];
  adapter: BrokerAdapter & { advance?: () => void };
  broker: PaperBroker;
  store: Store;
  strategyDocs: string;
  brain: (prompt: string) => Promise<BrainOutput>;
  events?: EventEmitter;
  // 캐치된 에러 메시지에서 마스킹할 시크릿 목록 (main.ts가 주입). 미주입 시 빈 배열.
  secrets?: string[];
  // BUY 스켑틱 게이트 함수 (config.skepticGate=true일 때만 main.ts가 주입). 미주입 시 게이트 비활성.
  skeptic?: (input: SkepticInput) => Promise<SkepticVerdict>;
}

export interface CycleResult { skipped: boolean; reason?: string }

const kstDate = (d: Date) => d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
const nowISO = () => new Date().toISOString();
const errMsg = (e: unknown) => e instanceof Error ? e.message : String(e);

// 각 시크릿(6자 이상)을 '[REDACTED]'로 교체 (connection-test.ts의 scrub과 동일 동작).
function scrub(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s.length >= 6) out = out.replaceAll(s, '[REDACTED]');
  }
  return out;
}

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
    // 캐치된 에러는 브로커 HTTP 응답(키가 URL/본문에 echo될 수 있음)을 담을 수 있어 스크럽한다.
    // 정상 판단의 reasoning(Claude 생성, 시크릿 미노출)·rejectReason(가드레일/브로커의 숫자·한도)은 스크럽 불필요.
    store.recordDecision(errorRow(`시세 조회 실패: ${scrub(errMsg(err), deps.secrets ?? [])}`));
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
  // 회고: onTick이 포지션을 줄이기 전에 스냅샷을 떠 두고, 체결된 매도의 thesis를 채점한다.
  const prePos = new Map(broker.positions.map(p => [p.symbol, p]));
  const tickFills = broker.onTick(quotes);
  const tickTrades: TradeRow[] = tickFills.map(({ order, result }) => ({
    ts: nowISO(), side: order.side, symbol: order.symbol, name: order.name,
    quantity: order.quantity, price: result.fillPrice, fee: result.fee, tax: result.tax,
  }));
  const newReflections: Reflection[] = [];
  if (config.reflection) {
    for (const { order, result } of tickFills) {
      if (order.side !== 'SELL') continue;
      const refl = reflectionFor(prePos.get(order.symbol), result.fillPrice);
      if (refl) newReflections.push(refl);
    }
  }

  const equity = broker.equity(quotes);
  const dailyPnlPct = dayOpenEquity > 0 ? ((equity - dayOpenEquity) / dayOpenEquity) * 100 : 0;
  const ordersTodayKey = `ordersToday:${today}`;
  let ordersToday = Number(store.getKV(ordersTodayKey) ?? '0');

  // 지표 필수 fail-safe — lastPrice-only 매매는 검증된 우위가 없고 수수료만 까먹으므로 기본 차단(requireIndicators=true).
  // 지표가 비면 두뇌 호출·주문 제출을 모두 건너뛰고 SKIPPED 행만 남긴다.
  // finishCycle은 그대로 호출해 스냅샷/벤치마크/onTick 체결은 유지한다.
  if (config.requireIndicators && indicators.length === 0) {
    const skipRow: DecisionRow = {
      ts: nowISO(), action: 'HOLD', symbol: null, name: null, quantity: null, orderType: null,
      limitPrice: null,
      reasoning: '지표 데이터 없음 — requireIndicators=true이므로 매매를 건너뜁니다. 어댑터가 getCandles를 구현하거나 config requireIndicators=false로 변경하세요.',
      status: 'SKIPPED', rejectReason: null, marketView: '', thesis: null,
    };
    finishCycle(deps, quotes, dailyPnlPct, tickTrades, [skipRow], ordersToday, ordersTodayKey, sellTimesFrom(tickTrades), [], [], newReflections);
    return { skipped: true, reason: 'no-indicators' };
  }

  // 5) 두뇌
  let output: BrainOutput;
  try {
    output = await deps.brain(buildPrompt({
      strategyDocs: deps.strategyDocs,
      cash: broker.cash, equity, dailyPnlPct,
      positions: broker.positions, quotes: quoteList, indicators,
      recentDecisions: store.getDecisions(20).map(d =>
        `${d.ts} ${d.action} ${d.name ?? ''} ${d.quantity ?? ''} [${d.status}] — ${d.reasoning}`.trim()),
      reflections: config.reflection ? formatReflections(loadReflections(store).slice(-REFLECTION_LIMIT).reverse()) : [],
      limits: config.guardrails, ordersToday,
    }));
  } catch (err) {
    finishCycle(deps, quotes, dailyPnlPct, tickTrades, [errorRow(`브레인 호출 실패: ${scrub(errMsg(err), deps.secrets ?? [])}`)], ordersToday, ordersTodayKey, sellTimesFrom(tickTrades), [], [], newReflections);
    return { skipped: true, reason: String(err) };
  }

  // 6) 판단 실행 — 기록 행은 모아서 원자 저장
  const trades: TradeRow[] = [...tickTrades];
  const decisionRows: DecisionRow[] = [];
  const sellTimes: Array<[string, string]> = sellTimesFrom(tickTrades);
  const pendingTheses: Array<[string, string]> = [];
  const clearThesisKeys: string[] = []; // 직접 체결된 매수가 덮어쓴 stale pendingThesis 키 정리용
  let ordersThisCycle = 0;

  for (const decision of output.decisions) {
    if (decision.action === 'HOLD') { decisionRows.push(toRow(decision, output.marketView, 'HOLD', null)); continue; }
    const order = toOrder(decision, quotes);
    if (!order) {
      decisionRows.push(toRow(decision, output.marketView, 'REJECTED', '주문 필드 불완전 (symbol/quantity/orderType 누락)'));
      continue;
    }

    const now = new Date();
    const heldPos = order.side === 'SELL' ? broker.positions.find(p => p.symbol === order.symbol) : undefined;
    // openedAt이 손상돼 NaN이면 null로 — 그래야 가드가 minHold 판정을 건너뛴다(NaN<min은 false라 조용히 우회되는 것을 방지).
    const heldMinutes = ((): number | null => {
      if (!heldPos?.openedAt) return null;
      const t = new Date(heldPos.openedAt).getTime();
      return Number.isFinite(t) ? Math.max(0, (now.getTime() - t) / 60_000) : null;
    })();
    const verdict = checkOrder(order, {
      equity, positions: broker.positions, quotes, dailyPnlPct, ordersThisCycle,
      ordersToday, lastSellAt: store.getKV(`lastSell:${order.symbol}`), now, heldMinutes,
      totalPositionValue: broker.positions.reduce((s, p) => s + (quotes.get(p.symbol)?.price ?? p.avgPrice) * p.quantity, 0),
    }, config.guardrails);
    if (!verdict.allowed) {
      decisionRows.push(toRow(decision, output.marketView, 'REJECTED', verdict.reason ?? '가드레일 거부', order.name));
      continue;
    }

    // 스켑틱 게이트: 돌이킬 수 없는 BUY만 2차 반박 검토. refute면 거부(매도/관망은 면제).
    if (decision.action === 'BUY' && decision.thesis && config.skepticGate && deps.skeptic) {
      const skepticVerdict = await deps.skeptic({
        symbol: order.symbol, name: order.name, quantity: order.quantity,
        reasoning: decision.reasoning, thesis: decision.thesis, marketView: output.marketView,
        quote: quotes.get(order.symbol), indicator: indicators.find(r => r.symbol === order.symbol),
        strategyDocs: deps.strategyDocs,
      });
      if (skepticVerdict.refute) {
        decisionRows.push(toRow(decision, output.marketView, 'REJECTED', `스켑틱 게이트: ${skepticVerdict.reason}`, order.name));
        continue;
      }
    }

    // 회고: 매도 체결 직전의 포지션 스냅샷 (체결 시 broker가 줄이거나 삭제하므로 미리 보존)
    const preSale = order.side === 'SELL' ? broker.positions.find(p => p.symbol === order.symbol) : undefined;
    const result = broker.submit(order, quotes);
    // ordersToday는 '오늘 제출한 주문 수' — PENDING 시점에 1회 계상, 이후 틱 체결 시 재계상 없음
    if (result.status === 'FILLED') {
      ordersThisCycle++; ordersToday++;
      trades.push({ ts: nowISO(), side: order.side, symbol: order.symbol, name: order.name,
        quantity: order.quantity, price: result.fillPrice, fee: result.fee, tax: result.tax });
      if (decision.action === 'BUY' && decision.thesis) {
        broker.setThesis(order.symbol, decision.thesis);
        // 직접 체결로 thesis를 새로 지정 → 이전 사이클의 미체결 지정가가 남긴 stale 키 제거
        clearThesisKeys.push(`pendingThesis:${order.symbol}`);
      }
      if (decision.action === 'SELL') {
        sellTimes.push([order.symbol, nowISO()]);
        if (config.reflection) {
          const refl = reflectionFor(preSale, result.fillPrice);
          if (refl) newReflections.push(refl);
        }
      }
      decisionRows.push(toRow(decision, output.marketView, 'FILLED', null, order.name));
    } else if (result.status === 'PENDING') {
      ordersThisCycle++; ordersToday++;
      if (decision.action === 'BUY' && decision.thesis) {
        // PENDING 매수의 thesis는 체결 시점에 적용하기 위해 KV에 보관 (onTick 체결 후 setThesis)
        // finishCycle의 atomic 블록 안에서 쓰여 broker KV와 함께 원자 저장된다
        pendingTheses.push([`pendingThesis:${order.symbol}`, JSON.stringify(decision.thesis)]);
      }
      decisionRows.push(toRow(decision, output.marketView, 'PENDING', null, order.name));
    } else {
      decisionRows.push(toRow(decision, output.marketView, 'REJECTED', result.reason, order.name));
    }
  }

  // 이번 틱에 체결된 매수에 보관된 thesis 적용
  for (const t of tickTrades) {
    if (t.side === 'BUY') {
      const key = `pendingThesis:${t.symbol}`;
      const pt = store.getKV(key);
      if (pt) {
        try {
          broker.setThesis(t.symbol, JSON.parse(pt) as import('./types.js').Thesis);
        } catch {
          // corrupted entry dropped
          store.deleteKV(key);
          continue;
        }
        store.deleteKV(key);
      }
    }
  }

  finishCycle(deps, quotes, dailyPnlPct, trades, decisionRows, ordersToday, ordersTodayKey, sellTimes, pendingTheses, clearThesisKeys, newReflections);
  return { skipped: false };
}

function sellTimesFrom(tickTrades: TradeRow[]): Array<[string, string]> {
  return tickTrades.filter(t => t.side === 'SELL').map(t => [t.symbol, t.ts]);
}

function reflectionFor(pre: Position | undefined, exitPrice: number): Reflection | null {
  return pre ? buildReflection(pre, exitPrice, new Date()) : null;
}

/** 프롬프트에 주입되기 전 회고 요소의 형태/유한성을 검증한다 (스키마 변동·손상 시 NaN PnL 주입 방지). */
function isReflection(x: unknown): x is Reflection {
  if (!x || typeof x !== 'object') return false;
  const r = x as Record<string, unknown>;
  return typeof r.symbol === 'string' && typeof r.name === 'string'
    && typeof r.why === 'string' && typeof r.target === 'string' && typeof r.stop === 'string'
    && typeof r.pnlPct === 'number' && Number.isFinite(r.pnlPct)
    && typeof r.heldHours === 'number' && Number.isFinite(r.heldHours)
    && (r.result === 'WIN' || r.result === 'LOSS');
}

/** KV에 보관된 회고 목록(오래된→최신)을 읽는다. 손상/형식오류 요소는 거른다. */
function loadReflections(store: Store): Reflection[] {
  const raw = store.getKV('reflections');
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter(isReflection) : [];
  } catch {
    return [];
  }
}

async function collectIndicators(adapter: BrokerAdapter, universe: UniverseEntry[]): Promise<IndicatorRow[]> {
  if (!adapter.getCandles) return [];
  const out: IndicatorRow[] = [];
  for (const u of universe) {
    try {
      const c = await adapter.getCandles(u.symbol, 'day', 20);
      const row = computeIndicatorRow(c);
      if (row) out.push({ symbol: u.symbol, ...row });
    } catch { /* 지표는 best-effort — 실패한 종목만 생략, 사이클은 계속 */ }
  }
  return out;
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
  // 손상된 baseline은 benchmark 표시만 포기 — 사이클은 계속 (fail-safe)
  let baseline: Record<string, number>;
  try {
    baseline = JSON.parse(baselineRaw) as Record<string, number>;
  } catch {
    return { value: null };
  }
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
  pendingTheses: Array<[string, string]> = [],
  clearThesisKeys: string[] = [],
  newReflections: Reflection[] = [],
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
    for (const [key, val] of pendingTheses) store.setKV(key, val);
    for (const key of clearThesisKeys) store.deleteKV(key);
    if (newReflections.length > 0) {
      const merged = [...loadReflections(store), ...newReflections].slice(-REFLECTION_LIMIT);
      store.setKV('reflections', JSON.stringify(merged));
    }
  });
  deps.events?.emit('update');
}
