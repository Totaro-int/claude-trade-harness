import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { loadConfig } from '../core/config.js';
import { runBrain } from '../brain/runner.js';
import { runEval, type EvalVariant } from './eval.js';
import { loadUniverse, loadStrategyDocs, loadBacktestAdapter, collectCandles } from './load.js';
import type { BrainOutput } from '../core/types.js';

const ROOT = process.cwd();
const won = (n: number) => Math.round(n).toLocaleString('ko-KR');
const fmtPct = (p: number) => `${p >= 0 ? '+' : ''}${p.toFixed(2)}%`;

function parseBars(argv: string[]): number {
  const idx = argv.indexOf('--bars');
  if (idx >= 0 && argv[idx + 1]) {
    const n = Number(argv[idx + 1]);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return 60;
}

/** strategy/eval/*.md|*.txt 를 각각 하나의 전략문서 변형으로 로드 (라벨 = 파일명). */
function loadVariants(baseDocs: string): EvalVariant[] {
  const variants: EvalVariant[] = [{ label: 'base', strategyDocs: baseDocs }];
  const evalDir = resolve(ROOT, 'strategy', 'eval');
  if (!existsSync(evalDir)) return variants;
  const files = readdirSync(evalDir).filter(f => f.endsWith('.md') || f.endsWith('.txt')).sort();
  for (const f of files) {
    variants.push({ label: basename(f).replace(/\.(md|txt)$/, ''), strategyDocs: readFileSync(join(evalDir, f), 'utf-8') });
  }
  return variants;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const bars = parseBars(process.argv.slice(2));
  const universe = loadUniverse();
  const baseDocs = loadStrategyDocs();
  const variants = loadVariants(baseDocs);

  if (variants.length < 2) {
    console.error('비교할 전략 변형이 없습니다. strategy/eval/ 폴더에 *.md 전략문서를 넣으세요 (각 파일이 하나의 변형).');
    process.exit(1);
  }

  const adapter = await loadBacktestAdapter(config, universe);
  const candlesBySymbol = await collectCandles(adapter, universe, bars);
  const minLen = Math.min(...[...candlesBySymbol.values()].map(c => c.length));
  const startIndex = Math.min(20, minLen - 1);
  const tradingBars = Math.max(0, minLen - startIndex);

  console.log('━'.repeat(56));
  console.log(`전략 평가(eval) — 변형 ${variants.length}개 × 매매 막대 ${tradingBars}개`);
  console.log(`변형: ${variants.map(v => v.label).join(', ')}`);
  console.warn(`⚠️  변형마다 막대당 claude 1회 호출 → 총 ≈ ${variants.length * tradingBars}회 (비용/시간 소요).`);
  console.warn('   LLM은 비결정적이라 변형 간 차이에는 노이즈가 섞입니다 — 막대 수를 늘려 완화하세요.');
  console.log('━'.repeat(56));

  const brain = (prompt: string): Promise<BrainOutput> =>
    runBrain(prompt, { claudeCmd: config.claudeCmd, timeoutMs: 180_000 });

  const report = await runEval({
    candlesBySymbol, universe, baseConfig: config, baseStrategyDocs: baseDocs, brain, startIndex,
    onVariant: (label, r) =>
      console.log(`  ✓ ${label.padEnd(16)} 초과수익 ${fmtPct(r.excessPct)}p · 거래 ${r.trades} · 자산 ${won(r.finalEquity)}원`),
  }, variants);

  console.log('');
  console.log('━'.repeat(56));
  console.log('  순위 (초과수익 = 벤치마크 대비, 정직한 점수판)');
  console.log('━'.repeat(56));
  report.results.forEach((r, i) => {
    const mark = i === 0 ? '▶' : ' ';
    console.log(`  ${mark} ${String(i + 1).padStart(2)}. ${r.label.padEnd(16)} ${fmtPct(r.report.excessPct).padStart(9)}p  (수익 ${fmtPct(r.report.totalReturnPct)} · 거래 ${r.report.trades} · MDD -${r.report.maxDrawdownPct.toFixed(1)}%)`);
  });
  console.log('━'.repeat(56));
  console.log(`  최고 변형: ${report.best}`);
  console.log('');
  console.log('  주의: 절대 초과수익보다 "어떤 변형이 더 나은가"의 상대 비교에 쓰세요. 단일 실행은 노이즈가 큽니다.');
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
