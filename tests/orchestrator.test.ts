import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SetupOrchestrator, validateDocsUrl } from '../src/setup/orchestrator.js';
import { saveEnvFile } from '../src/env.js';

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

  // brokerId 유효성 — 잘못된 형식 거부
  it.each([
    ['UPPER', 'brokerId'],
    ['-lead', 'brokerId'],
    ['with_under', 'brokerId'],
  ])('registerBroker("%s") → brokerId 오류', async (badId) => {
    const { orch } = mkOrch();
    await expect(
      orch.registerBroker({ brokerId: badId, brokerName: '테스트', docsUrls: [], baseUrl: 'https://x.com', apiKey: 'k', apiSecret: 's', accountNo: '1' }),
    ).rejects.toThrow(/brokerId/);
  });

  // 파일명 유효성 — 비정상 파일명 거부
  it.each([
    ['../escape.md'],
    ['a.md.sh'],
  ])('saveStrategyDoc("%s") → 파일명 오류', async (badFilename) => {
    const { orch } = mkOrch();
    await expect(orch.saveStrategyDoc(badFilename, '내용')).rejects.toThrow();
  });

  // finish merge — 기존 config.json의 키가 보존되고 guardrails가 병합됨
  it('finish merge: 기존 config.json의 port/guardrails.maxOrderPct 보존 + 새 guardrails 병합', async () => {
    const { root, orch } = mkOrch();
    await orch.registerBroker({ brokerId: 'demo', brokerName: '데모증권', docsUrls: [], baseUrl: 'https://x.com', apiKey: 'k', apiSecret: 's', accountNo: '1' });
    // pre-write existing config
    writeFileSync(join(root, 'config.json'), JSON.stringify({ port: 4000, guardrails: { maxOrderPct: 5 } }, null, 2));
    await orch.finish({ mode: 'paper', guardrails: { maxPositionPct: 15 }, agreed: true });
    const cfg = JSON.parse(readFileSync(join(root, 'config.json'), 'utf-8'));
    expect(cfg.port).toBe(4000);
    expect(cfg.guardrails.maxOrderPct).toBe(5);
    expect(cfg.guardrails.maxPositionPct).toBe(15);
  });

  // saveEnvFile — 줄바꿈이 포함된 값 거부
  it('saveEnvFile: 값에 줄바꿈 포함 시 오류', () => {
    const root = mkdtempSync(join(tmpdir(), 'env-'));
    expect(() => saveEnvFile({ MY_KEY: 'value\ninjected' }, join(root, '.env'))).toThrow(/줄바꿈/);
  });

  // SSRF 가드 — validateDocsUrl 직접 단위 테스트
  it.each([
    ['file:///etc/passwd'],
    ['http://169.254.169.254/'],
    ['http://localhost:6379/'],
    ['http://127.0.0.1:8080/'],
    ['http://10.0.0.5/docs'],
    ['http://192.168.1.1/'],
    ['http://172.16.0.1/'],
    ['http://[::1]/'],
    ['ftp://example.com/docs'],
    ['http://[::ffff:169.254.169.254]/latest/meta-data/'], // IPv4-mapped IPv6 → IMDS
    ['http://[::ffff:127.0.0.1]/'],
    ['http://[::ffff:10.0.0.1]/'],
    ['http://[::ffff:192.168.1.1]/'],
    ['http://metadata.google.internal/computeMetadata/v1/'], // GCP 메타데이터 호스트명
    ['http://foo.internal/'],
  ])('validateDocsUrl("%s") → 차단/허용 오류', (badUrl) => {
    expect(() => validateDocsUrl(badUrl)).toThrow(/차단|허용/);
  });

  it('validateDocsUrl: 정상 공개 https 문서 URL은 통과', () => {
    expect(() => validateDocsUrl('https://api.example.com/docs')).not.toThrow();
  });

  // SSRF 가드 — fetchDocs/generate 경로에서 내부 주소 거부
  it.each([
    ['file:///etc/passwd'],
    ['http://169.254.169.254/'],
    ['http://localhost:6379/'],
  ])('generate(): docsUrls=%s → SSRF 차단', async (badUrl) => {
    const { orch } = mkOrch();
    await orch.registerBroker({ brokerId: 'demo', brokerName: '데모증권', docsUrls: [badUrl], baseUrl: 'https://x.com', apiKey: 'k', apiSecret: 's', accountNo: '1' });
    await expect(orch.generate(() => {})).rejects.toThrow(/차단|허용/);
  });

  // generateStrategy — 불량 JSON 응답 시 유효한 JSON 오류
  it('generateStrategy: LLM이 불량 JSON 반환 시 유효한 JSON 오류', async () => {
    const root = mkdtempSync(join(tmpdir(), 'setup-'));
    const orch = new SetupOrchestrator({ rootDir: root, claudeCmd: 'tests/fixtures/claude-stub-badjson.sh' });
    await expect(
      orch.generateStrategy({ risk: '중립', capital: 10_000_000, horizon: '스윙(수주)', sectors: ['반도체'] }),
    ).rejects.toThrow(/유효한 JSON/);
  });
});
