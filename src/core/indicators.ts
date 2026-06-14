import type { Candle, IndicatorRow } from './types.js';

/** 지표 산출에 필요한 최소 캔들 수 (ma5/change5d). */
export const MIN_CANDLES = 6;

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * RSI(14) — 단순평균(Cutler) 방식. Wilder의 지수평활 RSI가 아니므로 추세장에서 수 포인트 어긋날 수 있다.
 * 프롬프트의 70/30 임계는 이 단순평균 기준으로 해석할 것. 캔들이 부족하면(<15) undefined.
 */
function rsi14(closes: number[]): number | undefined {
  if (closes.length < 15) return undefined;
  const deltas: number[] = [];
  for (let i = closes.length - 14; i < closes.length; i++) deltas.push(closes[i]! - closes[i - 1]!);
  const gains = mean(deltas.map(d => Math.max(d, 0)));
  const losses = mean(deltas.map(d => Math.max(-d, 0)));
  if (losses === 0) return gains === 0 ? 50 : 100;
  const rs = gains / losses;
  return Number((100 - 100 / (1 + rs)).toFixed(1));
}

/** ATR(14)을 현재가 대비 %로. 캔들이 부족하면 undefined. */
function atrPct(candles: Candle[]): number | undefined {
  if (candles.length < 15) return undefined;
  const trs: number[] = [];
  for (let i = candles.length - 14; i < candles.length; i++) {
    const c = candles[i]!, prevClose = candles[i - 1]!.close;
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose)));
  }
  const atr = mean(trs);
  const last = candles.at(-1)!.close;
  if (!(last > 0)) return undefined;
  return Number(((atr / last) * 100).toFixed(2));
}

/** 최근 20봉 고점 대비 낙폭(%, ≥0). */
function drawdownPct(closes: number[]): number {
  const window = closes.slice(-20);
  const peak = Math.max(...window);
  const last = closes.at(-1)!;
  if (!(peak > 0)) return 0;
  return Number((Math.max(0, (peak - last) / peak) * 100).toFixed(2));
}

/**
 * 캔들 시계열(과거→현재, 마지막이 최신)에서 지표를 산출한다.
 * cycle.ts와 backtest/runner.ts가 공유한다 (수식 발산 방지).
 * @returns symbol을 제외한 지표 필드. 캔들 부족(<6) 시 null.
 */
export function computeIndicatorRow(candles: Candle[]): Omit<IndicatorRow, 'symbol'> | null {
  const closes = candles.map(c => c.close);
  if (closes.length < MIN_CANDLES) return null;
  const ma = (n: number) => Math.round(mean(closes.slice(-n)));
  return {
    ma5: ma(5),
    ma20: closes.length >= 20 ? ma(20) : undefined,
    change5d: Number(((closes.at(-1)! / closes.at(-6)! - 1) * 100).toFixed(2)),
    rsi14: rsi14(closes),
    atrPct: atrPct(candles),
    drawdownPct: drawdownPct(closes),
    volume: candles.at(-1)!.volume,
  };
}
