import { describe, it, expect, vi } from 'vitest';
import {
  analyzeHolding,
  buildSynthesisPrompt,
  CompanyVerdictSchema,
  type PanelDeps,
} from '../src/research/panel.js';
import type { LensVerdict } from '../src/research/masters.js';

const lensJson = (lens: string, score: number): string =>
  JSON.stringify({
    lens, score, confidence: 'B',
    bull: ['근거A'], bear: ['리스크B'],
    conclusion: '결론', invalidation: '반증조건',
  });

const synthesisJson = JSON.stringify({
  verdict: 'conditional',
  stars: 3,
  positionAdvice: 'hold',
  targetLow: 60000,
  targetHigh: 90000,
  confidence: 'B',
  bull: ['해자 견고'],
  bear: ['사이클 둔화'],
  summary: '저평가지만 단기 모멘텀 부재',
  invalidation: 'ROE 두 자릿수 붕괴',
});

const H = { name: '삼성전자', symbol: '005930', currentPrice: 72000, infoTier: 'A' as const };

describe('panel — analyzeHolding', () => {
  it('4 렌즈를 병렬 호출하고 종합 판정을 만든다', async () => {
    const runLens = vi.fn(async (prompt: string) => {
      // 프롬프트에 lens key가 들어있으니 그걸로 응답을 구성
      const m = prompt.match(/"lens": "(business|financial|industry|risk)"/);
      return lensJson(m![1]!, 4);
    });
    const runSynthesis = vi.fn(async () => synthesisJson);
    const deps: PanelDeps = { runLens, runSynthesis };

    const a = await analyzeHolding(H, deps);
    expect(runLens).toHaveBeenCalledTimes(4);
    expect(runSynthesis).toHaveBeenCalledTimes(1);
    expect(Object.keys(a.lenses)).toHaveLength(4);
    expect(a.verdict?.verdict).toBe('conditional');
    expect(a.verdict?.positionAdvice).toBe('hold');
  });

  it('일부 렌즈가 깨진 응답이면 결측 처리하되 나머지로 종합한다', async () => {
    const runLens = vi.fn(async (prompt: string) => {
      if (prompt.includes('"lens": "risk"')) return '쓰레기 응답 — JSON 없음';
      const m = prompt.match(/"lens": "(business|financial|industry)"/);
      return lensJson(m![1]!, 3);
    });
    const runSynthesis = vi.fn(async () => synthesisJson);
    const a = await analyzeHolding(H, { runLens, runSynthesis });
    expect(Object.keys(a.lenses)).toHaveLength(3);
    expect(a.lenses.risk).toBeUndefined();
    expect(a.verdict).not.toBeNull();
    expect(runSynthesis).toHaveBeenCalledTimes(1);
  });

  it('모든 렌즈가 실패하면 종합을 호출하지 않고 verdict=null', async () => {
    const runLens = vi.fn(async () => '전부 깨짐');
    const runSynthesis = vi.fn(async () => synthesisJson);
    const a = await analyzeHolding(H, { runLens, runSynthesis });
    expect(Object.keys(a.lenses)).toHaveLength(0);
    expect(a.verdict).toBeNull();
    expect(runSynthesis).not.toHaveBeenCalled();
  });
});

describe('panel — buildSynthesisPrompt', () => {
  it('각 렌즈 판정과 종목·JSON 형식을 포함한다', () => {
    const verdicts: Partial<Record<string, LensVerdict>> = {
      financial: JSON.parse(lensJson('financial', 4)),
      business: JSON.parse(lensJson('business', 5)),
    };
    const p = buildSynthesisPrompt(H, verdicts as never);
    expect(p).toContain('삼성전자');
    expect(p).toContain('financial');
    expect(p).toContain('positionAdvice');
    expect(p).toMatch(/JSON/i);
  });
});

describe('panel — CompanyVerdictSchema', () => {
  it('정상 종합 판정 통과', () => {
    expect(() => CompanyVerdictSchema.parse(JSON.parse(synthesisJson))).not.toThrow();
  });
  it('verdict enum 위반 거부', () => {
    expect(() => CompanyVerdictSchema.parse({ ...JSON.parse(synthesisJson), verdict: 'buy' })).toThrow();
  });
  it('positionAdvice enum 위반 거부', () => {
    expect(() => CompanyVerdictSchema.parse({ ...JSON.parse(synthesisJson), positionAdvice: 'moon' })).toThrow();
  });
});
