import { Test, TestingModule } from '@nestjs/testing';
import { NestFactory } from '@nestjs/core';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken, getDataSourceToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import { createHmac } from 'crypto';
import { FakeEngine } from './fake-engine';

/**
 * Environment must be set before `AppModule` (and therefore `configuration.ts`) is
 * imported, because `ConfigModule.forRoot({ load: [configuration] })` evaluates it at
 * import time. Each run gets its own SQLite files and media dir, so suites never share state
 * and never touch a developer's real `./data`.
 */
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openwa-e2e-'));
process.env.DATABASE_MAIN_NAME = path.join(tmpRoot, 'main.sqlite');
process.env.DATABASE_NAME = path.join(tmpRoot, 'data.sqlite');
process.env.STORAGE_LOCAL_PATH = path.join(tmpRoot, 'media');
process.env.SESSION_DATA_PATH = path.join(tmpRoot, 'sessions');
process.env.QUEUE_ENABLED = 'false';
process.env.CACHE_ENABLED = 'false';
// Deliberately left unset: this reproduces the *default* production boot path, where the
// data DB relies on migrations rather than synchronize. If the schema does not appear, the
// test must fail loudly — that is the whole point of this suite.
delete process.env.DATABASE_SYNCHRONIZE;

import { AppModule } from '../../src/app.module';
import { EngineFactory } from '../../src/engine/engine.factory';
import { SessionService } from '../../src/modules/session/session.service';
import { Session, SessionStatus } from '../../src/modules/session/entities/session.entity';
import { WebhookService, WebhookPayload } from '../../src/modules/webhook/webhook.service';
import { Webhook } from '../../src/modules/webhook/entities/webhook.entity';
import { HookManager } from '../../src/core/hooks';
import { EventsGateway } from '../../src/modules/events/events.gateway';

/** The `webhook:error` hook payload asserted in the retry-exhaustion test. */
interface WebhookErrorEvent {
  event: string;
  data: { webhookId: string; error: string };
}

