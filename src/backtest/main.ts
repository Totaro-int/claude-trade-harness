import { loadConfig } from '../core/config.js';
import { runBrain } from '../brain/runner.js';
import { runBacktest } from './runner.js';
import { loadUniverse, loadStrategyDocs, loadBacktestAdapter, collectCandles } from './load.js';
import type { BrainOutput } from '../core/types.js';

const won = (n: number) => Math.round(n).toLocaleString('ko-KR');

function parseBars(argv: string[]): number {
  const idx = argv.indexOf('--bars');
  if (idx >= 0 && argv[idx + 1]) {
    const n = Number(argv[idx + 1]);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return 60;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const bars = parseBars(process.argv.slice(2));
  const universe = loadUniverse();
  const strategyDocs = loadStrategyDocs();

  const adapter = await loadBacktestAdapter(config, universe);
  const candlesBySymbol = await collectCandles(adapter, universe, bars);
  const minLen = Math.min(...[...candlesBySymbol.values()].map(c => c.length));

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
