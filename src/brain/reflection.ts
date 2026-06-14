import type { Position, Reflection } from '../core/types.js';

/** 프롬프트·KV에 보관하는 회고 개수 상한. */
export const REFLECTION_LIMIT = 20;

/**
 * 청산되는(또는 줄어드는) 포지션에서 thesis 결과를 채점한다.
 * thesis가 없으면 채점 불가 → null.
 * @param pos      청산 직전의 포지션 스냅샷 (avgPrice·thesis·openedAt 보존본)
 * @param exitPrice 매도 체결가
 * @param now       청산 시각
 */
export function buildReflection(pos: Position, exitPrice: number, now: Date): Reflection | null {
  if (!pos.thesis) return null;
  if (!Number.isFinite(pos.avgPrice) || pos.avgPrice <= 0 || !Number.isFinite(exitPrice) || exitPrice <= 0) return null;

  const pnlPct = Number((((exitPrice / pos.avgPrice) - 1) * 100).toFixed(2));
  let heldHours = 0;
  if (pos.openedAt) {
    const opened = new Date(pos.openedAt).getTime();
    if (Number.isFinite(opened)) {
      heldHours = Math.max(0, Math.round((now.getTime() - opened) / 3_600_000));
    }
  }
  return {
    ts: now.toISOString(),
    symbol: pos.symbol, name: pos.name,
    why: pos.thesis.why, target: pos.thesis.target, stop: pos.thesis.stop,
    entryPrice: pos.avgPrice, exitPrice,
    pnlPct, heldHours,
    result: pnlPct >= 0 ? 'WIN' : 'LOSS',
  };
}

/** 회고 목록을 프롬프트용 한 줄 요약 배열로 변환 (최신순 호출자 책임). */
export function formatReflections(list: Reflection[]): string[] {
  return list.map(r =>
    `${r.name}(${r.symbol}) ${r.result} ${r.pnlPct >= 0 ? '+' : ''}${r.pnlPct}% · 보유 ${r.heldHours}h · 근거 "${r.why}" / 목표 ${r.target} 손절 ${r.stop}`,
  );
}
