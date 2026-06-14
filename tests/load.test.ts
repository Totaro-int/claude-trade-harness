import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectCandles, assertWithinDir } from '../src/backtest/load.js';
import type { BrokerAdapter } from '../src/broker/adapter.js';
import type { Candle, UniverseEntry } from '../src/core/types.js';

function fakeAdapter(lengths: Record<string, number>): BrokerAdapter {
  return {
    getCandles: async (symbol: string, _tf: string, bars: number): Promise<Candle[]> => {
      const n = Math.min(lengths[symbol] ?? 0, bars);
      return Array.from({ length: n }, (_, i) => ({
        time: `2026-01-${String(i + 1).padStart(2, '0')}`, open: 1, high: 1, low: 1, close: 1, volume: 1,
      }));
    },
  } as unknown as BrokerAdapter;
}

const UNIV: UniverseEntry[] = [{ symbol: 'A', name: 'a' }, { symbol: 'B', name: 'b' }];

describe('collectCandles', () => {
  it('전 종목을 가장 짧은 길이로 절삭한다', async () => {
    const m = await collectCandles(fakeAdapter({ A: 100, B: 60 }), UNIV, 200);
    expect(m.get('A')!.length).toBe(60);
    expect(m.get('B')!.length).toBe(60);
  });

  it('길이 불균형이 20%를 넘으면 경고한다', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await collectCandles(fakeAdapter({ A: 100, B: 50 }), UNIV, 200);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('균형 잡힌 길이면 경고하지 않는다', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await collectCandles(fakeAdapter({ A: 100, B: 90 }), UNIV, 200);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('수집된 캔들이 없으면 throw', async () => {
    await expect(collectCandles(fakeAdapter({ A: 0, B: 0 }), UNIV, 200)).rejects.toThrow(/수집된 캔들/);
  });
});

describe('assertWithinDir', () => {
  it('디렉터리 안의 파일은 통과한다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'awd-'));
    const f = join(dir, 'a.md');
    writeFileSync(f, 'x');
    try {
      expect(() => assertWithinDir(f, dir)).not.toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('디렉터리 밖을 가리키는 심볼릭링크는 throw한다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'awd-'));
    const outside = mkdtempSync(join(tmpdir(), 'awd-out-'));
    const secret = join(outside, 'secret.txt');
    writeFileSync(secret, 'top');
    const link = join(dir, 'link.md');
    symlinkSync(secret, link);
    try {
      expect(() => assertWithinDir(link, dir)).toThrow(/디렉터리 밖/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
