import type { AppConfig, GuardrailLimits } from '../core/config.js';
import type { BrainOutput, Candle, UniverseEntry } from '../core/types.js';
import { runBacktest, type BacktestReport } from './runner.js';

/** 한 변형 = 기준(base) 대비 전략문서/설정 오버라이드. 같은 캔들·브레인으로 비교된다. */
export interface EvalVariant {
  label: string;
  strategyDocs?: string;                                              // 미지정 시 base 사용
  config?: Omit<Partial<AppConfig>, 'guardrails'> & { guardrails?: Partial<GuardrailLimits> };
}

export interface EvalSharedInput {
  candlesBySymbol: Map<string, Candle[]>;
  universe: UniverseEntry[];
  baseConfig: AppConfig;
  baseStrategyDocs: string;
  brain: (prompt: string) => Promise<BrainOutput>;
  startIndex?: number;
  onVariant?: (label: string, report: BacktestReport) => void;
}

export interface EvalResult { label: string; report: BacktestReport }
export interface EvalReport { results: EvalResult[]; best: string | null }   // results는 초과수익 내림차순

/** base 설정에 변형 오버라이드를 병합 (guardrails는 중첩 병합). */
function mergeConfig(base: AppConfig, override?: EvalVariant['config']): AppConfig {
  if (!override) return base;
  return {
    ...base,
    ...override,
    guardrails: { ...base.guardrails, ...(override.guardrails ?? {}) },
  };
}

/**
 * 여러 변형을 동일 캔들·동일 브레인으로 백테스트하고 초과수익으로 정렬한다.
 * - 변형은 순차 실행한다 (LLM 브레인을 병렬로 두드리지 않기 위함).
 * - 주의: 실제 LLM 브레인은 비결정적이므로 변형 간 비교에는 노이즈가 섞인다. 막대 수를 늘려 완화하라.
 */
export async function runEval(shared: EvalSharedInput, variants: EvalVariant[]): Promise<EvalReport> {
  if (variants.length === 0) throw new Error('평가할 변형이 없습니다');
  const labels = new Set<string>();
  for (const v of variants) {
    if (labels.has(v.label)) throw new Error(`변형 라벨 중복: ${v.label}`);
    labels.add(v.label);
  }

  const results: EvalResult[] = [];
  for (const v of variants) {
    const report = await runBacktest({
      candlesBySymbol: shared.candlesBySymbol,
      universe: shared.universe,
      config: mergeConfig(shared.baseConfig, v.config),
      strategyDocs: v.strategyDocs ?? shared.baseStrategyDocs,
      brain: shared.brain,
      startIndex: shared.startIndex,
    });
    results.push({ label: v.label, report });
    shared.onVariant?.(v.label, report);
  }

  results.sort((a, b) => b.report.excessPct - a.report.excessPct);
  return { results, best: results[0]?.label ?? null };
}
