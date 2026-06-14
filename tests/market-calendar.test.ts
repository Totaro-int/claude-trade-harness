import { describe, it, expect } from 'vitest';
import { isTradingDay, buildHolidaySet, KRX_HOLIDAYS_DEFAULT } from '../src/core/market-calendar.js';

// 정오 UTC를 쓰면 KST(+9) 변환이 같은 날짜로 안정적이다.
const noonUtc = (ymd: string): Date => new Date(`${ymd}T03:00:00Z`); // 12:00 KST

describe('isTradingDay', () => {
  const holidays = buildHolidaySet();

  it('평일은 거래일', () => {
    // 2026-06-15는 월요일
    expect(isTradingDay(noonUtc('2026-06-15'), holidays)).toBe(true);
  });

  it('주말(토/일)은 휴장', () => {
    expect(isTradingDay(noonUtc('2026-06-13'), holidays)).toBe(false); // 토
    expect(isTradingDay(noonUtc('2026-06-14'), holidays)).toBe(false); // 일
  });

  it('기본 휴장일(신정·연말폐장)은 휴장', () => {
    expect(isTradingDay(noonUtc('2026-01-01'), holidays)).toBe(false);
    expect(isTradingDay(noonUtc('2026-12-31'), holidays)).toBe(false);
  });

  it('config 추가 휴장일을 반영한다', () => {
    const extra = buildHolidaySet(['2026-06-15']); // 임시공휴일 가정
    expect(isTradingDay(noonUtc('2026-06-15'), extra)).toBe(false);
  });

  it('기본 표는 모두 YYYY-MM-DD 형식이다', () => {
    expect(KRX_HOLIDAYS_DEFAULT.every(d => /^\d{4}-\d{2}-\d{2}$/.test(d))).toBe(true);
  });
});
