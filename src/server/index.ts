import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import type { EventEmitter } from 'node:events';
import type { AppConfig } from '../core/config.js';
import type { PaperBroker } from '../broker/paper.js';
import type { Store } from '../core/store.js';
import type { SetupOrchestrator } from '../setup/orchestrator.js';
import type { Quote } from '../core/types.js';

export interface ServerDeps {
  config: AppConfig;
  events: EventEmitter;
  port: number;
  setupMode: boolean;
  // operational mode
  store?: Store;
  broker?: PaperBroker;
  // setup mode
  orchestrator?: SetupOrchestrator;
  onSetupComplete?: () => void;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
};

// ──────────────────────────────────────────────────────────────
// Body / SSE helpers
// ──────────────────────────────────────────────────────────────

async function readJson(req: IncomingMessage): Promise<unknown> {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 1_000_000) throw new Error('요청 본문이 너무 큽니다');
  }
  return JSON.parse(data || '{}');
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
}

function sseInit(res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  res.write(': connected\n\n');
}

function sseSend(res: ServerResponse, data: unknown): void {
  if (!res.writableEnded && !res.destroyed) {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }
}

// ──────────────────────────────────────────────────────────────
// buildState (operational mode)
// ──────────────────────────────────────────────────────────────

function kstTodayKey(): string {
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return now.toISOString().slice(0, 10); // YYYY-MM-DD
}

function buildState(deps: ServerDeps) {
  const { store, broker, config } = deps;
  if (!store || !broker) throw new Error('store/broker 없음 — 운영 모드 전용');

  const rawQuotes = store.getKV('lastQuotes');
  const quotesList: Quote[] = rawQuotes ? (JSON.parse(rawQuotes) as Quote[]) : [];
  const quotesMap = new Map<string, Quote>(quotesList.map(q => [q.symbol, q]));

  const equity = broker.equity(quotesMap);
  const snapshots = store.getSnapshots(500);
  const last = snapshots.at(-1);
  const decisions = store.getDecisions(50);

  let consecutiveErrors = 0;
  for (const d of decisions) {
    if (d.status === 'ERROR') consecutiveErrors++;
    else break;
  }

  // brokerName: read from adapters/registry.json if present, else config.brokerId
  let brokerName: string = config.brokerId;
  const registryPath = resolve('adapters', 'registry.json');
  if (existsSync(registryPath)) {
    try {
      const reg = JSON.parse(readFileSync(registryPath, 'utf-8')) as { brokerName?: string };
      if (reg.brokerName) brokerName = reg.brokerName;
    } catch {
      // ignore parse error, fall back to brokerId
    }
  }

  // quotes as object map symbol→quote
  const quotesObj: Record<string, Quote> = {};
  for (const [sym, q] of quotesMap) quotesObj[sym] = q;

  return {
    mode: config.mode,
    consecutiveErrors,
    equity,
    cash: broker.cash,
    initialCash: config.initialCash,
    totalReturnPct: ((equity - config.initialCash) / config.initialCash) * 100,
    dailyPnlPct: last?.dailyPnlPct ?? 0,
    benchmark: last?.benchmark ?? null,
    lastUpdate: last?.ts ?? null,
    updatedAt: last?.ts ?? null,
    positions: broker.positions.map(p => {
      const cur = quotesMap.get(p.symbol)?.price ?? p.avgPrice;
      return {
        ...p,
        currentPrice: cur,
        pnl: (cur - p.avgPrice) * p.quantity,
        pnlPct: ((cur - p.avgPrice) / p.avgPrice) * 100,
      };
    }),
    decisions,
    snapshots,
    ordersToday: Number(store.getKV(`ordersToday:${kstTodayKey()}`) ?? 0),
    maxOrdersPerDay: config.guardrails.maxOrdersPerDay,
    feesTotal: store.totalFees(),
    brokerName,
    quotes: quotesObj,
    warning: store.getKV('warning'),
  };
}

