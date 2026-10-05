/**
 * Cross-platform postinstall.
 *
 * Replaces the previous POSIX-only `[ -d dashboard ] && npm run dashboard:install || true`
 * which aborted `npm install` on Windows (cmd.exe has no `&&`/`||` in that context and no
 * `-d` test operator), leaving the dashboard dependencies uninstalled.
 *
 * Never fails the install: a missing dashboard folder or a failed dashboard install is a
 * warning, not an error, so the API can still be built and run on its own.
 */
const { existsSync } = require('fs');
const { join } = require('path');
const { spawnSync } = require('child_process');

const root = join(__dirname, '..');
const dashboard = join(root, 'dashboard');

if (!existsSync(dashboard)) {
  console.log('[postinstall] No dashboard/ directory found, skipping dashboard install.');
  process.exit(0);
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

console.log('[postinstall] Installing dashboard dependencies...');
const result = spawnSync(npm, ['install', '--no-audit', '--no-fund'], {
  cwd: dashboard,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

if (result.status !== 0) {
  console.warn(
    '[postinstall] Dashboard dependency install did not complete cleanly. ' +
      'The API is unaffected; run `npm run dashboard:install` manually if you need the UI.',
  );
}

process.exit(0);
