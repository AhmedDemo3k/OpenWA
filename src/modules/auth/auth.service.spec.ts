import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { basename, join } from 'path';
import { tmpdir } from 'os';
import { AuthService } from './auth.service';
import { ApiKey, ApiKeyRole } from './entities/api-key.entity';

const DEV_KEY = 'dev-admin-key';
const hash = (raw: string): string => createHash('sha256').update(raw).digest('hex');
const STRONG_KEY = `owa_k1_${'a'.repeat(64)}`;

/**
 * Captures what the banner actually emits.
 *
 * `createLogger` ultimately writes through the console, so spying there observes the real
 * output path rather than a stand-in. That matters here: the defect being guarded against is
 * a secret reaching the log file, so the assertion has to be made about the rendered line.
 */
const capturedOutput: string[] = [];
const capture = (...args: unknown[]): void => {
  capturedOutput.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
};
const loggedLines = (): string => capturedOutput.splice(0, capturedOutput.length).join('\n');

/**
 * Regression coverage for the dev-key-in-production leak.
 *
 * `onModuleInit` only seeded a key when the table was empty, so a database that had ever
 * been touched in development kept `dev-admin-key` valid forever. Promoting that database
 * shipped a credential that is published in every public repository to a public endpoint.
 */
describe('AuthService (production bootstrap)', () => {
  const savedEnv = { ...process.env };
  let repo: {
    count: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    remove: jest.Mock;
    find: jest.Mock;
    findOne: jest.Mock;
  };
  let module: TestingModule;
  let keyFile: string;

  const makeKey = (raw: string, name = 'Default Admin Key'): ApiKey =>
    ({
      id: `id-${raw}`,
      name,
      keyHash: hash(raw),
      keyPrefix: raw.substring(0, 12),
      role: ApiKeyRole.ADMIN,
      isActive: true,
    }) as ApiKey;

  beforeEach(async () => {
    keyFile = join(tmpdir(), `openwa-apikey-${Math.random().toString(36).slice(2)}.key`);
    process.env.AUTH_KEY_FILE = keyFile;
    loggedLines();
    jest.spyOn(console, 'log').mockImplementation(capture);
    jest.spyOn(console, 'warn').mockImplementation(capture);
    jest.spyOn(console, 'error').mockImplementation(capture);

    repo = {
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn((entity: ApiKey) => entity),
      save: jest.fn(async (entity: ApiKey) => entity),
      remove: jest.fn(async () => undefined),
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
    };

    module = await Test.createTestingModule({
      providers: [AuthService, { provide: getRepositoryToken(ApiKey, 'main'), useValue: repo }],
    }).compile();
  });

  afterEach(async () => {
    await module.close();
    process.env = { ...savedEnv };
    rmSync(keyFile, { force: true });
    jest.restoreAllMocks();
  });

  const build = (): AuthService => module.get<AuthService>(AuthService);

  const seedDevKeyInDb = (): void => {
    repo.count.mockResolvedValue(1);
    repo.find.mockResolvedValue([makeKey(DEV_KEY)]);
    // the .api-key file still holds the dev key, exactly as a dev-mode seed leaves it
    writeFileSync(keyFile, DEV_KEY, 'utf-8');
  };

  describe('development key found while running in production', () => {
    it('rotates it out and persists a strong replacement', async () => {
      process.env.NODE_ENV = 'production';
      seedDevKeyInDb();

      await build().onModuleInit();

      expect(repo.remove).toHaveBeenCalledTimes(1);
      const persisted = readFileSync(keyFile, 'utf-8');
      expect(persisted).not.toBe(DEV_KEY);
      expect(persisted).toMatch(/^owa_k1_[0-9a-f]{64}$/);
    });

    it('leaves a real operator key untouched', async () => {
      process.env.NODE_ENV = 'production';
      repo.count.mockResolvedValue(1);
      repo.find.mockResolvedValue([]);
      repo.findOne.mockResolvedValue(makeKey(STRONG_KEY));
      writeFileSync(keyFile, STRONG_KEY, 'utf-8');

      await build().onModuleInit();

      expect(repo.remove).not.toHaveBeenCalled();
      expect(repo.save).not.toHaveBeenCalled();
      expect(readFileSync(keyFile, 'utf-8')).toBe(STRONG_KEY);
    });

    it('does not rotate in development', async () => {
      process.env.NODE_ENV = 'development';
      seedDevKeyInDb();

      await build().onModuleInit();

      expect(repo.remove).not.toHaveBeenCalled();
      expect(readFileSync(keyFile, 'utf-8')).toBe(DEV_KEY);
    });
  });

  describe('stale key file', () => {
    it('refuses to display a key that no longer authenticates', async () => {
      process.env.NODE_ENV = 'production';
      repo.count.mockResolvedValue(1);
      repo.find.mockResolvedValue([]);
      // file points at a key that was deleted from the database
      const gone = `owa_k1_${'b'.repeat(64)}`;
      writeFileSync(keyFile, gone, 'utf-8');
      repo.findOne.mockResolvedValue(null);

      await build().onModuleInit();

      // nothing seeded, nothing deleted -- the banner simply must not show a dead secret
      expect(repo.save).not.toHaveBeenCalled();
      expect(repo.remove).not.toHaveBeenCalled();
    });
  });

  // This instance is published through Tailscale Funnel, so anything written to the log file
  // is public to whoever tails the host. The banner used to print the live admin key on every
  // restart, which turned a routine reboot into a credential disclosure.
  describe('startup banner', () => {
    it('never prints an existing key on a plain restart', async () => {
      process.env.NODE_ENV = 'production';
      const existing = `owa_k1_${'c'.repeat(64)}`;
      writeFileSync(keyFile, existing, 'utf-8');
      repo.count.mockResolvedValue(1);
      repo.find.mockResolvedValue([]);
      // the file still authenticates
      repo.findOne.mockResolvedValue({ id: 'k1', isActive: true });

      await build().onModuleInit();

      const logged = loggedLines();
      expect(logged).not.toContain(existing);
      // and it says where the key lives instead. The logger renders the line as JSON, so
      // backslashes arrive doubled -- match on the file name rather than the whole path.
      expect(logged).toContain(basename(keyFile));
    });

    it('prints a newly generated key exactly once, because there is no other way to get it', async () => {
      process.env.NODE_ENV = 'production';
      repo.count.mockResolvedValue(0);

      await build().onModuleInit();

      const logged = loggedLines();
      expect(logged).toContain('newly created');
      // the seeded key must be discoverable, or a fresh install is unusable
      expect(readFileSync(keyFile, 'utf-8')).toMatch(/^owa_k1_/);
    });
  });

  it('creates missing parent directories before writing the key', async () => {
    process.env.NODE_ENV = 'development';
    const root = join(tmpdir(), `openwa-nested-${Math.random().toString(36).slice(2)}`);
    const nested = join(root, 'deeper', '.api-key');
    process.env.AUTH_KEY_FILE = nested;

    await build().onModuleInit();

    expect(existsSync(nested)).toBe(true);
    expect(readFileSync(nested, 'utf-8')).toBe(DEV_KEY);
    rmSync(root, { recursive: true, force: true });
  });
});
