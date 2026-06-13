import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { runCycle, type CycleDeps } from '../src/core/cycle.js';
import { PaperBroker } from '../src/broker/paper.js';
import { MockAdapter } from '../src/broker/mock.js';
import { Store } from '../src/core/store.js';
import { loadConfig } from '../src/core/config.js';
import type { BrainOutput } from '../src/core/types.js';

const SYM = '005930';
const universe = [
  { symbol: SYM, name: '삼성전자' },
  { symbol: '000660', name: 'SK하이닉스' },
];

function makeDeps(opts: {
  brain: (prompt: string) => Promise<BrainOutput>;
  presetPosition?: { symbol: string; quantity: number; avgPrice: number };
  secrets?: string[];
}): { deps: CycleDeps; broker: PaperBroker; store: Store } {
  const config = loadConfig('/nonexistent');
  const broker = new PaperBroker({
    initialCash: config.initialCash,
    feeRate: config.feeRate,
    taxRate: config.taxRate,
    halfSpreadPct: 0,
  });
  const store = new Store(':memory:');
  const adapter = new MockAdapter(universe, 42);

  if (opts.presetPosition) {
    const { symbol, quantity, avgPrice } = opts.presetPosition;
    // prime position via a MARKET buy at the preset avgPrice
    adapter.setPrice(symbol, avgPrice);
    const quotes = new Map(
      [{ symbol, name: symbol, price: avgPrice, bid: avgPrice, ask: avgPrice, changeRate: 0, volume: 0 }]
        .map(q => [q.symbol, q]),
    );
    broker.submit({ side: 'BUY', symbol, name: symbol, quantity, orderType: 'MARKET' }, quotes);
  }

  const deps: CycleDeps = {
    config,
    universe,
    adapter,
    broker,
    store,
    strategyDocs: '테스트 전략',
    brain: opts.brain,
    events: new EventEmitter(),
    secrets: opts.secrets,
  };
  return { deps, broker, store };
}

// ── ported tests ──────────────────────────────────────────────────────────────

