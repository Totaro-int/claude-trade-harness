/**
 * server.test.ts — TDD for src/server/index.ts
 *
 * Test approach:
 * - Setup mode tests use a hand-rolled stub orchestrator (object literal cast
 *   as SetupOrchestrator) to avoid fs/claude side effects. This is intentional.
 * - Operational mode tests use a real in-memory Store(':memory:') + PaperBroker
 *   + EventEmitter, matching real production usage.
 * - Each describe block uses a fixed high port and stops the server in afterEach.
 * - EADDRINUSE test uses the setup-mode port to avoid allocating a new port.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Store } from '../src/core/store.js';
import { PaperBroker } from '../src/broker/paper.js';
import type { AppConfig } from '../src/core/config.js';
import type { SetupOrchestrator, SetupStatus } from '../src/setup/orchestrator.js';
import { startServer, type ServerDeps } from '../src/server/index.js';

// ──────────────────────────────────────────────────────────────
// Shared helpers
// ──────────────────────────────────────────────────────────────

const BASE_CONFIG: AppConfig = {
  mode: 'paper',
  brokerId: 'mock-broker',
  initialCash: 10_000_000,
  feeRate: 0.00015,
  taxRate: 0.0018,
  halfSpreadPct: 0.0005,
  cycleMinutes: 30,
  guardrails: {
    maxPositionPct: 20,
    maxOrderPct: 10,
    maxOrdersPerCycle: 3,
    dailyLossLimitPct: 3,
    maxOrdersPerDay: 10,
    reentryCooldownMin: 60,
    maxTotalExposurePct: 80,
  },
  claudeCmd: 'claude',
  dbPath: ':memory:',
  port: 34100,
};

async function get(port: number, path: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`http://localhost:${port}${path}`);
  const body = await res.text();
  return { status: res.status, body };
}

async function post(port: number, path: string, data: unknown): Promise<{ status: number; body: string }> {
  const res = await fetch(`http://localhost:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(data),
  });
  const body = await res.text();
  return { status: res.status, body };
}

// ──────────────────────────────────────────────────────────────
// Stub orchestrator (avoids fs/claude)
// ──────────────────────────────────────────────────────────────

function makeStubOrchestrator(opts: { registerBrokerThrows?: boolean; finishThrows?: boolean } = {}): SetupOrchestrator {
  const stub = {
    status(): SetupStatus {
      return { step: 'broker', adapterReady: false, strategyReady: false };
    },
    async registerBroker(_reg: unknown): Promise<void> {
      if (opts.registerBrokerThrows) throw new Error('브로커 등록 실패');
    },
    async generate(_onProgress: (m: string) => void) {
      return { ok: true, files: [] };
    },
    async testConnection(_sym: string) {
      return { ok: true, steps: [] };
    },
    async saveStrategyDoc(_filename: string, _content: string): Promise<void> {},
    async generateStrategy(_profile: unknown): Promise<void> {},
    async finish(_opts: unknown): Promise<void> {
      if (opts.finishThrows) throw new Error('면책 고지에 동의해야 시작할 수 있습니다');
    },
  };
  return stub as unknown as SetupOrchestrator;
}

// ──────────────────────────────────────────────────────────────
// Setup mode tests (port 34101)
// ──────────────────────────────────────────────────────────────

describe('서버 — 온보딩 모드', () => {
  const PORT = 34101;
  let stop: () => void;

  beforeEach(async () => {
    const deps: ServerDeps = {
      config: BASE_CONFIG,
      events: new EventEmitter(),
      port: PORT,
      setupMode: true,
      orchestrator: makeStubOrchestrator(),
      onSetupComplete: () => {},
    };
    stop = await startServer(deps);
  });

  afterEach(() => stop?.());

  it('GET / — setup-root 포함한 HTML 반환', async () => {
    const { status, body } = await get(PORT, '/');
    expect(status).toBe(200);
    expect(body).toContain('id="setup-root"');
  });

  it('GET /api/setup/status — orchestrator.status() JSON 반환', async () => {
    const { status, body } = await get(PORT, '/api/setup/status');
    expect(status).toBe(200);
    const json = JSON.parse(body) as SetupStatus;
    expect(json.step).toBe('broker');
    expect(json.adapterReady).toBe(false);
  });

  it('POST /api/setup/broker — 성공 시 {ok:true}', async () => {
    const payload = {
      brokerId: 'test-broker', brokerName: '테스트', docsUrls: [],
      baseUrl: 'https://api.test.com', apiKey: 'key', apiSecret: 'secret', accountNo: '12345678',
    };
    const { status, body } = await post(PORT, '/api/setup/broker', payload);
    expect(status).toBe(200);
    expect(JSON.parse(body)).toMatchObject({ ok: true });
  });

  it('POST /api/setup/broker — orchestrator 에러 시 400', async () => {
    // Use a fresh server with throwing orchestrator
    stop();
    const throwingDeps: ServerDeps = {
      config: BASE_CONFIG,
      events: new EventEmitter(),
      port: PORT,
      setupMode: true,
      orchestrator: makeStubOrchestrator({ registerBrokerThrows: true }),
    };
    stop = await startServer(throwingDeps);

    const { status, body } = await post(PORT, '/api/setup/broker', { brokerId: 'x' });
    expect(status).toBe(400);
    expect(JSON.parse(body)).toHaveProperty('error');
  });

  it('POST /api/setup/test — {ok, steps} 반환', async () => {
    const { status, body } = await post(PORT, '/api/setup/test', { testSymbol: '005930' });
    expect(status).toBe(200);
    const json = JSON.parse(body) as { ok: boolean; steps: unknown[] };
    expect(typeof json.ok).toBe('boolean');
    expect(Array.isArray(json.steps)).toBe(true);
  });

  it('POST /api/setup/strategy/upload — {ok:true} 반환', async () => {
    const { status, body } = await post(PORT, '/api/setup/strategy/upload', {
      filename: 'strategy.md', content: '# 전략',
    });
    expect(status).toBe(200);
    expect(JSON.parse(body)).toMatchObject({ ok: true });
  });

  it('POST /api/setup/finish — agreed:false → 400', async () => {
    stop();
    const throwingDeps: ServerDeps = {
      config: BASE_CONFIG,
      events: new EventEmitter(),
      port: PORT,
      setupMode: true,
      orchestrator: makeStubOrchestrator({ finishThrows: true }),
    };
    stop = await startServer(throwingDeps);

    const { status, body } = await post(PORT, '/api/setup/finish', {
      mode: 'paper', guardrails: {}, agreed: false,
    });
    expect(status).toBe(400);
    expect(JSON.parse(body)).toHaveProperty('error');
  });

  it('POST /api/setup/finish — agreed:true → {ok:true}', async () => {
    const { status, body } = await post(PORT, '/api/setup/finish', {
      mode: 'paper', guardrails: {}, agreed: true,
    });
    expect(status).toBe(200);
    expect(JSON.parse(body)).toMatchObject({ ok: true });
  });

  it('서버는 127.0.0.1 루프백에 바인딩됨', async () => {
    // Verify the server accepts connections on 127.0.0.1 (loopback-only binding)
    const res = await fetch(`http://127.0.0.1:${PORT}/api/setup/status`);
    expect(res.status).toBe(200);
  });

  it('GET /api/setup/progress — SSE text/event-stream 반환', async () => {
    const res = await fetch(`http://localhost:${PORT}/api/setup/progress`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    await res.body?.cancel();
  });

  it('POST /api/setup/generate — 202 반환', async () => {
    const { status } = await post(PORT, '/api/setup/generate', {});
    expect(status).toBe(202);
  });

  it('POST /api/setup/strategy/interview — 202 반환', async () => {
    const { status } = await post(PORT, '/api/setup/strategy/interview', {
      risk: 'moderate', capital: 10_000_000, horizon: '1년', sectors: ['IT'],
    });
    expect(status).toBe(202);
  });

  it('POST /api/setup/strategy/interview — 잘못된 JSON → 400', async () => {
    const res = await fetch(`http://localhost:${PORT}/api/setup/strategy/interview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-valid-json{{{',
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body).toHaveProperty('error');
  });
});

// ──────────────────────────────────────────────────────────────
// Operational mode tests (port 34102)
// ──────────────────────────────────────────────────────────────

describe('서버 — 운영 모드', () => {
  const PORT = 34102;
  let stop: () => void;
  let store: Store;
  let broker: PaperBroker;
  let events: EventEmitter;

  beforeEach(async () => {
    store = new Store(':memory:');
    broker = new PaperBroker({
      initialCash: 10_000_000,
      feeRate: 0.00015,
      taxRate: 0.0018,
      halfSpreadPct: 0.0005,
    });
    events = new EventEmitter();

    const deps: ServerDeps = {
      config: BASE_CONFIG,
      events,
      port: PORT,
      setupMode: false,
      store,
      broker,
    };
    stop = await startServer(deps);
  });

  afterEach(() => {
    stop?.();
    store.close();
  });

  it('GET /api/state — 기본 필드 모두 존재', async () => {
    const { status, body } = await get(PORT, '/api/state');
    expect(status).toBe(200);
    const json = JSON.parse(body) as Record<string, unknown>;
    // original fields
    expect(json).toHaveProperty('mode');
    expect(json).toHaveProperty('equity');
    expect(json).toHaveProperty('cash');
    expect(json).toHaveProperty('positions');
    expect(json).toHaveProperty('decisions');
    expect(json).toHaveProperty('snapshots');
    expect(json).toHaveProperty('consecutiveErrors');
    expect(json).toHaveProperty('totalReturnPct');
    expect(json).toHaveProperty('dailyPnlPct');
    // new fields required by T18 dashboard
    expect(json).toHaveProperty('benchmark');
    expect(json).toHaveProperty('ordersToday');
    expect(json).toHaveProperty('maxOrdersPerDay');
    expect(json).toHaveProperty('feesTotal');
    expect(json).toHaveProperty('brokerName');
    expect(json).toHaveProperty('quotes');
    expect(json).toHaveProperty('warning');
    expect(json).toHaveProperty('initialCash');
    expect(json).toHaveProperty('updatedAt');
  });

  it('GET /api/state — maxOrdersPerDay 는 config 값 반영', async () => {
    const { body } = await get(PORT, '/api/state');
    const json = JSON.parse(body) as { maxOrdersPerDay: number };
    expect(json.maxOrdersPerDay).toBe(BASE_CONFIG.guardrails.maxOrdersPerDay);
  });

  it('GET /api/state — feesTotal 은 숫자', async () => {
    const { body } = await get(PORT, '/api/state');
    const json = JSON.parse(body) as { feesTotal: number };
    expect(typeof json.feesTotal).toBe('number');
  });

  it('GET /api/state — quotes 는 객체', async () => {
    const { body } = await get(PORT, '/api/state');
    const json = JSON.parse(body) as { quotes: unknown };
    expect(typeof json.quotes).toBe('object');
    expect(json.quotes).not.toBeNull();
  });

  it('POST /api/live/confirm — 잘못된 last4 → 400', async () => {
    const { status, body } = await post(PORT, '/api/live/confirm', { last4: '0000' });
    expect(status).toBe(400);
    expect(JSON.parse(body)).toHaveProperty('error');
  });

  it('POST /api/live/confirm — last4 없음 → 400', async () => {
    const { status, body } = await post(PORT, '/api/live/confirm', {});
    expect(status).toBe(400);
    expect(JSON.parse(body)).toHaveProperty('error');
  });

  it('GET /events — SSE 스트림 반환', async () => {
    const res = await fetch(`http://localhost:${PORT}/events`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    await res.body?.cancel();
  });

  it('GET /vendor/uplot.iife.min.js — JS 파일 반환 또는 404', async () => {
    const { status } = await get(PORT, '/vendor/uplot.iife.min.js');
    expect([200, 404]).toContain(status);
  });

  it('GET /vendor/uplot.min.css — CSS 파일 반환 또는 404', async () => {
    const { status } = await get(PORT, '/vendor/uplot.min.css');
    expect([200, 404]).toContain(status);
  });

  it('알 수 없는 경로 → 404', async () => {
    const { status } = await get(PORT, '/does-not-exist-xyz');
    expect(status).toBe(404);
  });
});

// ──────────────────────────────────────────────────────────────
// EADDRINUSE: 같은 포트 두 번 바인딩 시 두 번째 reject
// ──────────────────────────────────────────────────────────────

describe('서버 — 포트 충돌', () => {
  const PORT = 34103;
  let stop1: () => void;

  afterEach(() => stop1?.());

  it('동일 포트 이중 기동 → EADDRINUSE reject', async () => {
    stop1 = await startServer({
      config: BASE_CONFIG,
      events: new EventEmitter(),
      port: PORT,
      setupMode: true,
      orchestrator: makeStubOrchestrator(),
    });

    await expect(
      startServer({
        config: BASE_CONFIG,
        events: new EventEmitter(),
        port: PORT,
        setupMode: true,
        orchestrator: makeStubOrchestrator(),
      }),
    ).rejects.toThrow();
  });
});
