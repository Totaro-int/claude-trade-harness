import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { loadConfig } from '../core/config.js';
import { loadEnvFile } from '../env.js';
import { MockAdapter } from '../broker/mock.js';
import { loadAdapter } from '../broker/loader.js';
import { runBrain } from '../brain/runner.js';
import { runBacktest } from './runner.js';
import type { BrokerAdapter } from '../broker/adapter.js';
import type { BrainOutput, Candle, UniverseEntry } from '../core/types.js';

const ROOT = process.cwd();
const won = (n: number) => Math.round(n).toLocaleString('ko-KR');

function parseBars(argv: string[]): number {
  const idx = argv.indexOf('--bars');
  if (idx >= 0 && argv[idx + 1]) {
    const n = Number(argv[idx + 1]);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return 60;
}

function loadUniverse(): UniverseEntry[] {
  const path = resolve(ROOT, 'strategy', 'universe.json');
  if (!existsSync(path)) {
    throw new Error('strategy/universe.json 파일이 없습니다. 온보딩을 먼저 완료하거나 파일을 생성하세요.');
  }
  let universe: UniverseEntry[];
  try {
    universe = JSON.parse(readFileSync(path, 'utf-8')) as UniverseEntry[];
  } catch (err) {
    throw new Error(`strategy/universe.json 파싱 실패: ${(err as Error).message}`);
  }
  if (!Array.isArray(universe) || !universe.every(u => u && typeof u.symbol === 'string' && typeof u.name === 'string')) {
    throw new Error('strategy/universe.json은 [{"symbol","name"}] 배열이어야 합니다');
  }
  return universe;
}

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

async function loadBacktestAdapter(config: ReturnType<typeof loadConfig>, universe: UniverseEntry[]): Promise<BrokerAdapter> {
  if (config.brokerId === 'mock' || config.brokerId === '') {
    return new MockAdapter(universe);
  }
  const env = loadEnvFile(resolve(ROOT, '.env'));
  const registryPath = resolve(ROOT, 'adapters', 'registry.json');
  let baseUrl = '';
  if (existsSync(registryPath)) {
    try {
      baseUrl = (JSON.parse(readFileSync(registryPath, 'utf-8')) as { baseUrl?: string }).baseUrl ?? '';
    } catch { /* 빈 baseUrl로 진행 */ }
  }
  const adapterPath = resolve(ROOT, 'adapters', config.brokerId, 'adapter.ts');
  const adapter = await loadAdapter(adapterPath, {
    apiKey: env['BROKER_API_KEY'] ?? '', apiSecret: env['BROKER_API_SECRET'] ?? '',
    accountNo: env['BROKER_ACCOUNT_NO'] ?? '', baseUrl,
  });
  await adapter.auth();
  return adapter;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const bars = parseBars(process.argv.slice(2));
  const universe = loadUniverse();
  const strategyDocs = loadStrategyDocs();

  const adapter = await loadBacktestAdapter(config, universe);
  if (!adapter.getCandles) {
    console.error('이 어댑터는 getCandles를 구현하지 않아 백테스트할 수 없습니다.');
    process.exit(1);
  }

  // 종목별 캔들 수집
  const candlesBySymbol = new Map<string, Candle[]>();
  for (const u of universe) {
    try {
      const c = await adapter.getCandles(u.symbol, 'day', bars);
      if (c.length > 0) candlesBySymbol.set(u.symbol, c);
    } catch (err) {
      console.warn(`${u.symbol} 캔들 조회 실패 — 제외: ${(err as Error).message}`);
    }
  }
  if (candlesBySymbol.size === 0) {
    console.error('수집된 캔들이 없습니다. 어댑터/유니버스를 확인하세요.');
    process.exit(1);
  }

  // 인덱스 정렬 가정 — 가장 짧은 길이로 잘라 맞춤
  const minLen = Math.min(...[...candlesBySymbol.values()].map(c => c.length));
  for (const [s, c] of candlesBySymbol) {
    if (c.length !== minLen) candlesBySymbol.set(s, c.slice(c.length - minLen));
  }

  const startIndex = Math.min(20, minLen - 1);
  const tradingBars = Math.max(0, minLen - startIndex);

  console.log('━'.repeat(56));
  console.log('백테스트 — 과거 캔들 리플레이');
  console.log(`종목 ${candlesBySymbol.size}개 · 캔들 ${minLen}개 · 매매 막대 ${tradingBars}개 (시작 인덱스 ${startIndex})`);
  console.log('');
  console.warn('⚠️  주의: LLM 두뇌로 백테스트하면 막대마다 claude를 1회 호출합니다.');
  console.warn(`   예상 claude 호출 ≈ ${tradingBars}회 (비용/시간 소요). 진행합니다...`);
  console.log('━'.repeat(56));

  const brain = (prompt: string): Promise<BrainOutput> =>
    runBrain(prompt, { claudeCmd: config.claudeCmd, timeoutMs: 180_000 });

  const report = await runBacktest({
    candlesBySymbol, universe, config, strategyDocs, brain, startIndex,
    onBar: (i, equity, benchmark) => {
      if ((i - startIndex) % 10 === 0) {
        console.log(`  막대 ${i}/${minLen - 1} · 자산 ${won(equity)}원 · 벤치마크 ${won(benchmark)}원`);
      }
    },
  });

  const fmtPct = (p: number) => `${p >= 0 ? '+' : ''}${p.toFixed(2)}%`;

  console.log('');
  console.log('━'.repeat(56));
  console.log('  백테스트 결과');
  console.log('━'.repeat(56));
  console.log(`  막대 수        : ${report.bars}`);
  console.log(`  거래 수        : ${report.trades}`);
  console.log(`  수수료+세금    : ${won(report.feesTotal)}원`);
  console.log(`  초기 자산      : ${won(report.initialCash)}원`);
  console.log(`  최종 자산      : ${won(report.finalEquity)}원`);
  console.log(`  총수익률       : ${fmtPct(report.totalReturnPct)}`);
  console.log(`  벤치마크수익률 : ${fmtPct(report.benchmarkReturnPct)} (동일가중 buy-and-hold)`);
  console.log(`  최대 낙폭      : -${report.maxDrawdownPct.toFixed(2)}%`);
  console.log('━'.repeat(56));
  console.log(`  ▶ 초과수익 (정직한 점수판): ${fmtPct(report.excessPct)}p`);
  console.log('━'.repeat(56));
  if (report.excessPct < 0) {
    console.log('');
    console.log('  이 전략은 단순 매수후보유(buy-and-hold)보다 못했습니다.');
    console.log('  거래 비용을 쓰고도 벤치마크에 졌다는 뜻입니다 — 흔한 결과이며, 이 정직함이 백테스트의 핵심입니다.');
  }
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
