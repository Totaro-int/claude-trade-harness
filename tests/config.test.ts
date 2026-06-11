import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/core/config.js';
import { writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('loadConfig', () => {
  it('config.json이 없으면 기본값을 반환한다', () => {
    const cfg = loadConfig('/nonexistent/config.json');
    expect(cfg.mode).toBe('paper');
    expect(cfg.initialCash).toBe(10_000_000);
    expect(cfg.guardrails.maxPositionPct).toBe(20);
    expect(cfg.feeRate).toBeCloseTo(0.00015);
    expect(cfg.taxRate).toBeCloseTo(0.0018);
  });

  it('파일 값이 기본값을 덮어쓴다 (부분 병합)', () => {
    const cfg = loadConfig('config.json'); // Task 1에서 만든 파일
    expect(cfg.cycleMinutes).toBe(30);
    expect(cfg.claudeCmd).toBe('claude'); // 파일에 없는 키는 기본값
  });

  it('config.json이 깨진 JSON이면 파일 경로를 포함한 에러를 던진다', () => {
    const broken = join(tmpdir(), `broken-config-${process.pid}.json`);
    writeFileSync(broken, '{ "mode": ');
    expect(() => loadConfig(broken)).toThrow(/올바른 JSON이 아닙니다/);
    rmSync(broken);
  });

  it('신규 기본값: cycleMinutes 30, halfSpreadPct, 신규 가드레일', () => {
    const c = loadConfig('/nonexistent/config.json');
    expect(c.cycleMinutes).toBe(30);
    expect(c.halfSpreadPct).toBe(0.0005);
    expect(c.guardrails.maxOrdersPerDay).toBe(10);
    expect(c.guardrails.reentryCooldownMin).toBe(60);
    expect(c.guardrails.maxTotalExposurePct).toBe(80);
    expect(c.brokerId).toBe('');
  });
});
