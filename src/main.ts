import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { loadConfig, isConfigured } from './core/config.js';
import { Store } from './core/store.js';
import { loadEnvFile } from './env.js';
import { MockAdapter } from './broker/mock.js';
import { loadAdapter } from './broker/loader.js';
import { PaperBroker } from './broker/paper.js';
import { assertLiveUnlocked } from './broker/live.js';
import { startScheduler } from './core/scheduler.js';
import { runCycle } from './core/cycle.js';
import { runBrain, BrainAuthError } from './brain/runner.js';
import { startServer } from './server/index.js';
import { SetupOrchestrator } from './setup/orchestrator.js';
import type { UniverseEntry } from './core/types.js';

const ROOT = process.cwd();

function notifyMac(msg: string): void {
  if (process.platform === 'darwin') {
    execFile('osascript', ['-e', `display notification ${JSON.stringify(msg)} with title "open-trader"`], () => {});
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const events = new EventEmitter();

  // ── ONBOARDING MODE ──
  if (!isConfigured() && config.brokerId !== 'mock') {
    const orchestrator = new SetupOrchestrator({ rootDir: ROOT, claudeCmd: config.claudeCmd });
    await startServer({
      config,
      events,
      port: config.port,
      setupMode: true,
      orchestrator,
      onSetupComplete: () => {
        console.log('온보딩 완료 — 재시작하세요');
        setTimeout(() => process.exit(0), 500);
      },
    });
    console.log(`[setup] http://localhost:${config.port} 에서 온보딩을 진행하세요`);
    return;
  }

  // ── OPERATIONAL MODE ──

  const store = new Store(config.dbPath);

  // universe.json 로드
  const universePath = resolve(ROOT, 'strategy', 'universe.json');
  if (!existsSync(universePath)) {
    throw new Error('strategy/universe.json 파일이 없습니다. 온보딩을 먼저 완료하거나 파일을 생성하세요.');
  }
  let universe: UniverseEntry[];
  try {
    universe = JSON.parse(readFileSync(universePath, 'utf-8')) as UniverseEntry[];
  } catch (err) {
    throw new Error(`strategy/universe.json 파싱 실패: ${(err as Error).message}`);
  }

  // strategy docs 로드 (strategy/*.md + *.txt)
  function loadStrategyDocs(): string {
    const stratDir = resolve(ROOT, 'strategy');
    if (!existsSync(stratDir)) return '(전략 문서 없음)';
    let files: string[];
    try {
      files = readdirSync(stratDir).filter(f => f.endsWith('.md') || f.endsWith('.txt'));
    } catch {
      return '(전략 문서 없음)';
    }
    if (files.length === 0) return '(전략 문서 없음)';
    return files.map(f => readFileSync(join(stratDir, f), 'utf-8')).join('\n\n---\n\n');
  }
  const strategyDocs = loadStrategyDocs();

  // 어댑터 로드
  let adapter: import('./broker/adapter.js').BrokerAdapter & { advance?: () => void };
  if (config.brokerId === 'mock') {
    adapter = new MockAdapter(universe);
  } else {
    const env = loadEnvFile(resolve(ROOT, '.env'));
    const registryPath = resolve(ROOT, 'adapters', 'registry.json');
    let baseUrl = '';
    if (existsSync(registryPath)) {
      try {
        const reg = JSON.parse(readFileSync(registryPath, 'utf-8')) as { baseUrl?: string };
        baseUrl = reg.baseUrl ?? '';
      } catch {
        // registry 파싱 실패 시 baseUrl 빈 문자열
      }
    }
    const adapterPath = resolve(ROOT, 'adapters', config.brokerId, 'adapter.ts');
    adapter = await loadAdapter(adapterPath, {
      apiKey: env['BROKER_API_KEY'] ?? '',
      apiSecret: env['BROKER_API_SECRET'] ?? '',
      accountNo: env['BROKER_ACCOUNT_NO'] ?? '',
      baseUrl,
    });
    await adapter.auth();
  }

  // LIVE 모드 잠금 검사 (v1은 라이브 주문 실행 비지원)
  if (config.mode === 'live') {
    try {
      assertLiveUnlocked(config.mode, process.env['OPEN_TRADER_LIVE'], store);
      // 잠금은 통과했지만 v1은 실제 라이브 주문 미구현
      console.error('라이브 주문 연동은 v1 범위 밖 — 페이퍼로 운전하세요');
      process.exit(1);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  }

  // PaperBroker 복원 또는 신규 생성
  const rates = {
    feeRate: config.feeRate,
    taxRate: config.taxRate,
    halfSpreadPct: config.halfSpreadPct,
  };
  const savedBroker = store.getKV('broker');
  let broker: PaperBroker;
  if (savedBroker) {
    try {
      broker = PaperBroker.fromJSON(
        JSON.parse(savedBroker) as Parameters<typeof PaperBroker.fromJSON>[0],
        rates,
      );
    } catch {
      broker = new PaperBroker({ initialCash: config.initialCash, ...rates });
    }
  } else {
    broker = new PaperBroker({ initialCash: config.initialCash, ...rates });
  }

  // Brain 래퍼 — BrainAuthError를 경고로 기록
  let consecutiveAuthErrors = 0;
  const brain = async (prompt: string): Promise<import('./core/types.js').BrainOutput> => {
    try {
      const result = await runBrain(prompt, { claudeCmd: config.claudeCmd, timeoutMs: 180_000 });
      consecutiveAuthErrors = 0;
      return result;
    } catch (err) {
      if (err instanceof BrainAuthError) {
        consecutiveAuthErrors++;
        store.setKV('warning', 'claude CLI 인증 필요 — 터미널에서 claude login 후 재시작');
        // 스트릭 첫 오류에만 알림 발송 (반복 사이클 중복 알림 방지)
        if (consecutiveAuthErrors === 1) {
          notifyMac('open-trader: claude CLI 인증 필요 — 터미널에서 claude login 후 재시작');
        }
      }
      throw err;
    }
  };

  // 스케줄러 시작
  const stopScheduler = startScheduler({
    cycleMinutes: config.cycleMinutes,
    isMarketOpen: () => adapter.isMarketOpen(),
    runFn: () =>
      runCycle({
        config,
        universe,
        adapter,
        broker,
        store,
        strategyDocs,
        brain,
        events,
      }),
    onMarketClose: () => {
      broker.cancelAllPending();
      store.setKV('broker', JSON.stringify(broker.toJSON()));
    },
  });

  // 서버 시작
  const stopServer = await startServer({
    config,
    events,
    port: config.port,
    setupMode: false,
    store,
    broker,
  });

  // 종료 처리
  const shutdown = () => {
    store.setKV('broker', JSON.stringify(broker.toJSON()));
    stopScheduler();
    stopServer();
    store.close();
    process.exit(0);
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
