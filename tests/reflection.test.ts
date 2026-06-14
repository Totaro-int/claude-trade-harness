import { describe, it, expect } from 'vitest';
import { buildReflection, formatReflections } from '../src/brain/reflection.js';
import type { Position } from '../src/core/types.js';

const thesis = { why: '반도체 회복', target: '+6%', stop: '-3%', exitCondition: '20일선 이탈' };

function pos(over: Partial<Position> = {}): Position {
  return { symbol: '005930', name: '삼성전자', quantity: 10, avgPrice: 70_000, thesis, openedAt: '2026-06-10T00:00:00.000Z', ...over };
}

describe('buildReflection', () => {
  it('thesis 없으면 null', () => {
    expect(buildReflection(pos({ thesis: undefined }), 71_000, new Date())).toBeNull();
  });

  it('이익 청산 → WIN, pnlPct 양수', () => {
    const r = buildReflection(pos(), 73_500, new Date('2026-06-10T05:00:00.000Z'))!;
    expect(r.result).toBe('WIN');
    expect(r.pnlPct).toBeCloseTo(5, 2);        // 73500/70000 - 1 = +5%
    expect(r.heldHours).toBe(5);
    expect(r.why).toBe('반도체 회복');
  });

  it('손실 청산 → LOSS, pnlPct 음수', () => {
    const r = buildReflection(pos(), 67_900, new Date('2026-06-10T01:00:00.000Z'))!;
    expect(r.result).toBe('LOSS');
    expect(r.pnlPct).toBeCloseTo(-3, 2);
  });

  it('openedAt 미래(클럭 스큐) → heldHours 0으로 클램프', () => {
    const r = buildReflection(pos({ openedAt: '2026-06-11T00:00:00.000Z' }), 71_000, new Date('2026-06-10T00:00:00.000Z'))!;
    expect(r.heldHours).toBe(0);
  });

  it('잘못된 가격(0/NaN) → null', () => {
    expect(buildReflection(pos(), 0, new Date())).toBeNull();
    expect(buildReflection(pos({ avgPrice: 0 }), 71_000, new Date())).toBeNull();
  });
});

describe('formatReflections', () => {
  it('WIN/LOSS·pnl·근거를 한 줄로 요약', () => {
    const r = buildReflection(pos(), 73_500, new Date('2026-06-10T05:00:00.000Z'))!;
    const [line] = formatReflections([r]);
    expect(line).toContain('삼성전자(005930)');
    expect(line).toContain('WIN +5%');
    expect(line).toContain('반도체 회복');
  });
});