// ──────────────────────────────────────────────────────────────
// Setup-mode route handler
// ──────────────────────────────────────────────────────────────

function createSetupHandler(deps: ServerDeps, progressClients: Set<ServerResponse>) {
  const orch = deps.orchestrator!;

  function pushProgress(data: { message: string; done?: boolean; ok?: boolean; error?: string }): void {
    const dead: ServerResponse[] = [];
    for (const res of progressClients) {
      if (res.writableEnded || res.destroyed) { dead.push(res); continue; }
      sseSend(res, data);
      if (data.done) res.end();
    }
    for (const r of dead) progressClients.delete(r);
  }

  return async function handleSetup(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
  ): Promise<boolean> {
    // GET /
    if (req.method === 'GET' && pathname === '/') {
      const setupHtml = resolve('public', 'setup.html');
      if (existsSync(setupHtml)) {
        res.writeHead(200, { 'content-type': MIME['.html'] });
        res.end(readFileSync(setupHtml));
      } else {
        res.writeHead(200, { 'content-type': MIME['.html'] });
        res.end('<!doctype html><div id="setup-root">setup</div>');
      }
      return true;
    }

    // GET /api/setup/status
    if (req.method === 'GET' && pathname === '/api/setup/status') {
      json(res, 200, orch.status());
      return true;
    }

    // GET /api/setup/progress (SSE)
    if (req.method === 'GET' && pathname === '/api/setup/progress') {
      sseInit(res);
      progressClients.add(res);
      req.on('close', () => progressClients.delete(res));
      res.on('error', () => progressClients.delete(res));
      return true;
    }

    // POST /api/setup/broker
    if (req.method === 'POST' && pathname === '/api/setup/broker') {
      try {
        const body = await readJson(req);
        await orch.registerBroker(body as Parameters<SetupOrchestrator['registerBroker']>[0]);
        json(res, 200, { ok: true });
      } catch (err) {
        json(res, 400, { error: (err as Error).message });
      }
      return true;
    }

    // POST /api/setup/generate (async, 202)
    if (req.method === 'POST' && pathname === '/api/setup/generate') {
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      // run in background
      void (async () => {
        try {
          await orch.generate(msg => pushProgress({ message: msg }));
          pushProgress({ message: '어댑터 생성 완료', done: true, ok: true });
        } catch (err) {
          pushProgress({ message: (err as Error).message, done: true, ok: false, error: (err as Error).message });
        }
      })();
      return true;
    }

    // POST /api/setup/test
    if (req.method === 'POST' && pathname === '/api/setup/test') {
      try {
        const body = await readJson(req) as { testSymbol?: string };
        const result = await orch.testConnection(body.testSymbol ?? '');
        json(res, 200, result);
      } catch (err) {
        json(res, 200, { ok: false, steps: [], error: (err as Error).message });
      }
      return true;
    }

    // POST /api/setup/strategy/upload
    if (req.method === 'POST' && pathname === '/api/setup/strategy/upload') {
      try {
        const body = await readJson(req) as { filename?: string; content?: string };
        await orch.saveStrategyDoc(body.filename ?? '', body.content ?? '');
        json(res, 200, { ok: true });
      } catch (err) {
        json(res, 400, { error: (err as Error).message });
      }
      return true;
    }

    // POST /api/setup/strategy/interview (async, 202)
    if (req.method === 'POST' && pathname === '/api/setup/strategy/interview') {
      const profile = await readJson(req) as Parameters<SetupOrchestrator['generateStrategy']>[0];
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      void (async () => {
        try {
          await orch.generateStrategy(profile);
          pushProgress({ message: '전략 생성 완료', done: true, ok: true });
        } catch (err) {
          pushProgress({ message: (err as Error).message, done: true, ok: false, error: (err as Error).message });
        }
      })();
      return true;
    }

    // POST /api/setup/finish
    if (req.method === 'POST' && pathname === '/api/setup/finish') {
      try {
        const body = await readJson(req) as Parameters<SetupOrchestrator['finish']>[0];
        await orch.finish(body);
        deps.onSetupComplete?.();
        json(res, 200, { ok: true });
      } catch (err) {
        json(res, 400, { error: (err as Error).message });
      }
      return true;
    }

    return false;
  };
}

