/**
 * KRX(한국거래소) 거래일 판정 — 주말·공휴일·연말 폐장을 휴장으로 본다.
 * 어댑터의 장중 시간(09:00~15:30) 판정과 별개로 "오늘이 거래일인가"만 책임진다.
 * scheduler에서 `isTradingDay() && adapter.isMarketOpen()`로 합쳐 쓴다.
 */

const kstYmd = (d: Date): string => d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
const kstWeekday = (d: Date): string =>
  d.toLocaleDateString('en-US', { timeZone: 'Asia/Seoul', weekday: 'short' });

/**
 * KRX 휴장일(YYYY-MM-DD, KST). 음력 연휴(설·추석)·대체공휴일·연말 폐장을 포함한다.
 * ⚠️ 음력/대체/임시공휴일·선거일은 매년 달라지므로 **공식 KRX 휴장일 캘린더로 검증·갱신**해야 한다.
 * (주말은 자동 제외되므로 토/일에 걸린 공휴일은 표에 없어도 무방.) 추가/임시 휴장일은 config.holidays로 보강.
 */
export const KRX_HOLIDAYS_DEFAULT: readonly string[] = [
  // 2026 (검증 필요)
  '2026-01-01', // 신정
  '2026-02-16', // 설날 연휴
  '2026-02-17', // 설날
  '2026-02-18', // 설날 연휴
  '2026-03-02', // 삼일절 대체(3/1 일)
  '2026-05-01', // 근로자의 날
  '2026-05-05', // 어린이날
  '2026-05-25', // 부처님오신날 대체(5/24 일)
  '2026-08-17', // 광복절 대체(8/15 토)
  '2026-09-24', // 추석 연휴
  '2026-09-25', // 추석
  '2026-10-05', // 개천절 대체(10/3 토)
  '2026-10-09', // 한글날
  '2026-12-25', // 성탄절
  '2026-12-31', // 연말 폐장
  // 2027 (검증 필요 — 우선 신정만)
  '2027-01-01', // 신정
];

/** 기본 휴장일 + 추가 휴장일(config.holidays)로 집합을 만든다. */
export function buildHolidaySet(extra: readonly string[] = []): ReadonlySet<string> {
  return new Set<string>([...KRX_HOLIDAYS_DEFAULT, ...extra]);
}

/** KST 기준 주말·휴장일이 아니면 거래일(true). */
export function isTradingDay(date: Date, holidays: ReadonlySet<string>): boolean {
  const wd = kstWeekday(date);
  if (wd === 'Sat' || wd === 'Sun') return false;
  return !holidays.has(kstYmd(date));
}
