import { validateWebhookUrl } from './url-validator.util';

describe('validateWebhookUrl', () => {
  it('accepts a public https URL', () => {
    expect(validateWebhookUrl('https://example.com/hooks', [], true)).toEqual({ ok: true });
  });

  it('rejects non-http(s) protocols', () => {
    const result = validateWebhookUrl('ftp://example.com', [], false);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/http/i);
  });

  it('blocks loopback and private IPv4 ranges by default', () => {
    for (const url of [
      'http://localhost:3000/hook',
      'http://127.0.0.1/hook',
      'http://10.1.2.3/hook',
      'http://192.168.1.10/hook',
      'http://172.16.5.5/hook',
      'http://169.254.169.254/latest/meta-data',
    ]) {
      expect(validateWebhookUrl(url, [], true).ok).toBe(false);
    }
  });

  it('allows private URLs when blockPrivateIps is false', () => {
    expect(validateWebhookUrl('http://127.0.0.1:9000/hook', [], false).ok).toBe(true);
  });

  it('enforces the allowlist when one is configured', () => {
    const allow = ['https://hooks.example.com'];
    expect(validateWebhookUrl('https://hooks.example.com/abc', allow, true).ok).toBe(true);
    const denied = validateWebhookUrl('https://evil.example.com/abc', allow, true);
    expect(denied.ok).toBe(false);
    expect(denied.reason).toMatch(/allowlist/i);
  });

  it('reports malformed URLs as invalid', () => {
    expect(validateWebhookUrl('not-a-url', [], true).ok).toBe(false);
  });
});
