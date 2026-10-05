/**
 * Watchdog - يراقب الخدمات ويعيد تشغيلها لو وقعت
 * شغله في خلفية: node watchdog.js
 */
const { exec } = require('child_process');
const http = require('http');

// Readiness is polled, not liveness: `/api/health` is dependency-free and answers 200 for
// as long as the event loop turns, so a gateway wedged on a dead database or a blocked
// event loop would be restarted for the wrong reason (or never) while looking perfectly
// healthy. `/api/health/ready` returns 503 once a required dependency is unreachable, and
// this watchdog supervises a single local instance, so restarting it is safe.
const services = [
  { name: 'OpenWA API', url: 'http://localhost:2785/api/health/ready', cwd: __dirname, cmd: 'npm run dev' },
  { name: 'Auto-Reply Bot', url: 'http://localhost:3001/health', cwd: __dirname + '/auto-reply-bot', cmd: 'node index.js' },
];

const CHECK_INTERVAL = 15000;
let processes = {};

function checkService(service) {
  return new Promise(resolve => {
    const req = http.get(service.url, { timeout: 5000 }, res => {
      resolve(res.statusCode === 200);
      res.resume();
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function startService(service) {
  if (processes[service.name]) return;
  console.log(`[${new Date().toLocaleTimeString()}] Starting ${service.name}...`);
  const p = exec(`start "watchdog-${service.name}" cmd /c ${service.cmd}`, { cwd: service.cwd });
  processes[service.name] = p;
  p.on('exit', () => {
    delete processes[service.name];
    console.log(`[${new Date().toLocaleTimeString()}] ${service.name} stopped.`);
  });
}

async function watch() {
  console.log(`\n=== Watchdog Started - Checking every ${CHECK_INTERVAL/1000}s ===\n`);
  for (const svc of services) await startService(svc);

  setInterval(async () => {
    for (const svc of services) {
      const alive = await checkService(svc);
      if (!alive) {
        console.log(`[${new Date().toLocaleTimeString()}] ${svc.name} DOWN! Restarting...`);
        startService(svc);
      }
    }
  }, CHECK_INTERVAL);
}

watch();
