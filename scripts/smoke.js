#!/usr/bin/env node
/**
 * Real WhatsApp smoke test. Drives a *running* OpenWA instance through one full session
 * lifecycle: create -> start -> QR -> authenticate (you scan it) -> READY -> send -> clean up.
 *
 * The automated suites in `test/` use a FakeEngine and a throwaway SQLite file, so they
 * cannot catch anything that only breaks in a real browser against real WhatsApp: a Chromium
 * that will not launch under the configured args, a session folder that cannot be restored, a
 * QR that never renders, a driver that connects but never reports READY. Only this script
 * exercises that path, and it needs a human with a phone.
 *
 * Usage:
 *   npm run smoke
 *   OPENWA_URL=http://localhost:2785 OPENWA_API_KEY=... npm run smoke
 *   SMOKE_TO=628123456789@c.us npm run smoke        # also send a message
 *   SMOKE_KEEP=1 npm run smoke                      # do not delete the session at the end
 *
 * Environment:
 *   OPENWA_URL      base URL of a running instance (default http://localhost:2785)
 *   OPENWA_API_KEY  API key for the X-API-Key header (required unless SMOKE_API_KEY_FILE)
 *   SMOKE_API_KEY_FILE  file containing the API key, if you would rather not export it
 *   SMOKE_SESSION   session name (default smoke-<timestamp>)
 *   SMOKE_TO        chat id to send a test message to; skips the send step when unset
 *   SMOKE_KEEP      truthy value keeps the session instead of deleting it (see envFlag)
 *   SMOKE_HEADFUL   show the Chromium window (needs a display). Read by the *server*, so
 *                   it must be set when OpenWA starts; setting it here only affects a
 *                   server this script happens to launch, not one already running.
 *   SMOKE_TIMEOUT   seconds to wait for READY (default 180)
 *
 * Exits 0 only when every step succeeded; any failure exits 1.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const BASE_URL = (process.env.OPENWA_URL || 'http://localhost:2785').replace(/\/+$/, '');
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT || 180) * 1000;
const SESSION_NAME = process.env.SMOKE_SESSION || `smoke-${Date.now()}`;
/**
 * `Boolean(process.env.X)` is a trap here: `SMOKE_KEEP=0` and `SMOKE_KEEP=false` are both
 * truthy strings, so a caller trying to *disable* keeping the session would have it kept
 * anyway -- and the session is the thing holding a logged-in WhatsApp account.
 */
function envFlag(name) {
  const raw = String(process.env[name] || '').trim().toLowerCase();
  if (!raw) return false;
  return !['0', 'false', 'no', 'off'].includes(raw);
}

const KEEP = envFlag('SMOKE_KEEP');

let apiKey = process.env.OPENWA_API_KEY || '';
if (!apiKey && process.env.SMOKE_API_KEY_FILE) {
  apiKey = fs.readFileSync(process.env.SMOKE_API_KEY_FILE, 'utf8').trim();
}

const state = { sessionId: null };

function log(step, message) {
  console.log(`[${step}] ${message}`);
}

function fail(step, message, detail) {
  console.error(`[${step}] FAILED: ${message}`);
  if (detail) console.error(`         ${detail}`);
  process.exitCode = 1;
}

