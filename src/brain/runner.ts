import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { BrainOutput } from '../core/types.js';
import { BrainOutputSchema } from './schema.js';

export { BrainOutputSchema } from './schema.js';

const pExecFile = promisify(execFile);

export class BrainAuthError extends Error {}

const AUTH_PATTERNS = /please run.*login|claude login|invalid api key|not authenticated|usage limit|rate.?limit/i;

function classifyError(err: unknown): Error {
  const msg =
    String((err as { stderr?: string; message?: string })?.stderr ?? '') +
    String((err as Error)?.message ?? '');
  if (AUTH_PATTERNS.test(msg)) return new BrainAuthError(`claude CLI 인증/한도 문제: ${msg.slice(0, 200)}`);
  return err as Error;
}

export interface BrainOptions {
  claudeCmd: string;
  /** timeoutMs는 재시도 포함 총 상한 (기본값 180,000ms). 내부적으로 시도당 절반씩 배분. */
  timeoutMs?: number;
}

/** 첫 '{'부터 중괄호 깊이가 0으로 닫히는 지점까지의 첫 JSON 오브젝트를 추출 (문자열 내 중괄호/이스케이프 처리) */
function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (escape) { escape = false; continue; }
    if (c === '\\' && inString) { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{') depth++;
    else if (c === '}') { if (--depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}

/** claude -p 헤드리스 호출 (envelope JSON → result text 추출) */
export async function runClaudeText(
  prompt: string,
  opts: { claudeCmd: string; timeoutMs: number },
): Promise<string> {
  const { stdout } = await pExecFile(
    opts.claudeCmd,
    ['-p', prompt, '--output-format', 'json'],
    { timeout: opts.timeoutMs, maxBuffer: 10 * 1024 * 1024 },
  );
  const envelope = JSON.parse(stdout);
  return typeof envelope === 'string' ? envelope : String(envelope.result ?? '');
}

/** claude -p 헤드리스 호출. 실패 시 1회 재시도, 그래도 실패하면 throw (사이클 스킵용). BrainAuthError는 즉시 throw. */
export async function runBrain(prompt: string, opts: BrainOptions): Promise<BrainOutput> {
  const perAttemptTimeout = Math.floor((opts.timeoutMs ?? 180_000) / 2);
  let lastErr: Error = new Error('unknown');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const text = await runClaudeText(prompt, { claudeCmd: opts.claudeCmd, timeoutMs: perAttemptTimeout });
      const json = extractFirstJsonObject(text);
      if (!json) throw new Error(`응답에서 JSON을 찾지 못함: ${text.slice(0, 200)}`);
      return BrainOutputSchema.parse(JSON.parse(json));
    } catch (err) {
      lastErr = classifyError(err);
      if (lastErr instanceof BrainAuthError) throw lastErr;
    }
  }
  throw new Error(`brain 호출 실패 (재시도 1회 포함): ${String(lastErr)}`);
}
