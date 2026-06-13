import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { saveEnvFile } from '../env.js';
import { runClaudeText } from '../brain/runner.js';
import { generateAdapter, type GenerateResult } from './generator.js';
import { loadAdapter } from '../broker/loader.js';
import { runConnectionTest, type ConnResult } from './connection-test.js';
import type { AdapterEnv } from '../broker/adapter.js';

export function validateDocsUrl(url: string): void {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error(`유효하지 않은 문서 URL: ${url}`); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`http/https 문서 URL만 허용됩니다: ${url}`);
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  // 루프백/링크로컬/사설 메타데이터 주소 차단 (SSRF)
  if (
    host === 'localhost' || host === '0.0.0.0' || host === '::1' ||
    /^127\./.test(host) || /^169\.254\./.test(host) ||
    /^10\./.test(host) || /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^(fc|fd)[0-9a-f]{2}:/i.test(host) || host === '::'
  ) {
    throw new Error(`내부/사설 주소로의 문서 fetch는 차단됩니다: ${host}`);
  }
}

export interface BrokerReg {
  brokerId: string; brokerName: string; docsUrls: string[];
  baseUrl: string; apiKey: string; apiSecret: string; accountNo: string;
}

export interface SetupStatus {
  step: 'broker' | 'generate' | 'strategy' | 'finish';
  broker?: { brokerId: string; brokerName: string; baseUrl: string; docsUrls: string[] };
  adapterReady: boolean;
  strategyReady: boolean;
}

export class SetupOrchestrator {
  #root: string;
  #claudeCmd: string;
  #broker: BrokerReg | null = null;

  constructor(opts: { rootDir: string; claudeCmd: string }) {
    this.#root = opts.rootDir;
    this.#claudeCmd = opts.claudeCmd;
  }

