/** 생성된 어댑터 소스의 금지 패턴 검사. 위반 사유 목록 반환 (빈 배열 = 통과). */
const BANNED: Array<[RegExp, string]> = [
  [/\brequire\s*\(/, 'require() 금지'],
  [/\bimport\s*\(/, '동적 import 금지'],
  [/^\s*import\s+(?!type\b)/m, 'import type 외의 import 금지 (런타임 기능은 주입된 http만 사용)'],
  [/\beval\s*\(/, 'eval 금지'],
  [/new\s+Function/, 'new Function 금지'],
  [/\bprocess\b/, 'process 접근 금지 (시크릿은 env 인자로 주입됨)'],
  [/\bfetch\s*\(/, '직접 fetch 금지 (주입된 http 클라이언트만 사용)'],
  [/child_process|node:fs|\bfs\.|node:net|node:dns|XMLHttpRequest|WebSocket/, '시스템/네트워크 모듈 금지'],
  [/globalThis/, 'globalThis 접근 금지'],
];

export function checkAdapterSource(src: string, secrets: string[]): string[] {
  const violations: string[] = [];
  for (const [re, reason] of BANNED) if (re.test(src)) violations.push(reason);
  for (const s of secrets) {
    if (s.length >= 6 && src.includes(s)) violations.push('시크릿 값이 코드에 하드코딩됨');
  }
  if (!/export\s+function\s+createAdapter\s*\(/.test(src)) {
    violations.push('export function createAdapter(env, http) 누락');
  }
  return violations;
}