describe('runCycle', () => {
  it('BUY 판단 → 가드레일 통과 → 체결 → 판단/체결/스냅샷 기록', async () => {
    const { deps } = makeDeps({
      brain: async () => ({
        marketView: '강세',
        decisions: [{
          action: 'BUY', symbol: SYM, quantity: 1, orderType: 'MARKET', reasoning: '테스트 매수',
          thesis: { why: 'w', target: '+5%', stop: '-2%', exitCondition: 'x' },
        }],
      }),
    });
    const result = await runCycle(deps);
    expect(result.skipped).toBe(false);
    expect(deps.broker.positions).toHaveLength(1);
    expect(deps.store.getTrades(10)).toHaveLength(1);
    const decisions = deps.store.getDecisions(10);
    expect(decisions[0].status).toBe('FILLED');
    expect(decisions[0].reasoning).toBe('테스트 매수');
    expect(deps.store.getSnapshots(10)).toHaveLength(1);
  });

  it('가드레일 위반 주문은 REJECTED로 기록되고 체결되지 않음', async () => {
    const { deps } = makeDeps({
      brain: async () => ({
        marketView: '과열',
        // 수량 9999주 → 1회 주문 금액 상한 초과
        decisions: [{
          action: 'BUY', symbol: SYM, quantity: 9999, orderType: 'MARKET', reasoning: '몰빵',
          thesis: { why: 'w', target: '+5%', stop: '-2%', exitCondition: 'x' },
        }],
      }),
    });
    await runCycle(deps);
    expect(deps.broker.positions).toHaveLength(0);
    expect(deps.store.getTrades(10)).toHaveLength(0);
    const d = deps.store.getDecisions(10)[0];
    expect(d.status).toBe('REJECTED');
    expect(d.rejectReason).toBeTruthy();
  });

  it('HOLD 판단은 주문 없이 기록만', async () => {
    const { deps } = makeDeps({
      brain: async () => ({
        marketView: '횡보',
        decisions: [{ action: 'HOLD', reasoning: '관망' }],
      }),
    });
    await runCycle(deps);
    expect(deps.store.getDecisions(10)[0].status).toBe('HOLD');
    expect(deps.store.getTrades(10)).toHaveLength(0);
  });

  it('brain 실패 시 사이클 스킵 (주문 없음, ERROR 기록)', async () => {
    const { deps } = makeDeps({
      brain: async () => ({ marketView: '', decisions: [] }),
    });
    deps.brain = async () => { throw new Error('brain down'); };
    const result = await runCycle(deps);
    expect(result.skipped).toBe(true);
    expect(deps.store.getTrades(10)).toHaveLength(0);
    expect(deps.store.getDecisions(10)[0].status).toBe('ERROR');
  });

  it('일일 손실 한도 초과 시나리오: 급락 후 매수 거부', async () => {
    const { deps } = makeDeps({
      brain: async () => ({
        marketView: '',
        decisions: [{
          action: 'BUY', symbol: SYM, quantity: 1, orderType: 'MARKET', reasoning: '저가 매수 시도',
          thesis: { why: 'w', target: '+5%', stop: '-2%', exitCondition: 'x' },
        }],
      }),
    });

    // 시드 의존성 제거: 가격을 고정해 10주 매수가 주문 한도(총자산 10%) 안에 들도록
    (deps.adapter as MockAdapter).setPrice(SYM, 90_000);
    // 1사이클: 포지션 확보 (90,000 × 10주 = 90만원 ≤ 100만원 한도)
    deps.brain = async () => ({
      marketView: '',
      decisions: [{
        action: 'BUY', symbol: SYM, quantity: 10, orderType: 'MARKET', reasoning: '진입',
        thesis: { why: 'w', target: '+5%', stop: '-2%', exitCondition: 'x' },
      }],
    });
    await runCycle(deps);
    // 보유 종목 -40% 급락 주입 → equity가 일일 한도(-3%) 아래로
    const mock = deps.adapter as MockAdapter;
    const [q] = await mock.getQuotes([SYM]);
    mock.setPrice(SYM, Math.round(q.price * 0.6));
    deps.brain = async () => ({
      marketView: '급락',
      decisions: [{
        action: 'BUY', symbol: SYM, quantity: 1, orderType: 'MARKET', reasoning: '물타기',
        thesis: { why: 'w', target: '+5%', stop: '-2%', exitCondition: 'x' },
      }],
    });
    await runCycle(deps);
    const d = deps.store.getDecisions(10)[0];
    expect(d.status).toBe('REJECTED');
    expect(d.rejectReason).toContain('일일 손실');
  });

  it('events에 update 이벤트 발행', async () => {
    const { deps } = makeDeps({
      brain: async () => ({ marketView: '횡보', decisions: [{ action: 'HOLD', reasoning: '관망' }] }),
    });
    let emitted = false;
    deps.events!.on('update', () => { emitted = true; });
    await runCycle(deps);
    expect(emitted).toBe(true);
  });

  it('지정가 미도달 주문은 PENDING으로 기록되고 포지션 없음', async () => {
    const { deps } = makeDeps({
      brain: async () => ({ marketView: '', decisions: [] }),
    });
    (deps.adapter as MockAdapter).setPrice(SYM, 90_000);
    deps.brain = async () => ({
      marketView: '대기',
      decisions: [{
        action: 'BUY', symbol: SYM, quantity: 5, orderType: 'LIMIT', limitPrice: 80_000, reasoning: '저가 대기',
        thesis: { why: 'w', target: '+5%', stop: '-2%', exitCondition: 'x' },
      }],
    });
    await runCycle(deps);
    const d = deps.store.getDecisions(10)[0];
    expect(d.status).toBe('PENDING');
    expect(deps.broker.positions).toHaveLength(0);
    expect(deps.broker.pendingOrders).toHaveLength(1);
  });
});

// ── new tests ─────────────────────────────────────────────────────────────────

