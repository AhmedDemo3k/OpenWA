import { URL } from 'url';

const PRIVATE_IP_RANGES = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^::1$/,
  /^fc00:/i,
  /^fe80:/i,
];

function isPrivateIp(hostname: string): boolean {
  return PRIVATE_IP_RANGES.some(r => r.test(hostname));
}

export function validateWebhookUrl(
  url: string,
  allowedUrls: string[] = [],
  blockPrivateIps = true,
): { ok: boolean; reason?: string } {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, reason: 'Only http(s) URLs are allowed' };
    }

    const hostname = parsed.hostname;

    if (blockPrivateIps && (hostname === 'localhost' || isPrivateIp(hostname))) {
      return { ok: false, reason: 'Private/loopback URLs are not allowed' };
    }

    if (allowedUrls.length > 0) {
      const allowed = allowedUrls.some(a => {
        try {
          const ap = new URL(a);
          return ap.hostname === hostname && ap.protocol === parsed.protocol && ap.port === parsed.port;
        } catch {
          // allow exact string match fallback
          return a === url;
        }
      });
      if (!allowed) {
        return { ok: false, reason: 'URL not in allowlist' };
      }
    }

    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : 'Invalid URL' };
  }
}
