import { describe, it, expect } from 'vitest';
import { assertLiveUnlocked } from '../src/broker/live.js';

describe('라이브 3중 잠금', () => {
  const confirmedStore = { getKV: (k: string) => (k === 'liveConfirmed' ? '1' : null) };
  it('세 조건 모두 충족 시에만 통과', () => {
    expect(() => assertLiveUnlocked('live', '1', confirmedStore as never)).not.toThrow();
  });
  it.each([
    ['paper', '1', true],
    ['live', undefined, true],
    ['live', '1', false],
  ] as const)('mode=%s env=%s confirmed=%s → 차단', (mode, env, confirmed) => {
    const s = { getKV: () => (confirmed ? '1' : null) };
    expect(() => assertLiveUnlocked(mode, env, s as never)).toThrow(/라이브 잠금/);
  });
});
