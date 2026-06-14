import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig, isConfigured } from './core/config.js';
import { Store } from './core/store.js';
import { loadEnvFile } from './env.js';
import { MockAdapter } from './broker/mock.js';
import { loadAdapter } from './broker/loader.js';
import { PaperBroker } from './broker/paper.js';
import { assertLiveUnlocked } from './broker/live.js';
import { startScheduler } from './core/scheduler.js';
import { buildHolidaySet, isTradingDay } from './core/market-calendar.js';
import { runCycle } from './core/cycle.js';
import { initHealth, recordCycleStart, recordCycleOk, recordCycleError, readHealth, FAILURE_THRESHOLD } from './core/health.js';
import { makeAlerter } from './core/alert.js';
import { scrub, errMsg } from './core/scrub.js';
import { runBrain, BrainAuthError } from './brain/runner.js';
import { makeSkeptic } from './brain/skeptic.js';
import { startServer } from './server/index.js';
import { SetupOrchestrator } from './setup/orchestrator.js';
import { loadStrategyDocs } from './backtest/load.js';
import type { UniverseEntry } from './core/types.js';

const ROOT = process.cwd();

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
        console.error('온보딩 완료 — 재시작하세요');
        setTimeout(() => process.exit(0), 500);
      },
    });
    console.log(`[setup] http://localhost:${config.port} 에서 온보딩을 진행하세요`);
    return;
  }

  // ── OPERATIONAL MODE ──

  // Claude Code CLI 가용성 점검 (경고만 — mock 모드나 이후 login으로도 동작 가능)
  try {
    execFileSync(config.claudeCmd, ['--version'], { stdio: 'ignore' });
  } catch {
    console.error(
      `Claude Code CLI(\`${config.claudeCmd}\`)를 찾을 수 없습니다. 설치 후 \`claude login\`을 실행하세요.`,
    );
  }

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
  if (
    !Array.isArray(universe) ||
    !universe.every(u => u && typeof u.symbol === 'string' && typeof u.name === 'string')
  ) {
    throw new Error('strategy/universe.json은 [{"symbol","name"}] 배열이어야 합니다');
  }

  // strategy docs 로드 (strategy/*.md + *.txt) — backtest/load.ts 공유본 사용
  const strategyDocs = loadStrategyDocs();

  // 어댑터 로드
  let adapter: import('./broker/adapter.js').BrokerAdapter & { advance?: () => void };
  // 캐치된 에러 메시지에서 마스킹할 시크릿 (cycle.ts가 에러 경로에서 스크럽). mock은 시크릿 없음 → [].
  let secrets: string[] = [];
  let accountNo = '';   // 라이브 확인용 (서버로 전달, 끝 4자리 비교에만 사용)
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
        // parse 실패 — 아래 빈 baseUrl 경고로 처리
      }
    }
    if (!baseUrl) {
      console.warn('adapters/registry.json을 읽을 수 없습니다 — 온보딩을 다시 실행하세요');
    }
    const adapterPath = resolve(ROOT, 'adapters', config.brokerId, 'adapter.ts');
    const adapterEnv = {
      apiKey: env['BROKER_API_KEY'] ?? '',
      apiSecret: env['BROKER_API_SECRET'] ?? '',
      accountNo: env['BROKER_ACCOUNT_NO'] ?? '',
      baseUrl,
    };
    secrets = [adapterEnv.apiKey, adapterEnv.apiSecret, adapterEnv.accountNo].filter(s => s.length >= 6);
    accountNo = adapterEnv.accountNo;
    adapter = await loadAdapter(adapterPath, adapterEnv);
    await adapter.auth();
  }

  // LIVE 모드 잠금 검사 (v1은 라이브 주문 실행 비지원)
  if (config.mode === 'live') {
    try {
      assertLiveUnlocked(config.mode, process.env['CLAUDE_TRADE_LIVE'], store);
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

  // 운영 알림 발송기 (webhook 설정 시 원격, 아니면 콘솔·macOS 로컬)
  const alert = makeAlerter({ webhookUrl: config.alertWebhook });

  // 치명적 오류 — 상태 저장 + 알림 후 종료(supervisor가 재시작). 미처리 예외/거부를 잡는다.
  const onFatal = (label: string) => (err: unknown): void => {
    const msg = scrub(errMsg(err), secrets);
    console.error(`[fatal:${label}] ${msg}`);
    try { store.setKV('broker', JSON.stringify(broker.toJSON())); } catch { /* best-effort */ }
    void alert(`치명적 오류(${label}) — 프로세스 종료, 재시작 필요: ${msg}`);
    setTimeout(() => process.exit(1), 1_000); // webhook 발송 여유
  };
  process.on('uncaughtException', onFatal('uncaughtException'));
  process.on('unhandledRejection', onFatal('unhandledRejection'));

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
          void alert('claude CLI 인증 필요 — 터미널에서 claude login 후 재시작');
        }
      }
      throw err;
    }
  };

  // 스켑틱 게이트 (config.skepticGate=true일 때만 — 매수마다 claude 1회 추가 호출)
  const skeptic = config.skepticGate
    ? makeSkeptic({ claudeCmd: config.claudeCmd, timeoutMs: 90_000 })
    : undefined;

  // 스케줄러 시작 — 거래일(주말·휴장일 제외) 판정을 어댑터 장중 시간과 결합
  const holidays = buildHolidaySet(config.holidays);
  initHealth(store, new Date());
  const stopScheduler = startScheduler({
    cycleMinutes: config.cycleMinutes,
    isMarketOpen: async () => isTradingDay(new Date(), holidays) && await adapter.isMarketOpen(),
    // 사이클 성공/실패를 heartbeat로 기록 — /health·대시보드·워치독이 읽는다
    runFn: async () => {
      recordCycleStart(store, new Date());
      try {
        const r = await runCycle({
          config, universe, adapter, broker, store, strategyDocs, brain, events, secrets, skeptic,
        });
        recordCycleOk(store, new Date());
        return r;
      } catch (err) {
        recordCycleError(store, new Date(), scrub(errMsg(err), secrets));
        // 연속 실패가 임계에 막 도달한 순간 1회만 알림 (이후 반복 알림 방지)
        const h = readHealth(store);
        if (h && h.consecutiveFailures === FAILURE_THRESHOLD) {
          void alert(`사이클 연속 ${h.consecutiveFailures}회 실패 — 점검 필요. 마지막 오류: ${h.lastError ?? ''}`);
        }
        throw err;
      }
    },
    onMarketClose: () => {
      broker.cancelAllPending();
      store.setKV('broker', JSON.stringify(broker.toJSON()));
      // 장마감 1회/일 — 오래된 decisions·snapshots 정리 (무인 장기 운영 DB 증가 억제)
      const pruned = store.prune(config.retentionDays ?? 90);
      if (pruned > 0) console.log(`[prune] 오래된 로그 ${pruned}행 정리`);
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
    accountNo,
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
