import type { BrokerAdapter } from './adapter.js';
import type { Balance, Candle, Quote, UniverseEntry } from '../core/types.js';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class MockAdapter implements BrokerAdapter {
  readonly id = 'mock';
  #prices = new Map<string, number>();
  #names = new Map<string, string>();
  #rand: () => number;

  constructor(universe: UniverseEntry[], seed = 42) {
    this.#rand = mulberry32(seed);
    for (const u of universe) {
      this.#names.set(u.symbol, u.name);
      this.#prices.set(u.symbol, Math.round((10_000 + this.#rand() * 190_000) / 100) * 100);
    }
  }

  async auth(): Promise<void> {}

  /** volume은 호출마다 PRNG를 소비해 달라진다 — 같은 seed의 서로 다른 인스턴스끼리만 결정론이 성립. */
  async getQuotes(symbols: string[]): Promise<Quote[]> {
    return symbols.filter(s => this.#prices.has(s)).map(s => {
      const price = this.#prices.get(s)!;
      return { symbol: s, name: this.#names.get(s) ?? s, price, bid: price, ask: price, changeRate: 0, volume: Math.round(this.#rand() * 1_000_000) };
    });
  }

  async getBalance(): Promise<Balance> { return { cash: 0, positions: [] }; }
  async isMarketOpen(): Promise<boolean> { return true; }

  /** 일봉 스텝은 ±1%로 advance()의 사이클 스텝(±0.5%)보다 의도적으로 넓다. time은 Date.now() 기준이라 비결정적. */
  async getCandles(symbol: string, _interval: 'day' | 'minute', count: number): Promise<Candle[]> {
    const base = this.#prices.get(symbol) ?? 50_000;
    const out: Candle[] = [];
    let px = base;
    for (let i = count - 1; i >= 0; i--) {
      px = Math.max(100, Math.round(px * (1 + (this.#rand() - 0.5) * 0.02)));
      const d = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
      out.push({ time: d, open: px, high: Math.round(px * 1.01), low: Math.round(px * 0.99), close: px, volume: 100_000 });
    }
    return out;
  }

  /** 페이퍼 사이클마다 ±0.5% 랜덤워크 */
  advance(): void {
    for (const [s, p] of this.#prices) {
      this.#prices.set(s, Math.max(100, Math.round(p * (1 + (this.#rand() - 0.5) * 0.01))));
    }
  }

  /** 테스트 시나리오 주입 */
  setPrice(symbol: string, price: number): void { this.#prices.set(symbol, price); }
}
