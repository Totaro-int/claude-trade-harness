import type { Store } from '../core/store.js';

/**
 * 라이브 3중 잠금: ① config mode=live ② CLAUDE_TRADE_LIVE=1 ③ 대시보드 계좌 끝4자리 확인(KV liveConfirmed).
 * 하나라도 빠지면 throw — submitOrder 경로는 이 함수를 통과해야만 실행된다.
 */
export function assertLiveUnlocked(
  mode: string,
  envFlag: string | undefined,
  store: Pick<Store, 'getKV'>,
): void {
  if (mode !== 'live') throw new Error('라이브 잠금: config.json mode가 live가 아닙니다');
  if (envFlag !== '1') throw new Error('라이브 잠금: 환경변수 CLAUDE_TRADE_LIVE=1 필요');
  if (store.getKV('liveConfirmed') !== '1') throw new Error('라이브 잠금: 대시보드에서 계좌 확인 필요');
}
