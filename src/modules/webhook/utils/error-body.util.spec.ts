import { truncateErrorBody, extractErrorBody } from './error-body.util';

describe('truncateErrorBody', () => {
  it('returns empty string for nullish input', () => {
    expect(truncateErrorBody(null)).toBe('');
    expect(truncateErrorBody(undefined)).toBe('');
    expect(truncateErrorBody('')).toBe('');
  });

  it('collapses newlines and trims to max length with an ellipsis', () => {
    const body = 'line one\nline two\r\nline three';
    const out = truncateErrorBody(body, 10);
    expect(out.startsWith('line one l')).toBe(true);
    expect(out.endsWith('...')).toBe(true);
    expect(out).not.toContain('\n');
  });
});

describe('extractErrorBody', () => {
  it('reads and truncates a JSON error body', async () => {
    const res = {
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({ message: 'bad request' }),
    } as unknown as Response;
    await expect(extractErrorBody(res, 200)).resolves.toContain('bad request');
  });

  it('returns empty for non-text content types', async () => {
    const res = {
      headers: { get: () => 'application/octet-stream' },
      text: async () => 'binary',
    } as unknown as Response;
    await expect(extractErrorBody(res)).resolves.toBe('');
  });

  it('is defensive against minimal/mock responses', async () => {
    await expect(extractErrorBody({} as Response)).resolves.toBe('');
  });
});