// ──────────────────────────────────────────────────────────────
// startServer
// ──────────────────────────────────────────────────────────────

export async function startServer(deps: ServerDeps): Promise<() => void> {
  const sseClients = new Set<ServerResponse>();         // operational /events
  const progressClients = new Set<ServerResponse>();    // setup /api/setup/progress

  // Operational SSE push
  const onUpdate = () => {
    if (deps.setupMode) return;
    let payload: string;
    try {
      payload = `data: ${JSON.stringify(buildState(deps))}\n\n`;
    } catch {
      return;
    }
    for (const res of sseClients) {
      if (res.writableEnded || res.destroyed) { sseClients.delete(res); continue; }
      res.write(payload);
    }
  };
  deps.events.on('update', onUpdate);

  const setupHandler = deps.setupMode
    ? createSetupHandler(deps, progressClients)
    : null;

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${deps.port}`);
    const pathname = url.pathname;

    void (async () => {
      try {
        // ── Setup mode routing ──
        if (deps.setupMode && setupHandler) {
          const handled = await setupHandler(req, res, pathname);
          if (handled) return;
          res.writeHead(404);
          res.end('not found');
          return;
        }

        // ── Operational mode routing ──

        if (pathname === '/api/state') {
          json(res, 200, buildState(deps));
          return;
        }

        if (pathname === '/api/live/confirm') {
          if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
          try {
            const body = await readJson(req) as { last4?: string };
            const expected = process.env['BROKER_ACCOUNT_NO']?.slice(-4);
            if (!expected || body.last4 !== expected) {
              json(res, 400, { error: '계좌 확인 실패' });
              return;
            }
            deps.store?.setKV('liveConfirmed', '1');
            json(res, 200, { ok: true });
          } catch (err) {
            json(res, 400, { error: (err as Error).message });
          }
          return;
        }

        if (pathname === '/events') {
          sseInit(res);
          sseClients.add(res);
          req.on('close', () => sseClients.delete(res));
          res.on('error', () => sseClients.delete(res));
          return;
        }

        // vendor static (T18 naming convention)
        if (pathname === '/vendor/uplot.iife.min.js' || pathname === '/vendor/uplot.min.css') {
          const file = pathname.endsWith('.js')
            ? 'node_modules/uplot/dist/uPlot.iife.min.js'
            : 'node_modules/uplot/dist/uPlot.min.css';
          if (existsSync(file)) {
            res.writeHead(200, { 'content-type': pathname.endsWith('.js') ? MIME['.js'] : MIME['.css'] });
            res.end(readFileSync(file));
            return;
          }
        }

        // public/ static (resolve + prefix traversal block)
        const pathName = pathname === '/' ? '/index.html' : pathname;
        const publicRoot = resolve('public');
        const file = resolve(publicRoot, pathName.slice(1));
        if ((file === publicRoot || file.startsWith(publicRoot + '/')) && existsSync(file)) {
          res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
          res.end(readFileSync(file));
          return;
        }

        res.writeHead(404);
        res.end('not found');
      } catch (err) {
        if (!res.headersSent) {
          json(res, 500, { error: (err as Error).message });
        } else {
          res.end();
        }
      }
    })();
  });

  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(deps.port, resolvePromise);
  });

  const modeLabel = deps.setupMode ? 'setup' : 'dashboard';
  console.log(`[${modeLabel}] http://localhost:${deps.port}`);

  return () => {
    deps.events.off('update', onUpdate);
    for (const res of sseClients) res.end();
    for (const res of progressClients) res.end();
    server.close();
  };
}
