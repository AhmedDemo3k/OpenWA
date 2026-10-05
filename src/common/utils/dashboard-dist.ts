import * as fs from 'fs';
import * as path from 'path';

/**
 * Locates the built dashboard, or returns null when it has not been built.
 *
 * The dashboard is a Vite SPA that calls `/api` with a relative path, so it only functions
 * when it is served from the same origin as the API. Both `main.ts` (which mounts the static
 * assets and the SPA fallback) and `RootController` (which answers `/`) go through here, so
 * the two can never disagree about whether a build is present.
 *
 * `DASHBOARD_DIR` exists so tests can point at a fixture. It defaults to `<cwd>/dashboard/dist`,
 * which is where `npm --prefix dashboard run build` writes.
 */
export function resolveDashboardIndex(): string | null {
  const distDir = process.env.DASHBOARD_DIR
    ? path.resolve(process.env.DASHBOARD_DIR)
    : path.resolve(process.cwd(), 'dashboard', 'dist');

  const indexFile = path.join(distDir, 'index.html');
  return fs.existsSync(indexFile) ? indexFile : null;
}
