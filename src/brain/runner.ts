import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { BrainOutput } from '../core/types.js';
import { BrainOutputSchema } from './schema.js';

export { BrainOutputSchema } from './schema.js';

const pExecFile = promisify(execFile);

export class BrainAuthError extends Error {}

const AUTH_PATTERNS = /please run.*login|claude login|invalid api key|not authenticated|usage limit|rate.?limit/i;

function classifyError(err: unknown): Error {
  // stderr는 claude CLI 프로세스의 출력일 때만 검사 — LLM 응답 텍스트(메시지)로는 절대 분류하지 않는다 (오탐 방지)
  const stderr = err != null && typeof (err as { stderr?: unknown }).stderr === 'string'
    ? (err as { stderr: string }).stderr : '';
  if (stderr && AUTH_PATTERNS.test(stderr)) {
    return new BrainAuthError(`claude CLI 인증/한도 문제: ${stderr.slice(0, 200)}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}

export interface BrainOptions {
  claudeCmd: string;
  /** timeoutMs는 재시도 포함 총 상한 (기본값 180,000ms). 각 시도는 timeoutMs/2, 최악의 경우 총 timeoutMs까지. */
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
    { timeout: opts.timeoutMs, killSignal: 'SIGKILL', maxBuffer: 10 * 1024 * 1024 },
  );
  const envelope = JSON.parse(stdout);
  if (typeof envelope !== 'string') {
    const result = envelope.result;
    if (result == null || result === '') {
      throw new Error(`claude 응답 envelope에 result가 없습니다: ${stdout.slice(0, 300)}`);
    }
    return String(result);
  }
  return envelope;
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
