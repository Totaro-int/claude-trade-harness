import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeAlerter } from '../src/core/alert.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('makeAlerter', () => {
  it('webhook 미설정이면 fetch를 호출하지 않고 콘솔만 쓴다', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const alert = makeAlerter();
    await alert('테스트');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('webhook 설정 시 { text } JSON을 POST한다', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchSpy);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const alert = makeAlerter({ webhookUrl: 'https://hooks.example.com/x' });
    await alert('점검 필요');
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://hooks.example.com/x');
    expect(JSON.parse((init as { body: string }).body)).toEqual({ text: '점검 필요' });
  });

  it('http(s)가 아닌 webhook은 무시한다', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const alert = makeAlerter({ webhookUrl: 'file:///etc/passwd' });
    await alert('x');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('webhook이 throw해도 alert는 throw하지 않는다(fail-open)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('네트워크')));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const alert = makeAlerter({ webhookUrl: 'https://hooks.example.com/x' });
    await expect(alert('x')).resolves.toBeUndefined();
  });
});
