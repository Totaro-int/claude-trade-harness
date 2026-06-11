import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { createHttpClient } from '../setup/http-client.js';
import { wrapAdapter, type AdapterEnv, type BrokerAdapter } from './adapter.js';

/**
 * 생성된 어댑터 모듈을 로드해 http 주입 + zod 래핑.
 * tsx 런타임에서는 .ts 직접 import 가능. 경로는 adapter.ts 또는 adapter.mjs.
 */
export async function loadAdapter(path: string, env: AdapterEnv): Promise<BrokerAdapter> {
  if (!existsSync(path)) throw new Error(`어댑터 파일 없음: ${path}`);
  const mod = await import(pathToFileURL(path).href) as { createAdapter?: (env: AdapterEnv, http: unknown) => BrokerAdapter };
  if (typeof mod.createAdapter !== 'function') throw new Error('어댑터에 createAdapter export가 없습니다');
  const http = createHttpClient(env.baseUrl);
  return wrapAdapter(mod.createAdapter(env, http));
}
