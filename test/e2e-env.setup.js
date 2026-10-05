/**
 * Test environment, applied before any test module is imported.
 *
 * The suites need DATABASE_*, STORAGE_LOCAL_PATH, SESSION_DATA_PATH and AUTH_KEY_FILE to point
 * at a temp directory instead of the live ./data tree. They used to set these inline, above
 * their `import { AppModule }` line, and appeared to work - until the e2e run started dropping
 * empty `session-lifecycle-*` folders into the real data/sessions directory.
 *
 * The reason is import hoisting: TypeScript emits every `import` as a `require` at the top of the
 * compiled file, ahead of the surrounding statements. So `AppModule` - and with it the
 * `configuration()` factory inside ConfigModule, which reads SESSION_DATA_PATH when it is
 * evaluated - had already run before the assignments below them had executed. The session path
 * therefore resolved to the .env default (./data/sessions) and the real engine created its
 * browser profile in the live folder. `setupFiles` run before the test framework is installed
 * and before any test file is required, so this environment is guaranteed to be in place first.
 *
 * Jest runs one test file per worker process, so this file executes once per suite and each
 * suite gets its own temp root. That isolation has to stay per-suite: an earlier attempt shared
 * a single root through `globalSetup`, which let the two suites write the same SQLite files at
 * the same time. The result was SQLITE_BUSY under concurrency, and the second suite to boot
 * found the first one's session rows and tried to resume them with a real Chromium.
 *
 * Each suite removes its own root in `afterAll`, which runs in the same process that created it.
 * `OPENWA_E2E_TMP_ROOT` is exported for exactly that.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openwa-e2e-'));

process.env.DATABASE_MAIN_NAME = path.join(tmpRoot, 'main.sqlite');
process.env.DATABASE_NAME = path.join(tmpRoot, 'data.sqlite');
process.env.STORAGE_LOCAL_PATH = path.join(tmpRoot, 'media');
process.env.SESSION_DATA_PATH = path.join(tmpRoot, 'sessions');
process.env.QUEUE_ENABLED = 'false';
process.env.CACHE_ENABLED = 'false';
process.env.REDIS_ENABLED = 'false';
// Booting AppModule runs AuthService.onModuleInit, which seeds an admin key. Without this the
// suite writes to the shared ./data/.api-key and invalidates the live instance's key.
process.env.AUTH_KEY_FILE = path.join(tmpRoot, '.api-key');
// The suites reproduce the default production boot path, where the data DB relies on migrations
// rather than synchronize. Deleting it here means a developer's .env cannot leak in.
delete process.env.DATABASE_SYNCHRONIZE;

// No suite asserts on startup resume, and none of them override EngineFactory on every app
// instance they boot. Without this, SessionService.onModuleInit resumes any session left in a
// live state through the real whatsapp-web.js adapter, which launches Chromium and writes a
// profile directory to disk.
process.env.SESSION_AUTOSTART = 'false';

process.env.OPENWA_E2E_TMP_ROOT = tmpRoot;
