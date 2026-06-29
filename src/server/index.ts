import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { z } from 'zod';
import type { AppConfig } from '../core/config.js';
import type { SetupOrchestrator } from '../setup/orchestrator.js';

/**
 * 온보딩 전용 서버 — 증권사 어댑터 생성·검증 마법사(setup.html).
 * (advisory 전환으로 운영 대시보드/broker 상태 라우팅은 제거됨. 분석 결과는 reports/portfolio-latest.md.)
 */
export interface ServerDeps {
  config: AppConfig;
  port: number;
  orchestrator: SetupOrchestrator;
  onSetupComplete?: () => void;
}

// ── POST 본문 검증 스키마 (경계에서 unknown → 검증된 형태로) ──
const BrokerRegSchema = z.object({
  brokerId: z.string(), brokerName: z.string(), docsUrls: z.array(z.string()),
  baseUrl: z.string(), apiKey: z.string(), apiSecret: z.string(), accountNo: z.string(),
});
const TestSchema = z.object({ testSymbol: z.string().optional() });
const StrategyUploadSchema = z.object({ filename: z.string(), content: z.string() });
const InterviewSchema = z.object({
  risk: z.string(), capital: z.number(), horizon: z.string(), sectors: z.array(z.string()),
});
const FinishSchema = z.object({
  mode: z.enum(['paper', 'live']),
  guardrails: z.record(z.string(), z.number()),
  agreed: z.boolean(),
});

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
};

async function readJson(req: IncomingMessage): Promise<unknown> {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 1_000_000) throw new Error('요청 본문이 너무 큽니다');
  }
  return JSON.parse(data || '{}');
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
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

function createSetupHandler(deps: ServerDeps, progressClients: Set<ServerResponse>) {
  const orch = deps.orchestrator;

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
        const body = BrokerRegSchema.parse(await readJson(req));
        await orch.registerBroker(body);
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
        const body = TestSchema.parse(await readJson(req));
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
        const body = StrategyUploadSchema.parse(await readJson(req));
        await orch.saveStrategyDoc(body.filename, body.content);
        json(res, 200, { ok: true });
      } catch (err) {
        json(res, 400, { error: (err as Error).message });
      }
      return true;
    }

    // POST /api/setup/strategy/interview (async, 202)
    if (req.method === 'POST' && pathname === '/api/setup/strategy/interview') {
      let profile: z.infer<typeof InterviewSchema>;
      try {
        profile = InterviewSchema.parse(await readJson(req));
      } catch (err) {
        json(res, 400, { error: (err as Error).message });
        return true;
      }
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
        const body = FinishSchema.parse(await readJson(req));
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

export async function startServer(deps: ServerDeps): Promise<() => void> {
  const progressClients = new Set<ServerResponse>();
  const setupHandler = createSetupHandler(deps, progressClients);

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${deps.port}`);
    const pathname = url.pathname;

    void (async () => {
      try {
        const handled = await setupHandler(req, res, pathname);
        if (handled) return;

        // public/ 정적 파일 (resolve + prefix traversal 차단)
        const publicRoot = resolve('public');
        const file = resolve(publicRoot, pathname.slice(1));
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
    server.listen(deps.port, '127.0.0.1', resolvePromise);
  });

  console.log(`[setup] http://localhost:${deps.port}`);

  return () => {
    for (const res of progressClients) res.end();
    server.close();
  };
}
