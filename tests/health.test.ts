import { describe, it, expect } from 'vitest';
import { Store } from '../src/core/store.js';
import {
  initHealth, recordCycleStart, recordCycleOk, recordCycleError,
  readHealth, evaluateHealth, FAILURE_THRESHOLD,
} from '../src/core/health.js';

const at = (iso: string): Date => new Date(iso);

describe('health heartbeat', () => {
  it('initHealth는 startedAt을 기록하고 누적 카운터는 보존한다', () => {
    const store = new Store(':memory:');
    initHealth(store, at('2026-06-15T00:00:00Z'));
    recordCycleOk(store, at('2026-06-15T00:30:00Z'));
    initHealth(store, at('2026-06-15T01:00:00Z')); // 재시작
    const s = readHealth(store)!;
    expect(s.startedAt).toBe('2026-06-15T01:00:00.000Z');
    expect(s.cyclesOk).toBe(1); // 보존
  });

  it('성공은 연속실패를 0으로 리셋하고 lastError를 지운다', () => {
    const store = new Store(':memory:');
    initHealth(store, at('2026-06-15T00:00:00Z'));
    recordCycleError(store, at('2026-06-15T00:10:00Z'), 'boom');
    recordCycleOk(store, at('2026-06-15T00:20:00Z'));
    const s = readHealth(store)!;
    expect(s.consecutiveFailures).toBe(0);
    expect(s.lastError).toBeNull();
    expect(s.cyclesFailed).toBe(1);
    expect(s.cyclesOk).toBe(1);
  });

  it('lastError는 300자로 자른다', () => {
    const store = new Store(':memory:');
    initHealth(store, at('2026-06-15T00:00:00Z'));
    recordCycleError(store, at('2026-06-15T00:10:00Z'), 'x'.repeat(500));
    expect(readHealth(store)!.lastError!.length).toBe(300);
  });

  it('연속실패가 임계 미만이면 healthy, 임계 이상이면 degraded', () => {
    const store = new Store(':memory:');
    initHealth(store, at('2026-06-15T00:00:00Z'));
    for (let i = 0; i < FAILURE_THRESHOLD - 1; i++) {
      recordCycleError(store, at('2026-06-15T00:10:00Z'), 'e');
    }
    expect(evaluateHealth(readHealth(store), at('2026-06-15T00:11:00Z')).healthy).toBe(true);
    recordCycleError(store, at('2026-06-15T00:12:00Z'), 'e');
    const rep = evaluateHealth(readHealth(store), at('2026-06-15T00:13:00Z'));
    expect(rep.healthy).toBe(false);
    expect(rep.status).toBe('degraded');
  });

  it('아직 사이클이 없으면 starting(healthy)', () => {
    const store = new Store(':memory:');
    initHealth(store, at('2026-06-15T00:00:00Z'));
    const rep = evaluateHealth(readHealth(store), at('2026-06-15T00:01:00Z'));
    expect(rep.status).toBe('starting');
    expect(rep.healthy).toBe(true);
  });

  it('상태가 전혀 없어도(null) 안전하게 starting으로 평가한다', () => {
    const rep = evaluateHealth(null, at('2026-06-15T00:00:00Z'));
    expect(rep.healthy).toBe(true);
    expect(rep.uptimeMs).toBe(0);
  });

  it('사이클이 시작됐는데 maxCycleMs 넘게 미완료면 멈춤(degraded)으로 본다', () => {
    const store = new Store(':memory:');
    initHealth(store, at('2026-06-15T00:00:00Z'));
    recordCycleStart(store, at('2026-06-15T00:00:00Z')); // 시작만, 완료 신호 없음
    // 5분 뒤: 한도(1분) 초과 → 멈춤
    const rep = evaluateHealth(readHealth(store), at('2026-06-15T00:05:00Z'), { maxCycleMs: 60_000 });
    expect(rep.healthy).toBe(false);
    expect(rep.reason).toMatch(/멈춤/);
  });

  it('완료된 사이클은 멈춤으로 보지 않는다', () => {
    const store = new Store(':memory:');
    initHealth(store, at('2026-06-15T00:00:00Z'));
    recordCycleStart(store, at('2026-06-15T00:00:00Z'));
    recordCycleOk(store, at('2026-06-15T00:00:30Z')); // 완료됨
    const rep = evaluateHealth(readHealth(store), at('2026-06-15T00:30:00Z'), { maxCycleMs: 60_000 });
    expect(rep.healthy).toBe(true);
  });
});
