import { describe, it, expect } from 'vitest';
import { loadConfig, isConfigured } from '../src/core/config.js';
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
    const tmpPath = join(tmpdir(), `merge-config-${process.pid}.json`);
    writeFileSync(tmpPath, JSON.stringify({ cycleMinutes: 5, guardrails: { maxPositionPct: 15 } }));
    try {
      const cfg = loadConfig(tmpPath);
      expect(cfg.cycleMinutes).toBe(5);
      expect(cfg.guardrails.maxPositionPct).toBe(15);
      expect(cfg.guardrails.maxOrdersPerDay).toBe(10); // deep-merge keeps unset guardrails
      expect(cfg.claudeCmd).toBe('claude'); // unset top-level keeps default
    } finally {
      rmSync(tmpPath);
    }
  });

  it('claudeCmd에 셸 메타문자가 있으면 throw한다', () => {
    const p = join(tmpdir(), `cmd-bad-${process.pid}.json`);
    writeFileSync(p, JSON.stringify({ claudeCmd: 'claude; curl evil' }));
    try {
      expect(() => loadConfig(p)).toThrow(/claudeCmd/);
    } finally { rmSync(p); }
  });

  it('claudeCmd 경로(슬래시·점)는 허용한다', () => {
    const p = join(tmpdir(), `cmd-ok-${process.pid}.json`);
    writeFileSync(p, JSON.stringify({ claudeCmd: '/usr/local/bin/claude' }));
    try {
      expect(loadConfig(p).claudeCmd).toBe('/usr/local/bin/claude');
    } finally { rmSync(p); }
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
    expect(c.guardrails.minHoldMin).toBe(0);
    expect(c.reflection).toBe(true);
    expect(c.skepticGate).toBe(false);
    expect(c.brokerId).toBe('');
  });
});

describe('isConfigured', () => {
  it('파일이 없으면 false를 반환한다', () => {
    expect(isConfigured('/nonexistent/config.json')).toBe(false);
  });

  it('brokerId가 빈 문자열이면 false를 반환한다', () => {
    const tmpPath = join(tmpdir(), `configured-empty-${process.pid}.json`);
    writeFileSync(tmpPath, JSON.stringify({ brokerId: '' }));
    try {
      expect(isConfigured(tmpPath)).toBe(false);
    } finally {
      rmSync(tmpPath);
    }
  });

  it('brokerId가 설정되어 있으면 true를 반환한다', () => {
    const tmpPath = join(tmpdir(), `configured-demo-${process.pid}.json`);
    writeFileSync(tmpPath, JSON.stringify({ brokerId: 'demo' }));
    try {
      expect(isConfigured(tmpPath)).toBe(true);
    } finally {
      rmSync(tmpPath);
    }
  });
});
