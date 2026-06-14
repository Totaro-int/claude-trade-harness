import { readFileSync, existsSync } from 'node:fs';

export interface GuardrailLimits {
  maxPositionPct: number;       // 종목당 최대 비중 (정수 %)
  maxOrderPct: number;          // 1회 주문 금액 상한 (정수 %)
  maxOrdersPerCycle: number;
  dailyLossLimitPct: number;    // 양수로 표기 (3 = -3% 도달 시)
  maxOrdersPerDay: number;
  reentryCooldownMin: number;   // 매도 후 동일 종목 재매수 금지 시간(분)
  maxTotalExposurePct: number;  // 총 주식 노출 상한 (정수 %)
  // 이익 실현 매도의 최소 보유시간(분). 회전율(잦은 매매 → 수수료 손실) 억제용.
  // 손절(평가손) 매도는 항상 면제 — 리스크 관리 경로는 절대 막지 않는다. 기본 0 = 비활성.
  minHoldMin: number;
}

export interface AppConfig {
  mode: 'paper' | 'live';
  brokerId: string;             // adapters/<brokerId>/ — 빈 문자열이면 미설정(온보딩 모드)
  initialCash: number;
  feeRate: number;
  taxRate: number;
  halfSpreadPct: number;        // bid==ask 폴백 시 적용할 half-spread (소수, 0.0005 = 0.05%)
  cycleMinutes: number;
  // 지표(getCandles) 데이터가 없으면 매매를 건너뛴다. lastPrice-only 매매는 검증된 우위가 없고
  // 수수료만 까먹는 노이즈 트레이딩이므로 기본 차단(true).
  requireIndicators: boolean;
  // 청산된 매매의 thesis 결과를 회고로 누적해 프롬프트에 주입한다(과거 매매에서 학습). 기본 true.
  reflection: boolean;
  // BUY 결정에 2차 '회의론자' 반박 검토를 거친다(돌이킬 수 없는 매수만 한 번 더 검증). 매수마다 claude 1회 추가 호출.
  // 기본 false (비용 발생). 백테스트에는 적용되지 않는다.
  skepticGate: boolean;
  guardrails: GuardrailLimits;
  claudeCmd: string;
  dbPath: string;
  port: number;
  // 기본 KRX 휴장일에 더해 보강할 추가 휴장일(YYYY-MM-DD, KST). 임시공휴일·선거일 등. 선택.
  holidays?: string[];
  // 운영 알림 webhook(Slack/Discord/generic). 미지정 시 로컬 알림(콘솔·macOS)만. 선택.
  alertWebhook?: string;
  // decisions·snapshots 보존 일수. 장마감마다 이보다 오래된 행 정리. 미지정 시 90일. 선택.
  retentionDays?: number;
}

const DEFAULTS: AppConfig = {
  mode: 'paper',
  brokerId: '',
  initialCash: 10_000_000,
  feeRate: 0.00015,
  taxRate: 0.0018,
  halfSpreadPct: 0.0005,
  cycleMinutes: 30,
  requireIndicators: true,
  reflection: true,
  skepticGate: false,
  guardrails: {
    maxPositionPct: 20,
    maxOrderPct: 10,
    maxOrdersPerCycle: 3,
    dailyLossLimitPct: 3,
    maxOrdersPerDay: 10,
    reentryCooldownMin: 60,
    maxTotalExposurePct: 80,
    minHoldMin: 0,
  },
  claudeCmd: 'claude',
  dbPath: 'data/state.db',
  port: 3000,
};

export function loadConfig(path = 'config.json'): AppConfig {
  if (!existsSync(path)) return structuredClone(DEFAULTS);
  let file: Partial<AppConfig>;
  try {
    file = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    throw new Error(`설정 파일이 올바른 JSON이 아닙니다 (${path}): ${(err as Error).message}`);
  }
  const merged: AppConfig = {
    ...structuredClone(DEFAULTS),
    ...file,
    guardrails: { ...DEFAULTS.guardrails, ...(file.guardrails ?? {}) },
  };
  // claudeCmd는 execFile로 그대로 실행되는 바이너리명/경로 — 셸 메타문자·공백을 막아
  // config.json이 임의 바이너리(예: curl) 실행으로 우회되는 것을 방지한다.
  if (!/^[A-Za-z0-9_./-]+$/.test(merged.claudeCmd)) {
    throw new Error(`config.json의 claudeCmd에 허용되지 않는 문자가 있습니다: ${JSON.stringify(merged.claudeCmd)}`);
  }
  return merged;
}

export function isConfigured(path = 'config.json'): boolean {
  return existsSync(path) && loadConfig(path).brokerId !== '';
}
