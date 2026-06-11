import { EventEmitter } from 'node:events';
import { startServer } from '../src/server/index.js';
import { Store } from '../src/core/store.js';
import { PaperBroker } from '../src/broker/paper.js';
import { loadConfig } from '../src/core/config.js';

const config = { ...loadConfig('/nonexistent'), port: 3456 };
const store = new Store(':memory:');

store.recordSnapshot({
  ts: new Date().toISOString(),
  equity: 10_100_000,
  cash: 9_300_000,
  dailyPnlPct: 1,
  benchmark: null,
});
store.recordSnapshot({
  ts: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
  equity: 10_050_000,
  cash: 9_250_000,
  dailyPnlPct: 0.5,
  benchmark: null,
});
store.recordDecision({
  ts: new Date().toISOString(),
  action: 'BUY',
  symbol: '005930',
  name: '삼성전자',
  quantity: 10,
  orderType: 'MARKET',
  limitPrice: null,
  reasoning: '테스트 근거',
  status: 'FILLED',
  rejectReason: null,
  marketView: '강세',
  thesis: null,
});

const broker = new PaperBroker({
  initialCash: config.initialCash,
  feeRate: config.feeRate,
  taxRate: config.taxRate,
  halfSpreadPct: config.halfSpreadPct,
});

await startServer({
  store,
  broker,
  config,
  events: new EventEmitter(),
  port: config.port,
  setupMode: false,
});
