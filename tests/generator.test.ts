import { describe, it, expect, afterEach } from 'vitest';
import { rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateAdapter } from '../src/setup/generator.js';

const OUT = join('adapters', '__test_gen');

afterEach(() => { rmSync(OUT, { recursive: true, force: true }); });

describe('generateAdapter', () => {
  it('스텁 claude로 어댑터 생성 → 정적 검사·컴파일 통과 → 파일 저장', async () => {
    const r = await generateAdapter({
      brokerId: '__test_gen',
      docsText: '# Fake API docs\nGET /quotes',
      env: { apiKey: 'k', apiSecret: 's', accountNo: 'a', baseUrl: 'https://api.example.com' },
      claudeCmd: 'tests/fixtures/claude-stub-adapter.sh',
      outDir: OUT,
      maxAttempts: 1,
      onProgress: () => {},
    });
    expect(r.ok).toBe(true);
    expect(readFileSync(join(OUT, 'adapter.ts'), 'utf-8')).toContain('createAdapter');
  }, 30000);

  it('코드 블록 없는 응답은 재시도 후 실패 보고', async () => {
    const r = await generateAdapter({
      brokerId: '__test_gen', docsText: 'x',
      env: { apiKey: 'k', apiSecret: 's', accountNo: 'a', baseUrl: 'https://api.example.com' },
      claudeCmd: 'tests/fixtures/claude-stub-invalid.sh', outDir: OUT, maxAttempts: 2, onProgress: () => {},
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  }, 30000);
});