  status(): SetupStatus {
    const adapterReady = this.#broker !== null
      && existsSync(join(this.#root, 'adapters', this.#broker.brokerId, 'adapter.ts'));
    const stratDir = join(this.#root, 'strategy');
    const strategyReady = existsSync(stratDir) && readdirSync(stratDir).some(f => f.endsWith('.md'));
    return {
      step: !this.#broker ? 'broker' : !adapterReady ? 'generate' : !strategyReady ? 'strategy' : 'finish',
      broker: this.#broker
        ? { brokerId: this.#broker.brokerId, brokerName: this.#broker.brokerName, baseUrl: this.#broker.baseUrl, docsUrls: this.#broker.docsUrls }
        : undefined,
      adapterReady, strategyReady,
    };
  }

  async registerBroker(reg: BrokerReg): Promise<void> {
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(reg.brokerId)) throw new Error('brokerId는 소문자/숫자/하이픈만 허용됩니다');
    this.#broker = reg;
    saveEnvFile({ BROKER_API_KEY: reg.apiKey, BROKER_API_SECRET: reg.apiSecret, BROKER_ACCOUNT_NO: reg.accountNo }, join(this.#root, '.env'));
    mkdirSync(join(this.#root, 'adapters'), { recursive: true });
    writeFileSync(join(this.#root, 'adapters', 'registry.json'), JSON.stringify({
      brokerId: reg.brokerId, brokerName: reg.brokerName, baseUrl: reg.baseUrl, docsUrls: reg.docsUrls,
    }, null, 2));
  }

  async fetchDocs(onProgress: (m: string) => void): Promise<string> {
    if (!this.#broker) throw new Error('브로커 미등록');
    const parts: string[] = [];
    for (const url of this.#broker.docsUrls) {
      validateDocsUrl(url);
      onProgress(`문서 수집: ${url}`);
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`문서 fetch 실패 ${res.status}: ${url}`);
      const text = await res.text();
      parts.push(text.trimStart().startsWith('<') ? text.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ') : text);
    }
    return parts.join('\n\n---\n\n');
  }

  async generate(onProgress: (m: string) => void): Promise<GenerateResult> {
    if (!this.#broker) throw new Error('브로커 미등록');
    const docsText = this.#broker.docsUrls.length > 0 ? await this.fetchDocs(onProgress) : '(문서 URL 미제공 — 일반 REST 관례로 구현)';
    return generateAdapter({
      brokerId: this.#broker.brokerId, docsText, env: this.#env(),
      claudeCmd: this.#claudeCmd, outDir: join(this.#root, 'adapters', this.#broker.brokerId), onProgress,
    });
  }

  async testConnection(testSymbol: string): Promise<ConnResult> {
    if (!this.#broker) throw new Error('브로커 미등록');
    const adapter = await loadAdapter(join(this.#root, 'adapters', this.#broker.brokerId, 'adapter.ts'), this.#env());
    const secrets = [this.#broker.apiKey, this.#broker.apiSecret, this.#broker.accountNo].filter(s => s.length >= 6);
    return runConnectionTest(adapter, testSymbol, secrets);
  }

  async saveStrategyDoc(filename: string, content: string): Promise<void> {
    if (!/^\w[\w.-]*\.(md|txt)$/.test(filename)) throw new Error('파일명은 영숫자 + .md/.txt만 허용됩니다');
    mkdirSync(join(this.#root, 'strategy'), { recursive: true });
    writeFileSync(join(this.#root, 'strategy', filename), content);
  }

  async generateStrategy(profile: { risk: string; capital: number; horizon: string; sectors: string[] }): Promise<void> {
    const prompt = `투자 전략 문서와 종목 유니버스를 생성하십시오. JSON 코드블록 1개만 출력:
{"strategyMd": "마크다운 전략 문서 (매매기법/진입·청산 규칙/리스크 관리 포함)", "universe": [{"symbol": "종목코드", "name": "종목명"}, ...최대 30개]}
프로필: 성향 ${profile.risk}, 자금 ${profile.capital.toLocaleString()}원, 기간 ${profile.horizon}, 선호 ${profile.sectors.join(', ')}`;
    const text = await runClaudeText(prompt, { claudeCmd: this.#claudeCmd, timeoutMs: 300_000 });
    const m = text.match(/```(?:json)?\n([\s\S]*?)```/);
    if (!m) throw new Error('전략 생성 응답 파싱 실패');
    let parsed: { strategyMd: string; universe: Array<{ symbol: string; name: string }> };
    try {
      parsed = JSON.parse(m[1]!) as { strategyMd: string; universe: Array<{ symbol: string; name: string }> };
    } catch (e) {
      throw new Error(`전략 생성 응답이 유효한 JSON이 아닙니다: ${(e as Error).message}`);
    }
    if (typeof parsed.strategyMd !== 'string' || parsed.strategyMd.length === 0 || !Array.isArray(parsed.universe)) {
      throw new Error('전략 응답 구조가 올바르지 않습니다');
    }
    const universe = parsed.universe
      .filter(e => typeof e?.symbol === 'string' && typeof e?.name === 'string')
      .slice(0, 30);
    mkdirSync(join(this.#root, 'strategy'), { recursive: true });
    writeFileSync(join(this.#root, 'strategy', 'strategy.md'), parsed.strategyMd);
    writeFileSync(join(this.#root, 'strategy', 'universe.json'), JSON.stringify(universe, null, 2));
  }

  async finish(opts: { mode: 'paper' | 'live'; guardrails: Record<string, number>; agreed: boolean }): Promise<void> {
    if (!opts.agreed) throw new Error('면책 고지에 동의해야 시작할 수 있습니다');
    if (!this.#broker) throw new Error('브로커 미등록');
    const cfgPath = join(this.#root, 'config.json');
    let existing: Record<string, unknown> = {};
    if (existsSync(cfgPath)) {
      try {
        existing = JSON.parse(readFileSync(cfgPath, 'utf-8')) as Record<string, unknown>;
      } catch (e) {
        throw new Error(`기존 config.json이 손상되었습니다: ${(e as Error).message}`);
      }
    }
    writeFileSync(cfgPath, JSON.stringify({
      ...existing, mode: opts.mode, brokerId: this.#broker.brokerId,
      guardrails: { ...(existing.guardrails ?? {}), ...opts.guardrails },
    }, null, 2));
  }

  #env(): AdapterEnv {
    if (!this.#broker) throw new Error('브로커 미등록');
    const r = this.#broker;
    return { apiKey: r.apiKey, apiSecret: r.apiSecret, accountNo: r.accountNo, baseUrl: r.baseUrl };
  }
}
