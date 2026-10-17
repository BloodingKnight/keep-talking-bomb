// 量启动耗时：从"点开"到"端口能响应"到底花在哪。
//   node tools/bench-start.mjs
// 用 stdio:'ignore' 启动子进程，自己退出，不会把命令挂住。
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const ROOT = path.resolve(import.meta.dirname, '..');

const cases = [
  {
    name: 'node server.js（磁盘版）',
    port: 3490,
    cmd: process.execPath,
    args: ['server/server.js', '3490'],
    cwd: ROOT,
  },
  {
    name: 'BombGame.exe（单文件 SEA，GUI）',
    port: 3491,
    cmd: path.join(ROOT, 'dist', 'BombGame.exe'),
    args: ['3491'],
    cwd: ROOT,
  },
  {
    name: '安装包里的 node + 游戏',
    port: 3492,
    cmd: path.join(ROOT, 'src-tauri', 'bundle-assets', 'node.exe'),
    args: ['server/server.js', '3492'],
    cwd: path.join(ROOT, 'src-tauri', 'bundle-assets'),
  },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function up(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/rooms`, { signal: AbortSignal.timeout(800) });
    return res.ok;
  } catch {
    return false;
  }
}

const results = [];
for (const c of cases) {
  if (!fs.existsSync(c.cmd)) {
    console.log(`- ${c.name}: 跳过（找不到 ${path.relative(ROOT, c.cmd)}）`);
    continue;
  }
  const t0 = performance.now();
  const child = spawn(c.cmd, c.args, { cwd: c.cwd, stdio: 'ignore', windowsHide: true });
  let tUp = 0;
  for (let i = 0; i < 1200; i++) {
    if (await up(c.port)) {
      tUp = performance.now() - t0;
      break;
    }
    if (child.exitCode !== null) break;
    await sleep(20);
  }
  child.kill();
  await sleep(300);
  if (tUp) {
    console.log(`  ${c.name.padEnd(34)} ${String(Math.round(tUp)).padStart(5)} ms`);
    results.push({ name: c.name, ms: Math.round(tUp) });
  } else {
    console.log(`  ${c.name.padEnd(34)}   失败（未起来）`);
  }
}

if (results.length) {
  const min = Math.min(...results.map((r) => r.ms));
  console.log('');
  for (const r of results) console.log(`  ${r.name.padEnd(34)} 相对基线 +${r.ms - min} ms`);
}
