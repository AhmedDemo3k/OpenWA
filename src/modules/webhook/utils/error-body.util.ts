export function truncateErrorBody(body: string | null | undefined, max = 200): string {
  if (!body) return '';
  const s = body.replace(/\r?\n/g, ' ').slice(0, max);
  return s.length < body.length ? `${s}...` : s;
}

export function extractErrorBody(res: Response, max = 200): Promise<string> {
  try {
    const ct = res?.headers?.get?.('content-type') || '';
    if ((ct.includes('application/json') || ct.includes('text/')) && typeof res.text === 'function') {
      return res
        .text()
        .then(t => truncateErrorBody(t, max))
        .catch(() => '');
    }
  } catch {
    // fall through to empty
  }
  return Promise.resolve('');
}
