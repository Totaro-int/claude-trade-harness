import { describe, it, expect } from 'vitest';
import { runBrain, runClaudeText, BrainOutputSchema, BrainAuthError } from '../src/brain/runner.js';

const STUB = 'tests/fixtures/claude-stub.sh';

describe('runClaudeText 프롬프트 상한', () => {
  it('프롬프트가 상한(800KB)을 넘으면 spawn 전에 throw', async () => {
    const huge = 'x'.repeat(900_000);
    await expect(runClaudeText(huge, { claudeCmd: STUB, timeoutMs: 1000 })).rejects.toThrow(/너무 큽니다/);
  });
});

describe('runBrain', () => {
  it('스텁 출력에서 JSON을 추출하고 스키마 검증해 반환', async () => {
    const out = await runBrain('아무 프롬프트', { claudeCmd: STUB });
    expect(out.marketView).toBe('테스트 시장');
    expect(out.decisions[0]).toMatchObject({ action: 'BUY', symbol: '005930', quantity: 5 });
  });

  it('실행 실패 시(존재하지 않는 명령) 재시도 후 throw', async () => {
    await expect(runBrain('x', { claudeCmd: '/nonexistent-cmd' })).rejects.toThrow();
  });

  it('본문 JSON 뒤에 추가 {...} 텍스트가 있어도 첫 JSON만 추출한다', async () => {
    const out = await runBrain('x', { claudeCmd: 'tests/fixtures/claude-stub-trailing.sh' });
    expect(out.marketView).toBe('본문');
    expect(out.decisions).toHaveLength(1);
  });

  it('BUY인데 symbol/quantity가 없으면 스키마 검증 실패로 throw', async () => {
    await expect(
      runBrain('x', { claudeCmd: 'tests/fixtures/claude-stub-invalid.sh' }),
    ).rejects.toThrow();
  });
});

describe('thesis 스키마 & 세션 만료', () => {
  it('BUY인데 thesis 없으면 스키마 거부', () => {
    const r = BrainOutputSchema.safeParse({
      marketView: 'm',
      decisions: [{ action: 'BUY', symbol: 'A', quantity: 1, orderType: 'MARKET', reasoning: 'r' }],
    });
    expect(r.success).toBe(false);
  });

  it('SELL/HOLD는 thesis 불필요', () => {
    const r = BrainOutputSchema.safeParse({
      marketView: 'm',
      decisions: [
        { action: 'SELL', symbol: 'A', quantity: 1, orderType: 'MARKET', reasoning: 'r' },
        { action: 'HOLD', reasoning: 'r' },
      ],
    });
    expect(r.success).toBe(true);
  });

  it('thesis.why가 상한(500자)을 넘으면 스키마 거부', () => {
    const r = BrainOutputSchema.safeParse({
      marketView: 'm',
      decisions: [{
        action: 'BUY', symbol: 'A', quantity: 1, orderType: 'MARKET', reasoning: 'r',
        thesis: { why: 'x'.repeat(501), target: '+5%', stop: '-2%', exitCondition: '목표' },
      }],
    });
    expect(r.success).toBe(false);
  });

  it('세션 만료 stderr 패턴이면 BrainAuthError', async () => {
    await expect(runBrain('p', { claudeCmd: 'tests/fixtures/claude-stub-auth-error.sh', timeoutMs: 5000 }))
      .rejects.toThrow(BrainAuthError);
  });

  it('LLM 텍스트의 rate limit 문구는 BrainAuthError로 오분류되지 않는다', async () => {
    const err = await runBrain('p', { claudeCmd: 'tests/fixtures/claude-stub-ratelimit-text.sh', timeoutMs: 5000 }).catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(BrainAuthError);
  });
});
