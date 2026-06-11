import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface TradeRow {
  ts: string; side: string; symbol: string; name: string;
  quantity: number; price: number; fee: number; tax: number;
}

export interface DecisionRow {
  ts: string; action: string; symbol: string | null; name: string | null;
  quantity: number | null; orderType: string | null; limitPrice: number | null;
  reasoning: string; status: string; rejectReason: string | null; marketView: string;
  thesis: string | null;
}

export interface SnapshotRow {
  ts: string; equity: number; cash: number; dailyPnlPct: number;
  benchmark: number | null;
}

export class Store {
  #db: Database.Database;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.#db = new Database(path);
    this.#db.pragma('journal_mode = WAL');
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL, side TEXT NOT NULL, symbol TEXT NOT NULL, name TEXT NOT NULL,
        quantity INTEGER NOT NULL, price REAL NOT NULL, fee REAL NOT NULL, tax REAL NOT NULL
      );
      CREATE TABLE IF NOT EXISTS decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL, action TEXT NOT NULL, symbol TEXT, name TEXT,
        quantity INTEGER, order_type TEXT, limit_price REAL,
        reasoning TEXT NOT NULL, status TEXT NOT NULL, reject_reason TEXT, market_view TEXT NOT NULL,
        thesis TEXT
      );
      CREATE TABLE IF NOT EXISTS snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL, equity REAL NOT NULL, cash REAL NOT NULL, daily_pnl_pct REAL NOT NULL,
        benchmark REAL
      );
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  recordTrade(t: TradeRow): void {
    this.#db.prepare(
      'INSERT INTO trades (ts, side, symbol, name, quantity, price, fee, tax) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(t.ts, t.side, t.symbol, t.name, t.quantity, t.price, t.fee, t.tax);
  }

  getTrades(limit: number): TradeRow[] {
    return (this.#db.prepare(
      'SELECT ts, side, symbol, name, quantity, price, fee, tax FROM trades ORDER BY id DESC LIMIT ?',
    ).all(limit) as Record<string, unknown>[]).map(r => ({
      ts: r['ts'], side: r['side'], symbol: r['symbol'], name: r['name'],
      quantity: r['quantity'], price: r['price'], fee: r['fee'], tax: r['tax'],
    } as TradeRow));
  }

  recordDecision(d: DecisionRow): void {
    this.#db.prepare(
      `INSERT INTO decisions (ts, action, symbol, name, quantity, order_type, limit_price, reasoning, status, reject_reason, market_view, thesis)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(d.ts, d.action, d.symbol, d.name, d.quantity, d.orderType, d.limitPrice, d.reasoning, d.status, d.rejectReason, d.marketView, d.thesis);
  }

  getDecisions(limit: number): DecisionRow[] {
    return (this.#db.prepare(
      `SELECT ts, action, symbol, name, quantity, order_type, limit_price, reasoning, status, reject_reason, market_view, thesis
       FROM decisions ORDER BY id DESC LIMIT ?`,
    ).all(limit) as Record<string, unknown>[]).map(r => ({
      ts: r['ts'], action: r['action'], symbol: r['symbol'], name: r['name'],
      quantity: r['quantity'], orderType: r['order_type'], limitPrice: r['limit_price'],
      reasoning: r['reasoning'], status: r['status'], rejectReason: r['reject_reason'],
      marketView: r['market_view'], thesis: r['thesis'] as string | null,
    } as DecisionRow));
  }

  recordSnapshot(s: SnapshotRow): void {
    this.#db.prepare('INSERT INTO snapshots (ts, equity, cash, daily_pnl_pct, benchmark) VALUES (?, ?, ?, ?, ?)')
      .run(s.ts, s.equity, s.cash, s.dailyPnlPct, s.benchmark ?? null);
  }

  getSnapshots(limit: number): SnapshotRow[] {
    return (this.#db.prepare(
      'SELECT ts, equity, cash, daily_pnl_pct, benchmark FROM snapshots ORDER BY id DESC LIMIT ?',
    ).all(limit) as Record<string, unknown>[])
      .map(r => ({
        ts: r['ts'], equity: r['equity'], cash: r['cash'], dailyPnlPct: r['daily_pnl_pct'],
        benchmark: r['benchmark'] as number | null,
      } as SnapshotRow))
      .reverse(); // 시간순(과거→현재)
  }

  setKV(key: string, value: string): void {
    this.#db.prepare(
      'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(key, value);
  }

  getKV(key: string): string | null {
    const row = this.#db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  deleteKV(key: string): void {
    this.#db.prepare('DELETE FROM kv WHERE key = ?').run(key);
  }

  /**
   * 콜백 안의 모든 기록을 단일 SQLite 트랜잭션으로 묶는다 (체결-상태 원자성).
   * - 콜백은 반드시 동기여야 한다 — async 콜백은 타입 에러로 차단된다 (트랜잭션이 await 전에 커밋되는 사고 방지).
   * - 중첩 호출은 better-sqlite3 savepoint로 동작한다: 내부 atomic이 롤백돼도 외부는 커밋될 수 있다.
   */
  atomic<T>(fn: () => T extends Promise<unknown> ? never : T): T extends Promise<unknown> ? never : T {
    return this.#db.transaction(fn)();
  }

  /** 누적 수수료+세금 합계 */
  totalFees(): number {
    const row = this.#db.prepare('SELECT COALESCE(SUM(fee + tax), 0) AS total FROM trades').get() as { total: number };
    return row.total;
  }

  close(): void {
    this.#db.close();
  }
}