describe('신규 사이클 동작', () => {
  it('BUY 체결 시 thesis가 포지션에 저장된다', async () => {
    const { deps, broker } = makeDeps({
      brain: async () => ({
        marketView: 'm',
        decisions: [{
          action: 'BUY', symbol: SYM, quantity: 1, orderType: 'MARKET', reasoning: 'r',
          thesis: { why: 'w', target: '+5%', stop: '-2%', exitCondition: 'x' },
        }],
      }),
    });
    await runCycle(deps);
    expect(broker.positions[0]!.thesis?.why).toBe('w');
  });

  it('스냅샷에 benchmark가 기록되고 첫 사이클에 baseline KV가 생긴다', async () => {
    const { deps, store } = makeDeps({
      brain: async () => ({ marketView: 'm', decisions: [{ action: 'HOLD', reasoning: 'r' }] }),
    });
    await runCycle(deps);
    expect(store.getKV('benchmarkBaseline')).not.toBeNull();
    expect(store.getSnapshots(1)[0]!.benchmark).not.toBeNull();
  });

  it('SELL 체결 시 lastSell KV가 갱신된다', async () => {
    const { deps, store } = makeDeps({
      brain: async () => ({
        marketView: 'm',
        decisions: [{
          action: 'SELL', symbol: SYM, quantity: 1, orderType: 'MARKET', reasoning: 'r',
        }],
      }),
      presetPosition: { symbol: SYM, quantity: 2, avgPrice: 1000 },
    });
    await runCycle(deps);
    expect(store.getKV(`lastSell:${SYM}`)).not.toBeNull();
  });

  it('틱 체결 시 pendingThesis가 포지션에 적용되고 KV가 삭제된다', async () => {
    // cycle 1: LIMIT BUY below market → PENDING (pendingThesis collected into atomic block)
    const { deps, broker, store } = makeDeps({
      brain: async () => ({ marketView: '', decisions: [] }),
    });
    const mock = deps.adapter as MockAdapter;
    mock.setPrice(SYM, 90_000);
    const thesis = { why: '저점 매수', target: '+5%', stop: '-2%', exitCondition: '목표 도달' };
    deps.brain = async () => ({
      marketView: '대기',
      decisions: [{
        action: 'BUY', symbol: SYM, quantity: 2, orderType: 'LIMIT', limitPrice: 80_000,
        reasoning: '지정가 대기', thesis,
      }],
    });
    await runCycle(deps);
    // pendingThesis KV should be written atomically
    expect(store.getKV(`pendingThesis:${SYM}`)).not.toBeNull();
    expect(broker.positions).toHaveLength(0);

    // cycle 2: price crosses limit → tick fill → thesis applied
    mock.setPrice(SYM, 79_000);
    deps.brain = async () => ({ marketView: '체결', decisions: [{ action: 'HOLD', reasoning: '대기' }] });
    await runCycle(deps);
    expect(broker.positions).toHaveLength(1);
    expect(broker.positions[0]!.thesis?.why).toBe('저점 매수');
    expect(store.getKV(`pendingThesis:${SYM}`)).toBeNull();
  });

  it('시세 조회 실패 시 에러 메시지의 시크릿이 [REDACTED]로 마스킹된다', async () => {
    const { deps, store } = makeDeps({
      brain: async () => ({ marketView: '', decisions: [] }),
      secrets: ['supersecretkey123'],
    });
    deps.adapter.getQuotes = async () => {
      throw new Error('HTTP 401: token=supersecretkey123 invalid');
    };
    await runCycle(deps);
    const d = store.getDecisions(10)[0];
    expect(d.status).toBe('ERROR');
    expect(d.reasoning).toContain('[REDACTED]');
    expect(d.reasoning).not.toContain('supersecretkey123');
  });

  it('requireIndicators=true + getCandles 미구현 어댑터 → SKIPPED, 두뇌 미호출', async () => {
    let brainCalled = false;
    const { deps, store, broker } = makeDeps({
      brain: async () => { brainCalled = true; return { marketView: 'm', decisions: [{ action: 'HOLD', reasoning: 'r' }] }; },
    });
    // getCandles 미구현 어댑터로 교체 → collectIndicators가 [] 반환
    (deps.adapter as { getCandles?: unknown }).getCandles = undefined;
    const result = await runCycle(deps);
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('no-indicators');
    expect(brainCalled).toBe(false);
    expect(broker.positions).toHaveLength(0);
    expect(store.getTrades(10)).toHaveLength(0);
    const d = store.getDecisions(10)[0];
    expect(d.status).toBe('SKIPPED');
    expect(d.reasoning).toContain('지표 데이터 없음');
    // finishCycle은 실행되어 스냅샷은 남는다
    expect(store.getSnapshots(10)).toHaveLength(1);
  });

  it('requireIndicators=false면 getCandles 미구현 어댑터도 매매한다', async () => {
    const { deps, broker } = makeDeps({
      brain: async () => ({
        marketView: 'm',
        decisions: [{
          action: 'BUY', symbol: SYM, quantity: 1, orderType: 'MARKET', reasoning: 'r',
          thesis: { why: 'w', target: '+5%', stop: '-2%', exitCondition: 'x' },
        }],
      }),
    });
    deps.config = { ...deps.config, requireIndicators: false };
    (deps.adapter as { getCandles?: unknown }).getCandles = undefined;
    const result = await runCycle(deps);
    expect(result.skipped).toBe(false);
    expect(broker.positions).toHaveLength(1);
  });

  it('ordersToday KV가 체결마다 증가한다', async () => {
    const { deps, store } = makeDeps({
      brain: async () => ({
        marketView: 'm',
        decisions: [{
          action: 'BUY', symbol: SYM, quantity: 1, orderType: 'MARKET', reasoning: 'r',
          thesis: { why: 'w', target: '+5%', stop: '-2%', exitCondition: 'x' },
        }],
      }),
    });
    await runCycle(deps);
    const key = `ordersToday:${new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' })}`;
    expect(Number(store.getKV(key))).toBe(1);
  });
});
