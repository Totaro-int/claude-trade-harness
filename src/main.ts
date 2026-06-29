/**
 * 온보딩 엔트리포인트 — `npm run onboard`.
 *
 * 증권사 OpenAPI 문서·키를 입력받아 Claude가 어댑터를 생성·검증하는 setup 마법사를 띄운다.
 * 온보딩이 끝나면 `npm run review` 로 보유종목 분석을 실행한다.
 * (advisory 전환으로 30분 자동매매 루프는 제거됨.)
 */

import { loadConfig, isConfigured } from './core/config.js';
import { startServer } from './server/index.js';
import { SetupOrchestrator } from './setup/orchestrator.js';

const ROOT = process.cwd();

async function main(): Promise<void> {
  const config = loadConfig();

  if (isConfigured()) {
    console.log('이미 온보딩이 완료됐습니다. `npm run review` 로 보유종목 분석을 실행하세요.');
    return;
  }

  const orchestrator = new SetupOrchestrator({ rootDir: ROOT, claudeCmd: config.claudeCmd });
  const stopServer = await startServer({
    config,
    port: config.port,
    orchestrator,
    onSetupComplete: () => {
      console.error('온보딩 완료 — `npm run review` 로 분석을 실행하세요');
      setTimeout(() => process.exit(0), 500);
    },
  });
  console.log(`[setup] http://localhost:${config.port} 에서 온보딩을 진행하세요`);

  const shutdown = () => { stopServer(); process.exit(0); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
