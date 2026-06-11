export interface SchedulerOptions {
  isMarketOpen: (now: Date) => Promise<boolean>;
  runFn: () => Promise<unknown>;
  cycleMinutes: number;
  checkIntervalMs?: number;
  /** 장 열림→닫힘 전환 시 1회 호출 — 미체결 지정가 취소 등 (스펙 §6) */
  onMarketClose?: () => void;
}

/** 장중에만 cycleMinutes 간격으로 runFn 실행. 반환된 함수로 정지. */
export function startScheduler(opts: SchedulerOptions): () => void {
  const checkInterval = opts.checkIntervalMs ?? 30_000;
  let lastRun = 0;
  let running = false;
  let wasOpen = false;

  const timer = setInterval(async () => {
    if (running) return; // 이전 사이클이 아직 도는 중이면 건너뜀
    try {
      running = true;
      const open = await opts.isMarketOpen(new Date());
      if (!open) {
        if (wasOpen) {
          try {
            opts.onMarketClose?.();
            wasOpen = false; // 성공 시에만 전환 완료
          } catch (err) {
            console.error('[scheduler] onMarketClose 실패 — 다음 틱에 재시도:', err);
          }
        } else {
          wasOpen = false;
        }
        return;
      }
      wasOpen = true;
      if (Date.now() - lastRun < opts.cycleMinutes * 60_000) return;
      await opts.runFn();
      lastRun = Date.now(); // runFn 완료 후 갱신 — 실패 시 다음 틱에 즉시 재시도 (의도된 동작)
    } catch (err) {
      console.error('[scheduler] 사이클 오류:', err);
    } finally {
      running = false;
    }
  }, checkInterval);

  return () => clearInterval(timer);
}
