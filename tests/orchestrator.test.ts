import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SetupOrchestrator } from '../src/setup/orchestrator.js';

function mkOrch() {
  const root = mkdtempSync(join(tmpdir(), 'setup-'));
  return { root, orch: new SetupOrchestrator({ rootDir: root, claudeCmd: 'tests/fixtures/claude-stub-strategy.sh' }) };
}

describe('SetupOrchestrator', () => {
  it('브로커 등록 시 .env에 시크릿 저장 (코드/설정엔 미포함)', async () => {
    const { root, orch } = mkOrch();
    await orch.registerBroker({ brokerId: 'demo', brokerName: '데모증권', docsUrls: [], baseUrl: 'https://api.demo.com', apiKey: 'KEY1', apiSecret: 'SEC1', accountNo: '111' });
    const env = readFileSync(join(root, '.env'), 'utf-8');
    expect(env).toContain('BROKER_API_KEY=KEY1');
    expect(orch.status().broker?.brokerId).toBe('demo');
    expect(JSON.stringify(orch.status())).not.toContain('SEC1');
  });

  it('전략 업로드 → strategy/에 저장', async () => {
    const { root, orch } = mkOrch();
    await orch.saveStrategyDoc('my-strategy.md', '# 전략\n저평가 매수');
    expect(readFileSync(join(root, 'strategy/my-strategy.md'), 'utf-8')).toContain('저평가');
  });

  it('인터뷰 → claude 스텁이 strategy.md + universe.json 생성', async () => {
    const { root, orch } = mkOrch();
    await orch.generateStrategy({ risk: '중립', capital: 10_000_000, horizon: '스윙(수주)', sectors: ['반도체'] });
    expect(existsSync(join(root, 'strategy/strategy.md'))).toBe(true);
    expect(existsSync(join(root, 'strategy/universe.json'))).toBe(true);
  });

  it('finish → config.json 생성 (brokerId/가드레일 반영)', async () => {
    const { root, orch } = mkOrch();
    await orch.registerBroker({ brokerId: 'demo', brokerName: '데모증권', docsUrls: [], baseUrl: 'https://x.com', apiKey: 'k', apiSecret: 's', accountNo: '1' });
    await orch.finish({ mode: 'paper', guardrails: { maxPositionPct: 15 }, agreed: true });
    const cfg = JSON.parse(readFileSync(join(root, 'config.json'), 'utf-8'));
    expect(cfg.brokerId).toBe('demo');
    expect(cfg.guardrails.maxPositionPct).toBe(15);
  });

  it('면책 미동의 시 finish 거부', async () => {
    const { orch } = mkOrch();
    await expect(orch.finish({ mode: 'paper', guardrails: {}, agreed: false })).rejects.toThrow(/면책/);
  });
});
