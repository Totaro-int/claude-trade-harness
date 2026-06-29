import { describe, it, expect } from 'vitest';
import {
  LENSES,
  LENS_KEYS,
  ANTI_BIAS_PREAMBLE,
  buildLensPrompt,
  LensVerdictSchema,
  parseLensVerdict,
} from '../src/research/masters.js';

describe('masters — 렌즈 정의', () => {
  it('4대가 렌즈가 올바른 마스터에 매핑된다', () => {
    expect(LENS_KEYS).toEqual(['business', 'financial', 'industry', 'risk']);
    expect(LENSES.business.masterKo).toContain('돤융핑');
    expect(LENSES.financial.masterKo).toContain('버핏');
    expect(LENSES.industry.masterKo).toContain('멍거');
    expect(LENSES.risk.masterKo).toContain('리루');
  });
});

describe('masters — buildLensPrompt', () => {
  const h = { name: '삼성전자', symbol: '005930', currentPrice: 72000, infoTier: 'A' as const };

  it('anti-bias 프리앰블·종목·렌즈 역할·JSON 형식을 포함한다', () => {
    const p = buildLensPrompt(LENSES.financial, h);
    expect(p).toContain(ANTI_BIAS_PREAMBLE);
    expect(p).toContain('삼성전자');
    expect(p).toContain('005930');
    expect(p).toContain('버핏');
    expect(p).toContain('안전마진'); // 재무 렌즈 분석축
    expect(p).toMatch(/JSON/i);
    expect(p).toContain('invalidation');
  });

  it('정보충실도 등급별 연구전략을 주입한다', () => {
    const a = buildLensPrompt(LENSES.business, { ...h, infoTier: 'A' });
    const c = buildLensPrompt(LENSES.business, { ...h, infoTier: 'C' });
    expect(a).toContain('반면 검증'); // A급: 반면검증·비합의
    expect(c).toContain('제일원리'); // C급: 제일원리 모드
  });
});

describe('masters — LensVerdictSchema', () => {
  const good = {
    lens: 'financial',
    score: 4,
    confidence: 'B',
    bull: ['ROE 20%대 유지'],
    bear: ['반도체 사이클 둔화'],
    conclusion: '저평가 구간',
    invalidation: 'ROE 10% 이하로 2분기 연속 하락 시 논지 폐기',
  };

  it('정상 판정을 통과시킨다', () => {
    expect(() => LensVerdictSchema.parse(good)).not.toThrow();
  });

  it('score 범위(1~5) 위반을 거부한다', () => {
    expect(() => LensVerdictSchema.parse({ ...good, score: 6 })).toThrow();
  });

  it('반대 논거(bear) 누락을 거부한다 — 정반양면 강제', () => {
    expect(() => LensVerdictSchema.parse({ ...good, bear: [] })).toThrow();
  });

  it('confidence는 A/B/C만 허용', () => {
    expect(() => LensVerdictSchema.parse({ ...good, confidence: 'D' })).toThrow();
  });
});

describe('masters — parseLensVerdict', () => {
  it('설명 텍스트에 둘러싸인 JSON을 추출한다', () => {
    const text = '분석 결과입니다:\n```json\n{"lens":"risk","score":3,"confidence":"C","bull":["x"],"bear":["y"],"conclusion":"중립","invalidation":"z"}\n```\n끝.';
    const v = parseLensVerdict(text);
    expect(v?.lens).toBe('risk');
    expect(v?.score).toBe(3);
  });

  it('파싱 실패 시 null', () => {
    expect(parseLensVerdict('JSON 없음')).toBeNull();
  });
});