async function call(method, endpoint, body) {
  const headers = { Accept: 'application/json' };
  if (apiKey) headers['X-API-Key'] = apiKey;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(`${BASE_URL}/api${endpoint}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : undefined;
  } catch {
    payload = text;
  }

  if (!response.ok) {
    const detail = typeof payload === 'string' ? payload : JSON.stringify(payload);
    throw new Error(`${method} ${endpoint} -> ${response.status} ${response.statusDetail || ''}\n         ${detail}`);
  }
  return payload;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Session status is serialized using the enum *value* ('qr_ready'), not its key
 * ('QR_READY'). Comparing against a hardcoded key silently never matches, so compare
 * case-insensitively and let either representation work.
 */
const isStatus = (actual, expected) => String(actual).toUpperCase() === expected.toUpperCase();

/** Waits for `check` to return a truthy value, polling until the deadline. */
async function waitFor(step, description, check, timeoutMs = TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await check();
      if (last) return last;
    } catch (error) {
      last = error.message;
    }
    await sleep(2000);
  }
  throw new Error(`timed out after ${timeoutMs / 1000}s waiting for ${description} (last: ${JSON.stringify(last)})`);
}

/**
 * Writes the QR data URL to a PNG so a phone can actually scan it, and prints the path.
 * Terminal QR rendering needs an extra dependency; a file works everywhere.
 */
function saveQr(qrCode) {
  const match = /^data:image\/png;base64,(.+)$/.exec(qrCode || '');
  if (!match) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openwa-smoke-'));
  const file = path.join(dir, `${SESSION_NAME}-qr.png`);
  fs.writeFileSync(file, Buffer.from(match[1], 'base64'));
  return file;
}

async function main() {
  log('setup', `target ${BASE_URL}, session "${SESSION_NAME}"`);

  if (!apiKey) {
    throw new Error(
      'no API key. Every non-public route is behind the ApiKeyGuard, so set OPENWA_API_KEY ' +
        'or SMOKE_API_KEY_FILE.',
    );
  }

  // 1. Readiness. Polling this first separates "the server is not up" from every later step
  //    failing for the same uninformative reason.
  const readiness = await call('GET', '/health/ready');
  log('ready', `status=${readiness.status} deps=${JSON.stringify(readiness.details?.redis?.status ?? 'n/a')}`);

  // 2. Create.
  const session = await call('POST', '/sessions', { name: SESSION_NAME });
  state.sessionId = session.id;
  log('create', `session ${session.id} created`);

  // 3. Start. This launches Chromium; it is the step most likely to fail on a real machine.
  const started = await call('POST', `/sessions/${session.id}/start`);
  log('start', `status=${started.status}`);

  // 4. QR. Persisted status QR_READY plus a served image is what a dashboard needs; either
  //    one alone is not enough.
  const qr = await waitFor('qr', 'the session to report QR_READY', async () => {
    const payload = await call('GET', `/sessions/${session.id}/qr`);
    return isStatus(payload.status, 'QR_READY') && payload.qrCode ? payload : null;
  });

  const qrFile = saveQr(qr.qrCode);
  log('qr', 'QR_READY — scan this file with WhatsApp (Linked devices):');
  log('qr', qrFile || 'could not decode the QR data URL; fetch it from the API instead');

  // 5. Authenticate. Only a human can do this part.
  const ready = await waitFor('ready', 'the session to report READY', async () => {
    const payload = await call('GET', `/sessions/${session.id}`);
    return isStatus(payload.status, 'READY') ? payload : null;
  });
  log('ready', `authenticated as ${ready.phone || 'unknown number'} (${ready.pushName || 'no push name'})`);

  // 6. Optional send. Requires a real chat, so it is opt-in.
  if (process.env.SMOKE_TO) {
    const sent = await call('POST', `/sessions/${session.id}/messages/send-text`, {
      chatId: process.env.SMOKE_TO,
      text: `OpenWA smoke test ${new Date().toISOString()}`,
    });
    log('send', `message ${sent.messageId || sent.id || ''} sent to ${process.env.SMOKE_TO}`);
  } else {
    log('send', 'skipped (set SMOKE_TO=<chatId> to send a real message)');
  }
}

async function cleanup() {
  if (!state.sessionId || KEEP) {
    if (state.sessionId && KEEP) log('cleanup', `keeping session ${state.sessionId} (SMOKE_KEEP)`);
    return;
  }
  // Stop first so Chromium exits before the row disappears, otherwise the session folder is
  // orphaned and a later run with the same name restores a half-dead session.
  try {
    await call('POST', `/sessions/${state.sessionId}/stop`);
    log('cleanup', 'session stopped');
  } catch (error) {
    fail('cleanup', 'could not stop the session', error.message);
  }
  try {
    await call('DELETE', `/sessions/${state.sessionId}`);
    log('cleanup', 'session deleted');
  } catch (error) {
    fail('cleanup', 'could not delete the session', error.message);
  }
}

main()
  .catch(error => {
    fail('smoke', error.message);
  })
  .finally(async () => {
    await cleanup().catch(error => fail('cleanup', error.message));
    log('done', process.exitCode ? 'smoke test FAILED' : 'smoke test passed');
  });
