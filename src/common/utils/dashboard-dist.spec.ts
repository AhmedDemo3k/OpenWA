import { resolveDashboardIndex } from './dashboard-dist';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('resolveDashboardIndex', () => {
  let tmpRoot: string;
  const originalDashboardDir = process.env.DASHBOARD_DIR;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openwa-dashboard-dist-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    if (originalDashboardDir === undefined) delete process.env.DASHBOARD_DIR;
    else process.env.DASHBOARD_DIR = originalDashboardDir;
  });

  /** Writes a minimal Vite-shaped build and points DASHBOARD_DIR at it. */
  function withBuild(dir: string, entry = '<div id="root"></div>'): void {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), entry);
    process.env.DASHBOARD_DIR = dir;
  }

  it('defaults to <cwd>/dashboard/dist, which is where the dashboard build writes', () => {
    delete process.env.DASHBOARD_DIR;

    const resolved = resolveDashboardIndex();

    // Either outcome is valid, but it must never be somewhere outside the dashboard folder:
    // resolving against the wrong root is how a stale or unrelated index.html gets served at /.
    if (resolved !== null) {
      expect(resolved).toBe(path.resolve(process.cwd(), 'dashboard', 'dist', 'index.html'));
    }
  });

  it('returns null when DASHBOARD_DIR points at a missing directory', () => {
    process.env.DASHBOARD_DIR = path.join(tmpRoot, 'does-not-exist');

    expect(resolveDashboardIndex()).toBeNull();
  });

  it('returns null when DASHBOARD_DIR points at a directory with no build in it', () => {
    const empty = path.join(tmpRoot, 'empty');
    fs.mkdirSync(empty, { recursive: true });
    process.env.DASHBOARD_DIR = empty;

    expect(resolveDashboardIndex()).toBeNull();
  });

  it('resolves index.html inside DASHBOARD_DIR when the build is present', () => {
    withBuild(tmpRoot);

    expect(resolveDashboardIndex()).toBe(path.join(tmpRoot, 'index.html'));
  });

  it('does not mistake a sibling asset for the entry point', () => {
    // Only index.html counts. A directory holding assets but no entry document is not
    // servable, and answering `/` with it would render a blank page.
    fs.mkdirSync(tmpRoot, { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'favicon.svg'), '<svg />');
    fs.mkdirSync(path.join(tmpRoot, 'assets'), { recursive: true });
    process.env.DASHBOARD_DIR = tmpRoot;

    expect(resolveDashboardIndex()).toBeNull();
  });

  it('prefers a relative DASHBOARD_DIR by resolving it against the cwd', () => {
    withBuild(path.join(tmpRoot, 'dist'));
    process.env.DASHBOARD_DIR = path.relative(process.cwd(), path.join(tmpRoot, 'dist'));

    expect(resolveDashboardIndex()).toBe(path.join(tmpRoot, 'dist', 'index.html'));
  });
});
