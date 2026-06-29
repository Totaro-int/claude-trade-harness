/**
 * 리서치용 Claude 러너 — headless `claude -p` 에 WebSearch/WebFetch 도구를 허용해 호출한다.
 * 4대가 렌즈가 펀더멘털(재무·뉴스)을 실제 웹에서 조사하려면 도구 접근이 필요하다.
 * 기존 brain/runner.ts(runClaudeText)는 도구 없이 호출하므로 별도 러너를 둔다.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pExecFile = promisify(execFile);

const MAX_PROMPT_BYTES = 800_000;

export interface ResearchRunnerOptions {
  claudeCmd: string;
  timeoutMs: number;
  /** 허용할 도구. 기본 WebSearch·WebFetch. */
  allowedTools?: string[];
}

/** claude -p 호출(웹 도구 허용) → envelope.result 텍스트. */
export function makeResearchRunner(opts: ResearchRunnerOptions): (prompt: string) => Promise<string> {
  const tools = opts.allowedTools ?? ['WebSearch', 'WebFetch'];
  return async (prompt: string): Promise<string> => {
    const bytes = Buffer.byteLength(prompt, 'utf8');
    if (bytes > MAX_PROMPT_BYTES) {
      throw new Error(`프롬프트가 너무 큽니다: ${bytes} bytes (상한 ${MAX_PROMPT_BYTES}).`);
    }
    const { stdout } = await pExecFile(
      opts.claudeCmd,
      ['-p', prompt, '--output-format', 'json', '--allowedTools', ...tools],
      { timeout: opts.timeoutMs, killSignal: 'SIGKILL', maxBuffer: 10 * 1024 * 1024 },
    );
    const envelope = JSON.parse(stdout);
    if (typeof envelope === 'string') return envelope;
    const result = envelope.result;
    if (result == null || result === '') {
      throw new Error(`claude 응답 envelope에 result가 없습니다: ${String(stdout).slice(0, 300)}`);
    }
    return String(result);
  };
}
