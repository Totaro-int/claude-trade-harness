/**
 * Claude CLI 공유 플러밍 — 온보딩(setup)과 리서치(research)가 함께 쓰는 비-trading 호출부.
 * (구 brain/runner.ts 에서 trading 전용 runBrain/스키마를 제외하고 분리.)
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pExecFile = promisify(execFile);

/** 첫 '{'부터 중괄호 깊이가 0으로 닫히는 지점까지의 첫 JSON 오브젝트 추출 (문자열 내 중괄호/이스케이프 처리). */
export function extractFirstJsonObject(text: string): string | null {
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

/** 프롬프트는 argv 한 요소로 전달되므로 OS ARG_MAX(macOS 1MB)에 못 미치게 상한. */
const MAX_PROMPT_BYTES = 800_000;

/** claude -p 헤드리스 호출 (envelope JSON → result text 추출). */
export async function runClaudeText(
  prompt: string,
  opts: { claudeCmd: string; timeoutMs: number },
): Promise<string> {
  const promptBytes = Buffer.byteLength(prompt, 'utf8');
  if (promptBytes > MAX_PROMPT_BYTES) {
    throw new Error(`프롬프트가 너무 큽니다: ${promptBytes} bytes (상한 ${MAX_PROMPT_BYTES}).`);
  }
  const { stdout } = await pExecFile(
    opts.claudeCmd,
    ['-p', prompt, '--output-format', 'json'],
    { timeout: opts.timeoutMs, killSignal: 'SIGKILL', maxBuffer: 10 * 1024 * 1024 },
  );
  const envelope = JSON.parse(stdout);
  if (typeof envelope !== 'string') {
    const result = envelope.result;
    if (result == null || result === '') {
      throw new Error(`claude 응답 envelope에 result가 없습니다: ${String(stdout).slice(0, 300)}`);
    }
    return String(result);
  }
  return envelope;
}
