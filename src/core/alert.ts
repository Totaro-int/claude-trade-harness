import { execFile } from 'node:child_process';

export interface AlertOptions {
  /** 원격 알림 webhook (Slack/Discord/generic). { text } JSON을 POST. 미지정 시 로컬 알림만. */
  webhookUrl?: string;
}

function notifyMac(msg: string): void {
  if (process.platform === 'darwin') {
    execFile('osascript', ['-e', `display notification ${JSON.stringify(msg)} with title "claude-trade-harness"`], () => {});
  }
}

/**
 * 운영 알림 발송기. 콘솔 + macOS 알림 + webhook(설정 시).
 * 절대 throw하지 않는다 — 알림 실패가 매매/사이클을 막아선 안 된다(fail-open).
 * webhookUrl은 운영자 신뢰 입력(config.json)이며 http(s)만 발송한다.
 */
export function makeAlerter(opts: AlertOptions = {}): (message: string) => Promise<void> {
  const url = opts.webhookUrl;
  const httpOk = !!url && /^https?:\/\//i.test(url);
  return async (message: string): Promise<void> => {
    console.error(`[alert] ${message}`);
    notifyMac(message);
    if (httpOk) {
      try {
        await fetch(url!, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: message }),
          signal: AbortSignal.timeout(5_000),
        });
      } catch (err) {
        console.error(`[alert] webhook 발송 실패: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };
}
