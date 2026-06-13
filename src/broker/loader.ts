import { pathToFileURL } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { createHttpClient } from '../setup/http-client.js';
import { wrapAdapter, type AdapterEnv, type BrokerAdapter } from './adapter.js';
import { checkAdapterSource } from '../setup/static-check.js';

/** 오염 감시 대상 프로토타입들. */
const WATCHED_PROTOTYPES = [Object.prototype, Array.prototype, String.prototype];

/** 각 감시 프로토타입의 own-property 개수 스냅샷. */
export function snapshotPrototypes(): number[] {
  return WATCHED_PROTOTYPES.map((p) => Object.getOwnPropertyNames(p).length);
}

/**
 * import/eval 시점 프로토타입 오염 감지. before 스냅샷 대비 own-property가
 * 늘어났으면 throw. (메서드 본문 호출 시점 오염은 static-check가 커버하는 잔여 위험.)
 */
export function assertNoPrototypePollution(before: number[]): void {
  const after = snapshotPrototypes();
  for (let i = 0; i < after.length; i++) {
    if (after[i]! > before[i]!) {
      throw new Error('어댑터 로드 거부 — 프로토타입 오염 감지');
    }
  }
}

/**
 * 생성된 어댑터 모듈을 로드해 http 주입 + zod 래핑.
 * tsx 런타임에서는 .ts 직접 import 가능. 경로는 adapter.ts 또는 adapter.mjs.
 */
export async function loadAdapter(path: string, env: AdapterEnv): Promise<BrokerAdapter> {
  if (!existsSync(path)) throw new Error(`어댑터 파일 없음: ${path}`);
  const src = readFileSync(path, 'utf8');
  const violations = checkAdapterSource(src, [env.apiKey, env.apiSecret, env.accountNo]);
  if (violations.length > 0) throw new Error(`어댑터 로드 거부 — 정적 검사 위반: ${violations.join(', ')}`);
  // 방어 심층화: 모듈 평가 시점(import + createAdapter 호출)의 프로토타입 오염을 감사.
  const before = snapshotPrototypes();
  const mod = await import(pathToFileURL(path).href) as { createAdapter?: (env: AdapterEnv, http: unknown) => BrokerAdapter };
  if (typeof mod.createAdapter !== 'function') throw new Error('어댑터에 createAdapter export가 없습니다');
  const http = createHttpClient(env.baseUrl);
  const wrapped = wrapAdapter(mod.createAdapter(env, http));
  assertNoPrototypePollution(before);
  return wrapped;
}
