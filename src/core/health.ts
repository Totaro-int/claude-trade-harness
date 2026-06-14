import type { Store } from './store.js';

/**
 * 무인 운영용 heartbeat — 사이클 성공/실패를 KV에 영속해 외부(/health·대시보드·워치독)가
 * "살아있고 건강한가"를 판별할 수 있게 한다. 라이브 사이클 전용(실시간 시계).
 */
export interface HealthState {
  startedAt: string;             // 현재 프로세스 시작 시각(ISO)
  lastCycleStartAt: string | null;
  lastCycleOkAt: string | null;
  lastCycleErrorAt: string | null;
  lastError: string | null;      // 스크럽된 메시지(300자 제한)
  consecutiveFailures: number;
  cyclesOk: number;              // 누적(재시작 간 보존)
  cyclesFailed: number;
}

const KEY = 'health';
const ERROR_MAX = 300;

/** 연속 실패가 이 값 이상이면 unhealthy로 본다. */
export const FAILURE_THRESHOLD = 3;

/** 사이클이 시작됐는데 이 시간 넘게 완료(성공/실패) 신호가 없으면 '멈춤 의심'으로 본다. */
export const MAX_CYCLE_MS_DEFAULT = 10 * 60_000;

function read(store: Store): HealthState | null {
  const raw = store.getKV(KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as HealthState;
  } catch {
    return null;
  }
}

function write(store: Store, state: HealthState): void {
  store.setKV(KEY, JSON.stringify(state));
}

function blank(now: Date): HealthState {
  return {
    startedAt: now.toISOString(),
    lastCycleStartAt: null, lastCycleOkAt: null, lastCycleErrorAt: null,
    lastError: null, consecutiveFailures: 0, cyclesOk: 0, cyclesFailed: 0,
  };
}

export function readHealth(store: Store): HealthState | null {
  return read(store);
}

/** 프로세스 시작 시 호출 — startedAt만 갱신하고 누적 카운터·마지막 상태는 보존. */
export function initHealth(store: Store, now: Date): void {
  const prev = read(store);
  write(store, { ...(prev ?? blank(now)), startedAt: now.toISOString() });
}

export function recordCycleStart(store: Store, now: Date): void {
  const s = read(store) ?? blank(now);
  write(store, { ...s, lastCycleStartAt: now.toISOString() });
}

export function recordCycleOk(store: Store, now: Date): void {
  const s = read(store) ?? blank(now);
  write(store, {
    ...s,
    lastCycleOkAt: now.toISOString(),
    lastError: null,
    consecutiveFailures: 0,
    cyclesOk: s.cyclesOk + 1,
  });
}

export function recordCycleError(store: Store, now: Date, message: string): void {
  const s = read(store) ?? blank(now);
  write(store, {
    ...s,
    lastCycleErrorAt: now.toISOString(),
    lastError: message.slice(0, ERROR_MAX),
    consecutiveFailures: s.consecutiveFailures + 1,
    cyclesFailed: s.cyclesFailed + 1,
  });
}

export interface HealthReport {
  healthy: boolean;
  status: 'starting' | 'ok' | 'degraded';
  reason: string | null;
  uptimeMs: number;
  msSinceLastOk: number | null;
  state: HealthState;
}

/**
 * 순수 평가 — 연속 실패 임계 + 멈춤(시작 후 미완료) 감지. 휴장 중엔 사이클이 없으니 staleness는 보지 않는다.
 * 멈춤 감지는 "사이클이 시작됐으나 maxCycleMs 넘게 완료 신호가 없음"으로 판정 — running 고착을 외부에서 잡는다.
 */
export function evaluateHealth(
  state: HealthState | null,
  now: Date,
  opts: { maxCycleMs?: number } = {},
): HealthReport {
  const s = state ?? blank(now);
  const maxCycleMs = opts.maxCycleMs ?? MAX_CYCLE_MS_DEFAULT;
  const msSinceLastOk = s.lastCycleOkAt ? now.getTime() - new Date(s.lastCycleOkAt).getTime() : null;
  const uptimeMs = now.getTime() - new Date(s.startedAt).getTime();

  if (s.consecutiveFailures >= FAILURE_THRESHOLD) {
    return { healthy: false, status: 'degraded', reason: `연속 ${s.consecutiveFailures}회 사이클 실패`, uptimeMs, msSinceLastOk, state: s };
  }

  // 멈춤 의심: 마지막 시작이 마지막 완료(성공/실패)보다 뒤이고, 그 후 maxCycleMs 초과
  const lastDone = Math.max(
    s.lastCycleOkAt ? new Date(s.lastCycleOkAt).getTime() : 0,
    s.lastCycleErrorAt ? new Date(s.lastCycleErrorAt).getTime() : 0,
  );
  const startedAt = s.lastCycleStartAt ? new Date(s.lastCycleStartAt).getTime() : 0;
  if (startedAt > lastDone && now.getTime() - startedAt > maxCycleMs) {
    const mins = Math.round((now.getTime() - startedAt) / 60_000);
    return { healthy: false, status: 'degraded', reason: `사이클 멈춤 의심 (${mins}분째 미완료)`, uptimeMs, msSinceLastOk, state: s };
  }

  if (!s.lastCycleOkAt && s.cyclesFailed === 0) {
    return { healthy: true, status: 'starting', reason: null, uptimeMs, msSinceLastOk, state: s };
  }
  return { healthy: true, status: 'ok', reason: null, uptimeMs, msSinceLastOk, state: s };
}