describe('OpenWA integration (real app, real SQLite, fake engine)', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let sessionService: SessionService;
  let sessions: Repository<Session>;
  let dataSource: DataSource;
  let webhookService: WebhookService;
  let webhookRepository: Repository<Webhook>;
  let hookManager: HookManager;
  let configService: ConfigService;
  /** The untouched `ConfigService.get`, needed when spying on individual keys. */
  let configServiceGetOriginal: ConfigService['get'];

  /**
   * Keyed by session *name*, because that is what `EngineFactory.create()` receives
   * (`sessionId: session.name`) and therefore what the driver uses for its data folder.
   */
  const engines = new Map<string, FakeEngine>();
  /** When set, the next engine handed out fails to initialise. */
  let nextInitError: Error | null = null;
  /** When set, the next engine emits this QR during initialize(), like a real driver. */
  let nextInitQr: string | null = null;

  beforeAll(async () => {
    const engineFactoryStub = {
      create: jest.fn((options: { sessionId: string }) => {
        const engine = new FakeEngine(options.sessionId);
        if (nextInitError) {
          engine.failNextInitialize = nextInitError;
          nextInitError = null;
        }
        if (nextInitQr) {
          engine.qrDuringInitialize = nextInitQr;
          nextInitQr = null;
        }
        engines.set(options.sessionId, engine);
        return engine;
      }),
    };

    moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EngineFactory)
      .useValue(engineFactoryStub)
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();

    sessionService = app.get(SessionService);
    sessions = app.get<Repository<Session>>(getRepositoryToken(Session, 'data'));
    dataSource = app.get<DataSource>(getDataSourceToken('data'));
    webhookService = app.get(WebhookService);
    webhookRepository = app.get<Repository<Webhook>>(getRepositoryToken(Webhook, 'data'));
    hookManager = app.get(HookManager);
    configService = app.get(ConfigService);
    configServiceGetOriginal = configService.get.bind(configService);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  /** Lets background `safely()` work and the SQLite writes it queues settle. */
  const settle = (ms = 150): Promise<void> => new Promise(r => setTimeout(r, ms));

  /**
   * `DataSource.query` returns `any` by default, so every row read was unchecked.
   * Its signature is generic, so pass the row shape through instead of casting.
   */
  const queryRows = <T>(sql: string): Promise<T[]> => dataSource.query<T[]>(sql);

  const engineFor = (name: string): FakeEngine => {
    const engine = engines.get(name);
    if (!engine) throw new Error(`no fake engine for session name "${name}" (have: ${[...engines.keys()].join(', ')})`);
    return engine;
  };

  let counter = 0;
  const uniqueName = (prefix: string): string => `${prefix}-${Date.now()}-${counter++}`;

  // ── First boot ──────────────────────────────────────────────────

  describe('first boot on a clean database', () => {
    it('creates the session table without any manual migration step', async () => {
      const rows = await queryRows<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'",
      );
      expect(rows).toHaveLength(1);
    });

    it('creates the webhook and message tables too', async () => {
      const rows = await queryRows<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('webhooks','messages')",
      );
      expect(rows.map(r => r.name).sort()).toEqual(['messages', 'webhooks']);
    });

    it('persists a row created through the real repository', async () => {
      const name = uniqueName('boot');
      const created = await sessionService.create({ name });

      const row = await sessions.findOneByOrFail({ id: created.id });
      expect(row.name).toBe(name);
      expect(row.status).toBe(SessionStatus.CREATED);
    });
  });

  // ── Full lifecycle: QR -> ready -> message ──────────────────────

  describe('session lifecycle', () => {
    let name: string;
    let sessionId: string;

    beforeAll(async () => {
      name = uniqueName('lifecycle');
      const created = await sessionService.create({ name });
      sessionId = created.id;
      await sessionService.start(sessionId);
    }, 30_000);

    it('registers exactly one engine for the started session', () => {
      expect(sessionService.getActiveCount()).toBe(1);
      expect(engineFor(name).callCounts.initialize).toBe(1);
    });

    it('persists QR_READY and keeps the QR available for the API to serve', async () => {
      engineFor(name).emitQRCode('2@QR-PAYLOAD');
      await settle();

      const row = await sessions.findOneByOrFail({ id: sessionId });
      expect(row.status).toBe(SessionStatus.QR_READY);
      // The QR itself is served straight off the live engine, not from the sessions table.
      expect(engineFor(name).getQRCode()).toBe('2@QR-PAYLOAD');
    });

    it('does not overwrite QR_READY when the driver emits the QR during initialize()', async () => {
      // Regression guard for a bug only a real browser could reveal: whatsapp-web.js fires
      // `qr` *while* `initialize()` is still running, so the callback lands before that
      // await resolves. A status write after the await then clobbered QR_READY back to
      // `initializing`, and the session stayed there until the driver re-emitted `qr` about
      // a minute later. Measured against a real Chromium: QR served after ~3s, API still
      // saying `initializing` at 61s — the dashboard never prompted a scan.
      const qrName = uniqueName('qr-during-init');
      nextInitQr = '2@QR-DURING-INIT';

      const qrSession = await sessionService.create({ name: qrName });
      await sessionService.start(qrSession.id);
      await settle(300);

      const row = await sessions.findOneByOrFail({ id: qrSession.id });
      expect(row.status).toBe(SessionStatus.QR_READY);
      expect(engineFor(qrName).getQRCode()).toBe('2@QR-DURING-INIT');

      await sessionService.delete(qrSession.id);
    });

    it('persists READY with the phone number and push name', async () => {
      engineFor(name).emitReady('628123456789', 'E2E Tester');
      await settle();

      const row = await sessions.findOneByOrFail({ id: sessionId });
      expect(row.status).toBe(SessionStatus.READY);
      expect(row.phone).toBe('628123456789');
      expect(row.pushName).toBe('E2E Tester');
    });

    it('keeps the process alive when a message arrives and the whole hook chain fails', async () => {
      const unhandled: unknown[] = [];
      const onUnhandled = (r: unknown): void => {
        unhandled.push(r);
      };
      process.on('unhandledRejection', onUnhandled);

      // Break all three downstream consumers at once.
      jest.spyOn(app.get(HookManager), 'execute').mockRejectedValue(new Error('plugin blew up'));
      jest.spyOn(app.get(WebhookService), 'dispatch').mockRejectedValue(new Error('webhook 500'));
      const emitSpy = jest.spyOn(app.get(EventsGateway), 'emitMessage');

      try {
        engineFor(name).emitMessage({ id: 'msg-e2e-1', body: 'hello' });
        await settle(250);

        expect(emitSpy).toHaveBeenCalled();
        // The critical assertion: a failing plugin must never kill the worker process.
        expect(unhandled).toEqual([]);
      } finally {
        process.off('unhandledRejection', onUnhandled);
        jest.restoreAllMocks();
      }
    });
  });

  // ── Resilience ──────────────────────────────────────────────────

  describe('resilience', () => {
    it('treats a dropped socket as retryable and keeps the session registered', async () => {
      const name = uniqueName('drop');
      const created = await sessionService.create({ name });
      await sessionService.start(created.id);

      const engine = engineFor(name);
      engine.emitReady('628999', 'Drop Tester');
      await settle();
      engine.emitDisconnected('connection lost');
      await settle(80);

      // A transient network blip must not be terminal, and must not unregister the engine.
      expect(sessionService.getActiveCount()).toBeGreaterThanOrEqual(1);
      await sessionService.delete(created.id);
    }, 30_000);

    it('stops retrying after a logout and releases the engine on delete', async () => {
      const name = uniqueName('logout');
      const created = await sessionService.create({ name });
      await sessionService.start(created.id);

      const engine = engineFor(name);
      engine.emitReady('628888', 'Logout Tester');
      await settle();
      engine.emitDisconnected('LOGOUT');
      await settle(80);

      await sessionService.delete(created.id);
      expect(engine.isDestroyed).toBe(true);
    }, 30_000);

    it('survives a database outage mid-session', async () => {
      const name = uniqueName('dbfail');
      const created = await sessionService.create({ name });
      await sessionService.start(created.id);
      const engine = engineFor(name);

      const unhandled: unknown[] = [];
      const onUnhandled = (r: unknown): void => {
        unhandled.push(r);
      };
      process.on('unhandledRejection', onUnhandled);

      // Simulate SQLITE_BUSY / a read-only filesystem while traffic is flowing.
      const spy = jest.spyOn(sessions, 'update').mockRejectedValue(new Error('SQLITE_BUSY: database is locked'));

      try {
        engine.emitReady('628777', 'Db Fail Tester');
        engine.emitMessage({ id: 'msg-dbfail', body: 'during outage' });
        await settle(250);

        // Nothing escapes as an unhandled rejection and the engine stays alive, so the
        // next event can still be processed once the database recovers.
        expect(unhandled).toEqual([]);
        expect(spy).toHaveBeenCalled();
      } finally {
        process.off('unhandledRejection', onUnhandled);
        spy.mockRestore();
        await sessionService.delete(created.id);
      }
    }, 30_000);

    it('recovers once the database comes back', async () => {
      const name = uniqueName('dbrecover');
      const created = await sessionService.create({ name });
      await sessionService.start(created.id);
      const engine = engineFor(name);

      const spy = jest.spyOn(sessions, 'update').mockRejectedValue(new Error('SQLITE_BUSY: database is locked'));
      engine.emitReady('628666', 'Recover Tester');
      engine.emitMessage({ id: 'msg-locked', body: 'while locked' });
      await settle(200);
      spy.mockRestore();

      // The writes that were dropped must not leave the session permanently stale.
      engine.emitReady('628665', 'Recovered Tester');
      await settle(200);

      const row = await sessions.findOneByOrFail({ id: created.id });
      expect(row.pushName).toBe('Recovered Tester');
      await sessionService.delete(created.id);
    }, 30_000);

    it('leaves no phantom engine behind when the driver fails to initialise', async () => {
      const name = uniqueName('initfail');
      const created = await sessionService.create({ name });

      nextInitError = new Error('chromium exited');
      await expect(sessionService.start(created.id)).rejects.toThrow('chromium exited');

      // The half-built browser must be cleaned up rather than left registered.
      const failedEngine = engineFor(name);
      expect(failedEngine.isDestroyed).toBe(true);

      // And the next attempt must not be blocked by a stale map entry.
      await expect(sessionService.start(created.id)).resolves.toBeDefined();
      // A brand new driver was created, because the failed one was torn down.
      const retryEngine = engineFor(name);
      expect(retryEngine).not.toBe(failedEngine);
      expect(retryEngine.callCounts.initialize).toBe(1);
      expect(retryEngine.isDestroyed).toBe(false);
      await sessionService.delete(created.id);
    }, 30_000);
  });

  // ── Concurrency ─────────────────────────────────────────────────

  describe('concurrent lifecycle calls', () => {
    it('rejects a duplicate concurrent start instead of leaking a browser', async () => {
      const name = uniqueName('race');
      const created = await sessionService.create({ name });

      const before = sessionService.getActiveCount();
      const [a, b] = await Promise.allSettled([sessionService.start(created.id), sessionService.start(created.id)]);

      const fulfilled = [a, b].filter(r => r.status === 'fulfilled').length;
      expect(fulfilled).toBe(1);
      // Exactly one new engine, no orphans.
      expect(sessionService.getActiveCount()).toBe(before + 1);
      expect(engineFor(name).callCounts.initialize).toBe(1);

      await sessionService.delete(created.id);
    }, 30_000);
  });

  // ── Shutdown ────────────────────────────────────────────────────

  describe('shutdown', () => {
    it('destroys every running engine and leaves none active', async () => {
      const firstName = uniqueName('shut-a');
      const secondName = uniqueName('shut-b');
      const first = await sessionService.create({ name: firstName });
      const second = await sessionService.create({ name: secondName });
      await sessionService.start(first.id);
      await sessionService.start(second.id);

      await sessionService.onModuleDestroy();

      expect(engineFor(firstName).isDestroyed).toBe(true);
      expect(engineFor(secondName).isDestroyed).toBe(true);
      expect(sessionService.getActiveCount()).toBe(0);
    }, 30_000);
  });

  // ── Webhook delivery ───────────────────────────────────────────

  describe('webhook delivery', () => {
    /**
     * A real HTTP server, on a real socket, so `WebhookService` performs a real `fetch`.
     * Every other test in this suite spies on `dispatch`, which means the request building,
     * the signature and the transport itself are otherwise never exercised.
     */
    let sink: http.Server;
    let sinkUrl: string;
    const received: Array<{ headers: http.IncomingHttpHeaders; body: WebhookPayload }> = [];
    let respondWith = 200;

    beforeAll(async () => {
      sink = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', c => chunks.push(c as Buffer));
        req.on('end', () => {
          received.push({
            headers: req.headers,
            // `JSON.parse` returns `any`; the receiving helper types it back on read.
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as WebhookPayload,
          });
          res.writeHead(respondWith).end(respondWith === 200 ? 'ok' : 'nope');
        });
      });
      await new Promise<void>(resolve => sink.listen(0, '127.0.0.1', resolve));
      const address = sink.address() as AddressInfo;
      sinkUrl = `http://127.0.0.1:${address.port}/hook`;
    });

    afterAll(async () => {
      await new Promise<void>(resolve => sink.close(() => resolve()));
    });

    it('delivers a real HTTP request with the documented headers and body', async () => {
      received.length = 0;
      respondWith = 200;

      const session = await sessionService.create({ name: uniqueName('wh') });
      await webhookService.create(session.id, {
        url: sinkUrl,
        events: ['message.received'],
        secret: 'topsecret',
        retryCount: 2,
      });

      await webhookService.dispatch(session.id, 'message.received', {
        messageId: 'wamid.real.1',
        from: '628123',
        body: 'hello',
      });

      expect(received).toHaveLength(1);
      const { headers, body } = received[0];

      expect(headers['content-type']).toBe('application/json');
      expect(headers['user-agent']).toBe('OpenWA-Webhook/1.0.0');
      expect(headers['x-openwa-event']).toBe('message.received');
      expect(headers['x-openwa-idempotency-key']).toBe('msg_wamid.real.1');
      expect(headers['x-openwa-delivery-id']).toMatch(/^dlv_/);
      expect(headers['x-openwa-retry-count']).toBe('0');

      // Signed with HMAC-SHA256 over the exact body, so the receiver can verify it.
      const expected = `sha256=${createHmac('sha256', 'topsecret').update(JSON.stringify(body)).digest('hex')}`;
      expect(headers['x-openwa-signature']).toBe(expected);

      expect(body).toMatchObject({
        event: 'message.received',
        sessionId: session.id,
        idempotencyKey: 'msg_wamid.real.1',
        data: { messageId: 'wamid.real.1', from: '628123', body: 'hello' },
      });
    });

    it('gives a redelivery the same idempotency key but a fresh delivery id', async () => {
      received.length = 0;

      const session = await sessionService.create({ name: uniqueName('wh-idem') });
      await webhookService.create(session.id, {
        url: sinkUrl,
        events: ['message.received'],
      });

      const event = { messageId: 'wamid.dupe.1', from: '628123', body: 'same' };
      await webhookService.dispatch(session.id, 'message.received', event);
      await webhookService.dispatch(session.id, 'message.received', event);

      expect(received).toHaveLength(2);

      // This is the whole point of the header: a receiver must be able to collapse the
      // retry, so the key is content-derived and stable across attempts.
      expect(received[0].body.idempotencyKey).toBe(received[1].body.idempotencyKey);
      expect(received[0].body.idempotencyKey).toBe('msg_wamid.dupe.1');

      // Meanwhile each attempt stays individually traceable.
      expect(received[0].body.deliveryId).not.toBe(received[1].body.deliveryId);
    });

    it('omits the signature when no secret is configured', async () => {
      received.length = 0;

      const session = await sessionService.create({ name: uniqueName('wh-nosig') });
      await webhookService.create(session.id, { url: sinkUrl, events: ['message.received'] });

      await webhookService.dispatch(session.id, 'message.received', { messageId: 'wamid.nosig.1' });

      expect(received).toHaveLength(1);
      expect(received[0].headers['x-openwa-signature']).toBeUndefined();
    });

    it('skips webhooks that do not subscribe to the event', async () => {
      received.length = 0;

      const session = await sessionService.create({ name: uniqueName('wh-filter') });
      await webhookService.create(session.id, { url: sinkUrl, events: ['message.sent'] });

      await webhookService.dispatch(session.id, 'message.received', { messageId: 'wamid.filter.1' });

      expect(received).toHaveLength(0);
    });

    it('skips an inactive webhook', async () => {
      received.length = 0;

      const session = await sessionService.create({ name: uniqueName('wh-inactive') });
      const webhook = await webhookService.create(session.id, {
        url: sinkUrl,
        events: ['message.received'],
      });
      await webhookRepository.update(webhook.id, { active: false });

      await webhookService.dispatch(session.id, 'message.received', { messageId: 'wamid.inactive.1' });

      expect(received).toHaveLength(0);
    });

    it('delivers to every matching webhook for one event', async () => {
      received.length = 0;

      const session = await sessionService.create({ name: uniqueName('wh-many') });
      await webhookService.create(session.id, { url: sinkUrl, events: ['message.received'] });
      await webhookService.create(session.id, { url: sinkUrl, events: ['*'] });

      await webhookService.dispatch(session.id, 'message.received', { messageId: 'wamid.many.1' });

      expect(received).toHaveLength(2);
      // The idempotency key is shared so a receiver can dedupe across its own endpoints.
      expect(received[0].body.idempotencyKey).toBe(received[1].body.idempotencyKey);
      expect(received[0].body.deliveryId).not.toBe(received[1].body.deliveryId);
    });

    it('retries a 5xx receiver and reports it through the error hook without throwing', async () => {
      received.length = 0;
      respondWith = 500;
      const onError = jest.fn();
      hookManager.register('test-plugin-500', 'webhook:error', onError);

      // Keep the real retry loop but collapse its backoff, otherwise each attempt sleeps
      // `webhook.retryDelay * attempt` (5s, then 10s) and the suite crawls.
      const spy = jest.spyOn(configService, 'get');
      spy.mockImplementation((key: string, defaultValue?: unknown) =>
        key === 'webhook.retryDelay' ? 5 : configServiceGetOriginal(key, defaultValue),
      );

      try {
        const session = await sessionService.create({ name: uniqueName('wh-500') });
        await webhookService.create(session.id, { url: sinkUrl, events: ['message.received'], retryCount: 3 });

        // A failing subscriber must not propagate out of dispatch: this runs on the message
        // path, where a throw would be treated as a failed inbound message.
        await expect(
          webhookService.dispatch(session.id, 'message.received', { messageId: 'wamid.500.1' }),
        ).resolves.toBeUndefined();

        // retryCount: 3 means three attempts in total, each flagged with its retry number.
        expect(received).toHaveLength(3);
        expect(received.map(r => r.headers['x-openwa-retry-count'])).toEqual(['0', '1', '2']);

        // The same delivery is retried, not a new one: a receiver deduping on deliveryId
        // would otherwise still see three distinct events.
        const deliveryIds = new Set(received.map(r => r.body.deliveryId));
        expect(deliveryIds.size).toBe(1);

        expect(onError).toHaveBeenCalledTimes(1);
        // Asserted field by field: `expect.any()` / `expect.stringContaining()` return `any`.
        const errorEvent = (onError.mock.calls as Array<[WebhookErrorEvent]>)[0][0];
        expect(errorEvent.event).toBe('webhook:error');
        expect(typeof errorEvent.data.webhookId).toBe('string');
        expect(errorEvent.data.error).toContain('500');
      } finally {
        spy.mockRestore();
        hookManager.unregisterPlugin('test-plugin-500');
        respondWith = 200;
      }
    });

    it('stops retrying once the receiver recovers', async () => {
      received.length = 0;
      let attempts = 0;
      const flaky = http.createServer((req, res) => {
        attempts++;
        const chunks: Buffer[] = [];
        req.on('data', c => chunks.push(c as Buffer));
        req.on('end', () => {
          const ok = attempts >= 2;
          res.writeHead(ok ? 200 : 500).end(ok ? 'ok' : 'nope');
        });
      });
      await new Promise<void>(resolve => flaky.listen(0, '127.0.0.1', resolve));
      const flakyUrl = `http://127.0.0.1:${(flaky.address() as AddressInfo).port}/flaky`;

      const spy = jest.spyOn(configService, 'get');
      spy.mockImplementation((key: string, defaultValue?: unknown) =>
        key === 'webhook.retryDelay' ? 5 : configServiceGetOriginal(key, defaultValue),
      );

      try {
        const session = await sessionService.create({ name: uniqueName('wh-flaky') });
        await webhookService.create(session.id, { url: flakyUrl, events: ['message.received'], retryCount: 3 });

        await expect(
          webhookService.dispatch(session.id, 'message.received', { messageId: 'wamid.flaky.1' }),
        ).resolves.toBeUndefined();

        expect(attempts).toBe(2);
      } finally {
        spy.mockRestore();
        await new Promise<void>(resolve => flaky.close(() => resolve()));
      }
    });

    it('records lastTriggeredAt only after a successful delivery', async () => {
      received.length = 0;
      respondWith = 200;

      const session = await sessionService.create({ name: uniqueName('wh-touched') });
      const webhook = await webhookService.create(session.id, {
        url: sinkUrl,
        events: ['message.received'],
        retryCount: 1,
      });
      expect(webhook.lastTriggeredAt).toBeNull();

      await webhookService.dispatch(session.id, 'message.received', { messageId: 'wamid.touched.1' });

      const reloaded = await webhookService.findOne(webhook.id);
      expect(reloaded.lastTriggeredAt).toBeInstanceOf(Date);

      respondWith = 500;
      const other = await sessionService.create({ name: uniqueName('wh-untouched') });
      const failing = await webhookService.create(other.id, {
        url: sinkUrl,
        events: ['message.received'],
        retryCount: 1,
      });
      await webhookService.dispatch(other.id, 'message.received', { messageId: 'wamid.untouched.1' });

      expect((await webhookService.findOne(failing.id)).lastTriggeredAt).toBeNull();
      respondWith = 200;
    });
  });

  // ── DataSource teardown ─────────────────────────────────────────

  describe('database teardown', () => {
    it('closes both named DataSources on shutdown', async () => {
      // Regression guard. Passing `name` to forRootAsync() is not enough: TypeORM's
      // shutdown hook resolves the DataSource from the object the `useFactory` *returns*,
      // and a name missing there resolves to the bare `DataSource` token. The lookup then
      // throws and BOTH SQLite connections stay open — no WAL checkpoint, and app.close()
      // rejects, so SIGTERM ends in a kill rather than a clean stop.
      //
      // A second application instance is booted so this can assert on close() itself; it
      // shares the same SQLite files as the outer app, which is harmless because each
      // Nest application owns its own connections.
      const fresh = await NestFactory.create(AppModule, { logger: false });
      await fresh.init();

      const main = fresh.get<DataSource>(getDataSourceToken('main'));
      const data = fresh.get<DataSource>(getDataSourceToken('data'));
      expect(main.isInitialized).toBe(true);
      expect(data.isInitialized).toBe(true);

      // Must not reject: a rejected close leaves the process to be SIGKILLed.
      await expect(fresh.close()).resolves.toBeUndefined();

      expect(main.isInitialized).toBe(false);
      expect(data.isInitialized).toBe(false);
    }, 90_000);
  });
});
