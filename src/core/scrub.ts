/** 에러/임의 값에서 사람이 읽을 메시지를 뽑는다. */
export const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** 각 시크릿(6자 이상)을 '[REDACTED]'로 교체한다. 로그·DB·응답에 시크릿이 새지 않도록 경계에서 적용. */
export function scrub(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s.length >= 6) out = out.replaceAll(s, '[REDACTED]');
  }
  return out;
}
