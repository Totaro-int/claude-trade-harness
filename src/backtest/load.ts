import { readFileSync, readdirSync, existsSync, realpathSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import type { AppConfig } from '../core/config.js';
import { loadEnvFile } from '../env.js';
import { MockAdapter } from '../broker/mock.js';
import { loadAdapter } from '../broker/loader.js';
import type { BrokerAdapter } from '../broker/adapter.js';
import type { Candle, UniverseEntry } from '../core/types.js';

const ROOT = process.cwd();

export function loadUniverse(): UniverseEntry[] {
  const path = resolve(ROOT, 'strategy', 'universe.json');
  if (!existsSync(path)) {
    throw new Error('strategy/universe.json 파일이 없습니다. 온보딩을 먼저 완료하거나 파일을 생성하세요.');
  }
  let universe: UniverseEntry[];
  try {
    universe = JSON.parse(readFileSync(path, 'utf-8')) as UniverseEntry[];
  } catch (err) {
    throw new Error(`strategy/universe.json 파싱 실패: ${(err as Error).message}`);
  }
  if (!Array.isArray(universe) || !universe.every(u => u && typeof u.symbol === 'string' && typeof u.name === 'string')) {
    throw new Error('strategy/universe.json은 [{"symbol","name"}] 배열이어야 합니다');
  }
  return universe;
}

/** filePath의 실제 경로가 dir 안에 있는지 검증한다 (심볼릭링크로 디렉터리 밖 파일을 읽는 것 차단). */
export function assertWithinDir(filePath: string, dir: string): void {
  const real = realpathSync(filePath);
  const base = realpathSync(dir);
  if (real !== base && !real.startsWith(base + sep)) {
    throw new Error(`허용된 디렉터리 밖의 파일입니다: ${real}`);
  }
}

export function loadStrategyDocs(): string {
  const stratDir = resolve(ROOT, 'strategy');
  if (!existsSync(stratDir)) return '(전략 문서 없음)';
  let files: string[];
  try {
    files = readdirSync(stratDir).filter(f => f.endsWith('.md') || f.endsWith('.txt'));
  } catch {
    return '(전략 문서 없음)';
  }
  if (files.length === 0) return '(전략 문서 없음)';
  return files.map(f => {
    const p = join(stratDir, f);
    assertWithinDir(p, stratDir);
    return readFileSync(p, 'utf-8');
  }).join('\n\n---\n\n');
}

export async function loadBacktestAdapter(config: AppConfig, universe: UniverseEntry[]): Promise<BrokerAdapter> {
  if (config.brokerId === 'mock' || config.brokerId === '') {
    return new MockAdapter(universe);
  }
  const env = loadEnvFile(resolve(ROOT, '.env'));
  const registryPath = resolve(ROOT, 'adapters', 'registry.json');
  let baseUrl = '';
  if (existsSync(registryPath)) {
    try {
      baseUrl = (JSON.parse(readFileSync(registryPath, 'utf-8')) as { baseUrl?: string }).baseUrl ?? '';
    } catch { /* 빈 baseUrl로 진행 */ }
  }
  const adapterPath = resolve(ROOT, 'adapters', config.brokerId, 'adapter.ts');
  const adapter = await loadAdapter(adapterPath, {
    apiKey: env['BROKER_API_KEY'] ?? '', apiSecret: env['BROKER_API_SECRET'] ?? '',
    accountNo: env['BROKER_ACCOUNT_NO'] ?? '', baseUrl,
  });
  await adapter.auth();
  return adapter;
}

/**
 * 유니버스 종목별 일봉을 수집해 인덱스 정렬(가장 짧은 길이로 절삭)한 Map을 반환한다.
 * - getCandles 미구현 어댑터는 호출 전에 거르는 책임이 호출자에게 있다.
 * - 캔들 0개면 throw.
 */
export async function collectCandles(adapter: BrokerAdapter, universe: UniverseEntry[], bars: number): Promise<Map<string, Candle[]>> {
  if (!adapter.getCandles) throw new Error('이 어댑터는 getCandles를 구현하지 않아 백테스트할 수 없습니다.');
  const candlesBySymbol = new Map<string, Candle[]>();
  for (const u of universe) {
    try {
      const c = await adapter.getCandles(u.symbol, 'day', bars);
      if (c.length > 0) candlesBySymbol.set(u.symbol, c);
    } catch (err) {
      console.warn(`${u.symbol} 캔들 조회 실패 — 제외: ${(err as Error).message}`);
    }
  }
  if (candlesBySymbol.size === 0) {
    throw new Error('수집된 캔들이 없습니다. 어댑터/유니버스를 확인하세요.');
  }
  const lengths = [...candlesBySymbol.values()].map(c => c.length);
  const minLen = Math.min(...lengths);
  const maxLen = Math.max(...lengths);
  // 한 종목의 데이터 부족이 전 종목을 조용히 짧게 만드는 것을 운영자가 알아채도록 경고.
  if (minLen < maxLen * 0.8) {
    console.warn(`캔들 길이 불균형: 최단 ${minLen}봉 < 최장 ${maxLen}봉 → 전 종목을 ${minLen}봉으로 절삭합니다. 일부 종목의 데이터 부족 여부를 확인하세요.`);
  }
  // 입력 Map을 변형하지 않고 새 Map 반환 (불변성).
  return new Map([...candlesBySymbol].map(([s, c]) => [s, c.length === minLen ? c : c.slice(c.length - minLen)]));
}
