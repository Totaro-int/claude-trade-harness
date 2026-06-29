/**
 * advisory 엔트리포인트 — `npm run review`.
 *
 * 토스(또는 mock) 어댑터로 실보유를 받아 4대가 관점으로 분석하고 포트폴리오 진단 리포트를
 * `reports/portfolio-latest.md` 와 DB(KV)에 쓴다. 30분 자동매매 루프 대신 on-demand 1회 실행.
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadConfig, isConfigured } from '../core/config.js';
import { Store } from '../core/store.js';
import { loadEnvFile } from '../env.js';
import { MockAdapter } from '../broker/mock.js';
import { loadAdapter } from '../broker/loader.js';
import { wrapAdapter, type BrokerAdapter } from '../broker/adapter.js';
import { makeResearchRunner } from '../research/runner.js';
import { runReview } from './run.js';
import type { UniverseEntry } from '../core/types.js';

const ROOT = process.cwd();

async function loadBrokerAdapter(brokerId: string): Promise<BrokerAdapter> {
  if (brokerId === 'mock') {
    const universePath = resolve(ROOT, 'strategy', 'universe.json');
    const universe = existsSync(universePath)
      ? (JSON.parse(readFileSync(universePath, 'utf-8')) as UniverseEntry[])
      : [];
    return new MockAdapter(universe);
  }
  const env = loadEnvFile(resolve(ROOT, '.env'));
  const registryPath = resolve(ROOT, 'adapters', 'registry.json');
  let baseUrl = '';
  if (existsSync(registryPath)) {
    try { baseUrl = (JSON.parse(readFileSync(registryPath, 'utf-8')) as { baseUrl?: string }).baseUrl ?? ''; }
    catch { /* 아래 빈 baseUrl 경고 */ }
  }
  if (!baseUrl) console.warn('adapters/registry.json을 읽을 수 없습니다 — 온보딩을 다시 실행하세요');
  const adapterPath = resolve(ROOT, 'adapters', brokerId, 'adapter.ts');
  const adapter = await loadAdapter(adapterPath, {
    apiKey: env['BROKER_API_KEY'] ?? '',
    apiSecret: env['BROKER_API_SECRET'] ?? '',
    accountNo: env['BROKER_ACCOUNT_NO'] ?? '',
    baseUrl,
  });
  await adapter.auth();
  return wrapAdapter(adapter);
}

async function main(): Promise<void> {
  const config = loadConfig();

  if (!isConfigured() && config.brokerId !== 'mock') {
    console.error('아직 온보딩이 안 됐습니다. `npm run onboard` 로 증권사 어댑터 온보딩을 먼저 완료하세요.');
    process.exit(1);
  }

  try {
    execFileSync(config.claudeCmd, ['--version'], { stdio: 'ignore' });
  } catch {
    console.error(`Claude Code CLI(\`${config.claudeCmd}\`)를 찾을 수 없습니다. 설치 후 \`claude login\`을 실행하세요.`);
    process.exit(1);
  }

  const store = new Store(config.dbPath);
  const adapter = await loadBrokerAdapter(config.brokerId);

  // 웹검색 허용 러너 — 렌즈는 펀더멘털 웹조사, 종합은 도구 불필요(같은 러너로 무방)
  const runResearch = makeResearchRunner({ claudeCmd: config.claudeCmd, timeoutMs: 300_000 });

  console.log('[review] 보유종목 분석 시작 — 종목당 4대가 렌즈 + 종합 (수 분 소요)…');
  const result = await runReview({
    adapter,
    runLens: runResearch,
    runSynthesis: runResearch,
    saveReport: (key, value) => store.setKV(key, value),
    now: new Date(),
  });

  // 파일로도 기록 (reports/portfolio-latest.md)
  const reportsDir = resolve(ROOT, 'reports');
  mkdirSync(reportsDir, { recursive: true });
  const reportPath = resolve(reportsDir, 'portfolio-latest.md');
  writeFileSync(reportPath, result.reportMd, 'utf-8');

  store.close();
  console.log(`[review] 완료 — ${result.comp.positions.length}개 종목 분석. 리포트: ${reportPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
