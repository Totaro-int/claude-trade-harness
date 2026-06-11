import { execFileSync } from 'node:child_process';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AdapterEnv } from '../broker/adapter.js';
import { runClaudeText } from '../brain/runner.js';
import { checkAdapterSource } from './static-check.js';

export interface GenerateInput {
  brokerId: string;
  docsText: string;
  env: AdapterEnv;
  claudeCmd: string;
  outDir?: string;      // e.g. adapters/<brokerId>; defaults to join('adapters', brokerId)
  maxAttempts?: number; // default 3
  onProgress: (msg: string) => void;
}

export interface GenerateResult {
  ok: boolean;
  path?: string;
  error?: string;
}

function buildGenPrompt(docsText: string, feedback: string | null): string {
  const feedbackSection = feedback
    ? `\n## 직전 시도 실패 사유 (반드시 수정)\n${feedback}\n`
    : '';
  return `당신은 증권사 OpenAPI 어댑터 코드 생성기입니다. 아래 API 문서를 읽고 BrokerAdapter를 구현하십시오.

## 작성 규칙 (위반 시 자동 거부됨)
- 출력은 TypeScript 코드 블록 1개만. 설명 최소화.
- 첫 줄: import type { BrokerAdapter, AdapterEnv, HttpClient } from '../../src/broker/adapter.js';
- 그 외 import 일절 금지. 네트워크는 인자로 받은 http(get/post)만 사용. http의 path는 상대 경로.
- 시크릿은 env.apiKey/env.apiSecret/env.accountNo로만 참조. 하드코딩·로깅 금지.
- export function createAdapter(env: AdapterEnv, http: HttpClient): BrokerAdapter
- 필수 구현: auth(토큰 보관은 클로저 변수), getQuotes, getBalance, isMarketOpen.
- 문서에 캔들/호가/주문 API가 있으면 getCandles/getOrderbook/submitOrder/cancelOrder도 구현.
- Quote 규격: { symbol, name, price, bid, ask, changeRate, volume } — 모르는 값은 name=symbol, bid=ask=price, changeRate=0, volume=0.
- isMarketOpen: 문서에 장운영 API가 없으면 KST 09:00~15:30 평일 여부로 계산.
${feedbackSection}
## API 문서
${docsText.slice(0, 60000)}`;
}

function extractCode(text: string): string | null {
  const m = text.match(/```(?:typescript|ts)\n([\s\S]*?)```/);
  return m ? m[1]!.trim() : null;
}

export async function generateAdapter(input: GenerateInput): Promise<GenerateResult> {
  if (!/^[a-z0-9_-]+$/.test(input.brokerId)) {
    throw new Error(`brokerId "${input.brokerId}" is invalid — only [a-z0-9_-] allowed`);
  }
  const outDir = input.outDir ?? join('adapters', input.brokerId);
  const max = input.maxAttempts ?? 3;
  const secrets = [input.env.apiKey, input.env.apiSecret, input.env.accountNo].filter(
    (s) => s.length >= 6,
  );
  let feedback: string | null = null;

  // Safe wrapper so a throwing onProgress handler never breaks the result contract.
  const progress = (m: string) => { try { input.onProgress(m); } catch {} };

  for (let attempt = 1; attempt <= max; attempt++) {
    progress(`어댑터 생성 시도 ${attempt}/${max}...`);

    let text: string;
    try {
      text = await runClaudeText(buildGenPrompt(input.docsText, feedback), {
        claudeCmd: input.claudeCmd,
        timeoutMs: 300_000,
      });
    } catch (err) {
      feedback = `claude 호출 실패: ${String(err)}`;
      continue;
    }

    const code = extractCode(text);
    if (!code) {
      feedback = '응답에 TypeScript 코드 블록이 없음';
      progress('코드 블록 추출 실패');
      continue;
    }

    const violations = checkAdapterSource(code, secrets);
    if (violations.length > 0) {
      feedback = `정적 검사 위반: ${violations.join('; ')}`;
      progress(`정적 검사 실패: ${violations.join(', ')}`);
      continue;
    }

    mkdirSync(outDir, { recursive: true });
    const tmpPath = join(outDir, 'adapter.tmp.ts');
    const filePath = join(outDir, 'adapter.ts');
    writeFileSync(tmpPath, code);

    // Compile-check the tmp file. The outDir must be 2 levels deep under the repo root so
    // the relative import '../../src/broker/adapter.js' resolves correctly.
    // e.g. adapters/__test_gen/adapter.tmp.ts → ../../src/broker/adapter.ts ✓
    // --ignoreConfig skips the project tsconfig.json (required when files are passed on CLI).
    try {
      execFileSync(
        'npx',
        [
          'tsc',
          '--ignoreConfig',
          '--noEmit',
          '--skipLibCheck',
          '--strict',
          '--module', 'nodenext',
          '--moduleResolution', 'nodenext',
          '--target', 'es2022',
          resolve(tmpPath),
        ],
        { stdio: 'pipe', cwd: process.cwd() },
      );
    } catch (err) {
      rmSync(tmpPath, { force: true });
      const errOut = err != null && typeof (err as { stdout?: Buffer }).stdout !== 'undefined'
        ? String((err as { stdout: Buffer }).stdout)
        : String(err);
      feedback = `컴파일 실패: ${errOut.slice(0, 2000)}`;
      progress('컴파일 실패 — 재생성');
      continue;
    }

    renameSync(tmpPath, filePath);
    progress('정적 검사·컴파일 통과');
    return { ok: true, path: filePath };
  }

  return { ok: false, error: feedback ?? '알 수 없는 실패' };
}
