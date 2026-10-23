// Convenience runner for the end-to-end test: starts its own server in test
// mode on a free port, waits for it, runs tests/e2e.mjs, then shuts it down.
//
//   node tests/run-e2e.mjs

import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForServer(base, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${base}/api/rooms`);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js'), String(port), '--test'], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

const up = await waitForServer(base);
if (!up) {
  console.error('服务启动失败');
  server.kill();
  process.exit(1);
}

let code = 0;
for (const [file, args] of [
  ['tests/liar-engine.mjs', []],
  ['tests/e2e.mjs', [base]],
  ['tests/liar.mjs', [base]],
]) {
  console.log(`\n=== ${file} ===`);
  const test = spawn(process.execPath, [path.join(ROOT, file), ...args], { cwd: ROOT, stdio: 'inherit' });
  const exit = await new Promise((r) => test.on('exit', r));
  if (exit !== 0) { code = exit; break; }
}
server.kill();
process.exit(code ?? 1);
