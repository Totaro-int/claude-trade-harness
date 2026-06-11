import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export function loadEnvFile(path = '.env'): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

export function saveEnvFile(vars: Record<string, string>, path = '.env'): void {
  const merged = { ...loadEnvFile(path), ...vars };
  writeFileSync(path, Object.entries(merged).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
}
