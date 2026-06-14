import { describe, it, expect } from 'vitest';
import { buildSkepticPrompt, parseSkepticVerdict, type SkepticInput } from '../src/brain/skeptic.js';

const input: SkepticInput = {
  symbol: '005930', name: '삼성전자', quantity: 10, reasoning: '반등 기대',
  thesis: { why: '저점 매수', target: '+6%', stop: '-3%', exitCondition: '20일선 이탈' },
  marketView: '약세 반등',
  quote: { symbol: '005930', name: '삼성전자', price: 71000, bid: 70900, ask: 71100, changeRate: 1.4, volume: 1000 },
  indicator: { symbol: '005930', ma5: 70500, ma20: 69800, change5d: 2.1, rsi14: 72, atrPct: 1.8, drawdownPct: 3.2 },
  strategyDocs: '저평가 우량주 분할매수',
};

describe('buildSkepticPrompt', () => {
  it('매수 대상·thesis·지표·전략이 모두 포함된다', () => {
    const p = buildSkepticPrompt(input);
    expect(p).toContain('삼성전자(005930)');
    expect(p).toContain('저점 매수');     // thesis.why
    expect(p).toContain('RSI 72');        // 지표
    expect(p).toContain('저평가 우량주');  // 전략 문서
    expect(p).toContain('"refute"');      // 출력 스키마
  });
});

describe('parseSkepticVerdict', () => {
  it('정상 JSON 파싱', () => {
    expect(parseSkepticVerdict('판단: {"refute": true, "reason": "과매수"}')).toEqual({ refute: true, reason: '과매수' });
  });

  it('JSON 없으면 통과(fail-open)', () => {
    expect(parseSkepticVerdict('주절주절 설명만').refute).toBe(false);
  });

  it('형식 오류(타입 불일치)면 통과(fail-open)', () => {
    expect(parseSkepticVerdict('{"refute": "yes"}').refute).toBe(false);
  });
});
