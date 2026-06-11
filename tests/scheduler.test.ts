import { describe, it, expect, vi, afterEach } from 'vitest';
import { startScheduler } from '../src/core/scheduler.js';

afterEach(() => vi.useRealTimers());

describe('startScheduler', () => {
  it('장이 열려 있으면 cycleMinutes 간격으로 runFn 실행', async () => {
    vi.useFakeTimers();
    const runFn = vi.fn().mockResolvedValue(undefined);
    const stop = startScheduler({
      isMarketOpen: async () => true,
      runFn,
      cycleMinutes: 10,
      checkIntervalMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(1000);   // 첫 체크 → 즉시 1회 실행
    expect(runFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5 * 60_000); // 5분 — 아직 간격 미달
    expect(runFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5 * 60_000); // 10분 경과
    expect(runFn).toHaveBeenCalledTimes(2);
    stop();
  });

  it('장이 닫혀 있으면 실행하지 않음', async () => {
    vi.useFakeTimers();
    const runFn = vi.fn().mockResolvedValue(undefined);
    const stop = startScheduler({
      isMarketOpen: async () => false,
      runFn,
      cycleMinutes: 10,
      checkIntervalMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runFn).not.toHaveBeenCalled();
    stop();
  });

  it('장 열림→닫힘 전환 시 onMarketClose 1회 호출', async () => {
    vi.useFakeTimers();
    let open = true;
    const onMarketClose = vi.fn();
    const stop = startScheduler({
      isMarketOpen: async () => open,
      runFn: async () => {},
      cycleMinutes: 10,
      checkIntervalMs: 1000,
      onMarketClose,
    });
    await vi.advanceTimersByTimeAsync(2000);
    open = false;
    await vi.advanceTimersByTimeAsync(3000); // 닫힘 체크 여러 번 — 호출은 1회만
    expect(onMarketClose).toHaveBeenCalledTimes(1);
    stop();
  });

  it('runFn이 throw해도 스케줄러가 죽지 않음', async () => {
    vi.useFakeTimers();
    const runFn = vi.fn().mockRejectedValue(new Error('boom'));
    const stop = startScheduler({
      isMarketOpen: async () => true,
      runFn,
      cycleMinutes: 0, // 매 체크마다 실행
      checkIntervalMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(runFn.mock.calls.length).toBeGreaterThanOrEqual(2);
    stop();
  });
});
