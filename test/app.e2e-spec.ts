import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { Server } from 'http';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * supertest types `response.body` as `any` and `getHttpServer()` as `any`, so every
 * `response.body.status` read was an unchecked property access on `any`. These two helpers
 * are the single place that knows about it, which keeps the assertions below type-checked.
 */
type LivenessBody = { status: string; timestamp: string; uptimeSeconds: number };
type ReadinessBody = {
  status: string;
  timestamp: string;
  uptimeSeconds: number;
  details?: Record<string, { status: string; optional?: boolean }>;
};

function httpServer(app: INestApplication): Server {
  return app.getHttpServer() as Server;
}

function bodyOf<T>(response: { body: unknown }): T {
  return response.body as T;
}

/**
 * Smoke test for the HTTP surface itself: the root route and liveness.
 *
 * The original file here was the stock `nest new` scaffold. It asserted a `Hello World!`
 * root route that this project does not have (the root serves the API docs), booted the
 * app against the developer's real `./data` SQLite files, and never called `app.close()`,
 * so it both failed and leaked open connections. Behaviour coverage lives in
 * `integration/app.e2e-spec.ts`; this file only guards the top-level routes.
 *
 * Environment must be set before `AppModule` is imported — `configuration.ts` is evaluated
 * at import time by `ConfigModule.forRoot({ load: [configuration] })`.
 */
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openwa-e2e-root-'));
process.env.DATABASE_MAIN_NAME = path.join(tmpRoot, 'main.sqlite');
process.env.DATABASE_NAME = path.join(tmpRoot, 'data.sqlite');
process.env.STORAGE_LOCAL_PATH = path.join(tmpRoot, 'media');
process.env.SESSION_DATA_PATH = path.join(tmpRoot, 'sessions');
process.env.QUEUE_ENABLED = 'false';
process.env.CACHE_ENABLED = 'false';
// Booting AppModule runs AuthService.onModuleInit, which seeds an admin key. Without this
// the suite writes to the shared ./data/.api-key and invalidates the live instance's key.
process.env.AUTH_KEY_FILE = path.join(tmpRoot, '.api-key');

import { AppModule } from './../src/app.module';

describe('HTTP surface (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    // Mirrors src/main.ts:147. The prefix is applied in the bootstrap, not the module, so
    // without this the real URLs (`/api/health/ready`) would 404 here and the test would
    // quietly stop covering what the healthcheck and watchdog actually call.
    app.setGlobalPrefix('api', { exclude: ['/'] });
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('/ (GET) serves HTML with the dashboard mount point', async () => {
    const response = await request(httpServer(app)).get('/').expect(200);

    expect(response.headers['content-type']).toMatch(/text\/html/);
    // Whether this is the built SPA or the API-only fallback page, the user must land on a
    // real document. This assertion used to check for a link to /api/docs, which only
    // existed on the fallback page and silently stopped testing anything once the dashboard
    // started being served from `/`.
    expect(response.text).toContain('<div id="root">');
  });

  it('/ (GET) serves the built dashboard when one is present', async () => {
    // Builds a throwaway dashboard bundle so the SPA branch is exercised without depending on
    // the developer having run `npm --prefix dashboard run build`.
    const distDir = path.join(tmpRoot, 'dashboard-dist');
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(
      path.join(distDir, 'index.html'),
      '<!doctype html><html><body><div id="root"></div></body></html>',
    );
    process.env.DASHBOARD_DIR = distDir;

    const response = await request(httpServer(app)).get('/').expect(200);

    expect(response.text).toContain('<div id="root">');
    delete process.env.DASHBOARD_DIR;
  });

  it('/api/health (GET) reports liveness without touching dependencies', async () => {
    const response = await request(httpServer(app)).get('/api/health').expect(200);

    // Deliberately dependency-free, so a database outage must not make this fail.
    // Asserted field by field rather than with `expect.any(...)`, whose return type is `any`.
    const body = bodyOf<LivenessBody>(response);
    expect(body.status).toBe('ok');
    expect(typeof body.timestamp).toBe('string');
    expect(typeof body.uptimeSeconds).toBe('number');
  });

  it('/api/health/live (GET) is an alias of the liveness probe', async () => {
    const response = await request(httpServer(app)).get('/api/health/live').expect(200);

    expect(bodyOf<LivenessBody>(response).status).toBe('ok');
  });

  it('/api/health/ready (GET) reports every dependency', async () => {
    const response = await request(httpServer(app)).get('/api/health/ready').expect(200);

    const body = bodyOf<ReadinessBody>(response);
    expect(body.status).toBe('ok');
    expect(body.details).toMatchObject({
      database_main: { status: 'up' },
      database_data: { status: 'up' },
    });
    // Optional dependencies are reported but must not gate readiness.
    expect(body.details?.redis).toBeDefined();
  });

  it('the path the healthcheck and watchdog poll is a real, live route', async () => {
    // Guards the wiring rather than the endpoint: Dockerfile, docker-compose.yml,
    // docker-compose.dev.yml and deploy/watch-openwa.ps1 all poll this exact URL and act on
    // the status code. They were previously pointed at the liveness route, which always
    // answers 200, so a wedged process looked healthy and nothing ever restarted it.
    //
    // watchdog.js was removed in dd2b769: it predated deploy/watch-openwa.ps1, which is what
    // the OpenWA scheduled task actually runs. The list below must name only files that exist,
    // or this test fails on a missing path instead of on a real regression.
    const healthcheck = await request(httpServer(app)).get('/api/health/ready').expect(200);

    // The check is `statusCode === 200`, so a body-only failure indicator would be ignored.
    expect(healthcheck.status).toBe(200);
    expect(bodyOf<ReadinessBody>(healthcheck).status).toBe('ok');

    const supervisors = ['Dockerfile', 'docker-compose.yml', 'docker-compose.dev.yml', 'deploy/watch-openwa.ps1'];

    for (const relPath of supervisors) {
      const absolute = path.join(__dirname, '..', relPath);
      if (!fs.existsSync(absolute)) {
        throw new Error(`${relPath} is referenced here but does not exist`);
      }

      const contents = fs.readFileSync(absolute, 'utf8');
      if (!contents.includes('/api/health/ready')) {
        throw new Error(`${relPath} does not poll /api/health/ready; it would never detect a wedged instance`);
      }
      if (/localhost:2785\/api\/health'/.test(contents)) {
        throw new Error(`${relPath} still polls the liveness route, which always returns 200`);
      }
    }
  });
});
