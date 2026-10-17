// 打一个"真·单文件" exe：Node SEA（Single Executable Application）。
//
//   node tools/build-single.mjs
//   -> dist/BombGame.exe                （约 91 MB，双击即玩：没有黑框，直接开浏览器）
//   -> dist/BombGame-win-x64-single.zip （只含那一个 exe）
//
// 关键设计：
//   1. client/ 的静态文件内联进 JS，运行时不往磁盘释放任何文件（避免被当成"释放器"）；
//   2. server/ 与 lib/ 用 esbuild 打成一个 CJS bundle，作为 SEA 的 main；
//   3. 注入后把 PE 头的 Subsystem 从 CONSOLE(3) 改成 WINDOWS_GUI(2) —— 双击不再弹黑色控制台窗口；
//   4. 没有控制台了，所以运行日志写文件（%LOCALAPPDATA%\BombGame\BombGame.log，
//      不可写时退回 exe 同级），出错时弹一个 Windows 消息框而不是静默消失。
//
// 打包机依赖（玩家不需要）：
//   cd .build && npm install --ignore-scripts postject esbuild
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { zipEntries } from './lib-zip.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const BUILD_DIR = path.join(ROOT, '.build');
const DIST = path.join(ROOT, 'dist');
const EXE = path.join(DIST, 'BombGame.exe');
const POSTJECT = path.join(BUILD_DIR, 'node_modules', 'postject', 'dist', 'cli.js');
const ESBUILD = path.join(BUILD_DIR, 'node_modules', '@esbuild', 'win32-x64', 'esbuild.exe');
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

for (const [what, file] of [
  ['postject', POSTJECT],
  ['esbuild', ESBUILD],
]) {
  if (!fs.existsSync(file)) {
    console.error(`[build] 缺少 ${what}，请先执行:`);
    console.error('        cd .build && npm install --ignore-scripts postject esbuild');
    process.exit(1);
  }
}

// ---------------------------------------------------------------- 内联 client/
const assets = {};
let assetBytes = 0;
const walk = (abs, rel) => {
  for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
    const r = rel ? rel + '/' + ent.name : ent.name;
    if (ent.isDirectory()) walk(path.join(abs, ent.name), r);
    else {
      const text = fs.readFileSync(path.join(abs, ent.name), 'utf8');
      assets[r] = text;
      assetBytes += Buffer.byteLength(text);
    }
  }
};
walk(path.join(ROOT, 'client'), '');
console.log(`[build] 内联 client/: ${Object.keys(assets).length} 个文件, ${(assetBytes / 1024).toFixed(0)} KB`);

fs.writeFileSync(
  path.join(BUILD_DIR, 'client-assets.cjs'),
  '// 由 tools/build-single.mjs 生成：内联的 client/ 静态文件\nmodule.exports = ' + JSON.stringify(assets) + ';\n',
  'utf8',
);

// ---------------------------------------------------------------- 入口
const mainSrc = `'use strict';
// 由 tools/build-single.mjs 生成：单文件入口（GUI 子系统，没有控制台窗口）
const cp = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const os = require('node:os');

globalThis.__BOMB_EMBEDDED_CLIENT__ = require('./client-assets.cjs');

const ARG = String(process.argv[2] || '').toLowerCase();
const PORT = Number(
  process.env.PORT || (process.argv[2] && /^[0-9]+$/.test(process.argv[2]) ? process.argv[2] : 3210),
);

// 状态目录：LOCALAPPDATA -> 临时目录 -> exe 同级。日志和 pid 都放这里。
function pickStateDir() {
  const cands = [];
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  cands.push(path.join(local, 'BombGame'));
  try { cands.push(path.join(os.tmpdir(), 'BombGame')); } catch (e) {}
  cands.push(path.join(path.dirname(process.execPath)));
  for (const d of cands) {
    try {
      fs.mkdirSync(d, { recursive: true });
      fs.appendFileSync(path.join(d, '.probe'), '');
      return d;
    } catch (e) {}
  }
  return null;
}
const STATE_DIR = pickStateDir();
const LOG = STATE_DIR ? path.join(STATE_DIR, 'BombGame.log') : null;
const PID_FILE = STATE_DIR ? path.join(STATE_DIR, 'BombGame.pid') : null;

function logLine(text) {
  if (!LOG) return;
  try { fs.appendFileSync(LOG, '[' + new Date().toISOString() + '] ' + text + '\\n'); } catch (e) {}
}

// 没有控制台，console 输出一律进日志
const write = function () {
  logLine(Array.prototype.map.call(arguments, function (x) { return typeof x === 'string' ? x : JSON.stringify(x); }).join(' '));
};
console.log = write;
console.error = write;
console.info = write;
console.warn = write;

// ---------------------------------------------------------------- 弹窗 / 通知 / 浏览器
function spawnHidden(args) {
  try {
    cp.spawn('powershell.exe', ['-NoProfile', '-STA', '-WindowStyle', 'Hidden', '-Command', args], {
      stdio: 'ignore',
      windowsHide: true,
      detached: true,
    }).unref();
  } catch (e) {}
}

function showBox(title, text) {
  logLine('box: ' + title + ' | ' + text.replace(/\\n/g, ' / '));
  if (process.env.BOMB_SILENT === '1') return;
  spawnHidden(
    'Add-Type -AssemblyName PresentationFramework;' +
      '[System.Windows.MessageBox]::Show(' + JSON.stringify(text) + ',' + JSON.stringify(title) + ') | Out-Null',
  );
}

// 启动成功时弹一个托盘气泡：让用户"知道成功了"，而不是猜
function toast(title, text) {
  logLine('toast: ' + title);
  if (process.env.BOMB_SILENT === '1') return;
  spawnHidden(
    'Add-Type -AssemblyName System.Windows.Forms;' +
      'Add-Type -AssemblyName System.Drawing;' +
      '$n = New-Object System.Windows.Forms.NotifyIcon;' +
      '$n.Icon = [System.Drawing.SystemIcons]::Information;' +
      '$n.Visible = $true;' +
      '$n.ShowBalloonTip(6000, ' + JSON.stringify(title) + ', ' + JSON.stringify(text) + ', [System.Windows.Forms.ToolTipIcon]::Information);' +
      'Start-Sleep -Seconds 7;' +
      '$n.Dispose()',
  );
}

function openBrowser(url) {
  logLine('open browser: ' + url);
  try { cp.exec('start "" "' + url + '"', { windowsHide: true }); } catch (e) { logLine('开浏览器失败: ' + e.message); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- pid 文件（单实例 + 可关闭）
function readPid() {
  try { return JSON.parse(fs.readFileSync(PID_FILE, 'utf8')); } catch (e) { return null; }
}
function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function writePid() {
  if (!PID_FILE) return;
  try {
    fs.writeFileSync(PID_FILE, JSON.stringify({ pid: process.pid, port: PORT, at: new Date().toISOString() }));
  } catch (e) {}
}
function clearPid() {
  try {
    const rec = readPid();
    if (rec && rec.pid === process.pid && PID_FILE) fs.unlinkSync(PID_FILE);
  } catch (e) {}
}
function portOpen(port, timeoutMs) {
  return new Promise(function (resolve) {
    let done = false;
    const finish = function (v) { if (!done) { done = true; resolve(v); } };
    const sock = net.connect({ host: '127.0.0.1', port: port });
    sock.setTimeout(timeoutMs || 700);
    sock.once('connect', function () { sock.destroy(); finish(true); });
    sock.once('error', function () { finish(false); });
    sock.once('timeout', function () { sock.destroy(); finish(false); });
  });
}

// ---------------------------------------------------------------- 失败：弹窗 + 写日志 + 退出（不再留下看不见的进程）
function fatal(e) {
  const text = (e && e.stack) || String(e);
  logLine('FATAL ' + text);
  console.error('[bomb] 启动失败：\\n' + text);
  showBox(
    'BombGame 启动失败',
    text.slice(0, 600) +
      '\\n\\n日志：' + (LOG || '(无法写日志)') +
      '\\n\\n常见原因：端口被占用，可以用命令行换端口，例如 BombGame.exe 8080',
  );
  setTimeout(function () { process.exit(1); }, 300);
}
process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);
process.on('exit', clearPid);

// ---------------------------------------------------------------- 子命令
async function stopInstance() {
  const rec = readPid();
  if (!rec || !isAlive(rec.pid)) {
    clearPid();
    showBox('BombGame', '没有找到正在运行的游戏服务（可能已经关闭了）。');
    return;
  }
  logLine('stop: 结束进程 ' + rec.pid + '（端口 ' + rec.port + '）');
  try { process.kill(rec.pid); } catch (e) { logLine('stop 失败: ' + e.message); }
  for (let i = 0; i < 30 && isAlive(rec.pid); i++) await sleep(100);
  clearPid();
  const still = isAlive(rec.pid);
  showBox('BombGame', still ? '进程 ' + rec.pid + ' 没有退出，请用任务管理器结束它。' : '游戏服务已停止（进程 ' + rec.pid + '）。');
}

async function statusInstance() {
  const rec = readPid();
  const running = !!(rec && isAlive(rec.pid));
  const up = await portOpen(rec ? rec.port : PORT, 500);
  const lines = [];
  lines.push(running ? '状态：正在运行' : '状态：没有在运行');
  if (running) {
    lines.push('进程号：' + rec.pid + '（启动于 ' + rec.at + '）');
    lines.push('地址：http://localhost:' + rec.port + '/');
    lines.push('局域网：见大厅里的邀请二维码');
    lines.push('');
    lines.push('要停止：在命令行运行  BombGame.exe --stop');
  }
  if (!running) lines.push('要启动：直接双击 BombGame.exe');
  if (up) lines.push('（端口已可访问）');
  showBox('BombGame 状态', lines.join('\\n'));
}

// ---------------------------------------------------------------- 启动
async function startServer() {
  logLine('launch argv=' + JSON.stringify(process.argv) + ' stateDir=' + STATE_DIR);

  const rec = readPid();
  if (rec && isAlive(rec.pid) && (await portOpen(rec.port, 500))) {
    // 已经有一份在跑了：别再起第二个（否则双击几次就多出几个看不见的进程）
    logLine('already running: pid ' + rec.pid);
    openBrowser('http://localhost:' + rec.port + '/');
    toast('BombGame 已经在运行', '已在浏览器打开 http://localhost:' + rec.port + '／停止：BombGame.exe --stop');
    return;
  }
  if (await portOpen(PORT, 500)) {
    showBox(
      'BombGame 启动失败',
      '端口 ' + PORT + ' 已经被别的程序占用。\\n\\n可以用命令行换一个端口，例如：\\nBombGame.exe 8080',
    );
    process.exit(1);
    return;
  }

  writePid();
  require('../server/server.js');

  // 等服务真的可访问，再通知用户 + 开浏览器
  for (let i = 0; i < 60; i++) {
    if (await portOpen(PORT, 500)) {
      const url = 'http://localhost:' + PORT + '/';
      logLine('listening: ' + url);
      toast('BombGame 已启动', url + '\\n关闭游戏：BombGame.exe --stop');
      if (!process.env.BOMB_NO_OPEN) openBrowser(url);
      return;
    }
    await sleep(250);
  }
  logLine('警告：启动后 15 秒内端口仍不可访问');
}

if (ARG === '--stop' || ARG === '-stop') {
  stopInstance();
} else if (ARG === '--status' || ARG === '-status') {
  statusInstance();
} else {
  startServer();
}
`;
fs.writeFileSync(path.join(BUILD_DIR, 'sea-main.cjs'), mainSrc, 'utf8');

// ---------------------------------------------------------------- esbuild bundle
console.log('[build] esbuild 打包 server + lib ...');
const bundleOut = path.join(BUILD_DIR, 'bomb-bundle.cjs');
const bundle = spawnSync(
  ESBUILD,
  [
    path.join(BUILD_DIR, 'sea-main.cjs'),
    '--bundle',
    '--platform=node',
    '--format=cjs',
    '--target=node20',
    '--log-level=warning',
    '--outfile=' + bundleOut,
  ],
  { cwd: ROOT, stdio: 'inherit' },
);
if (bundle.status !== 0) {
  console.error('[build] esbuild 失败');
  process.exit(1);
}
console.log(`[build] bundle: ${(fs.statSync(bundleOut).size / 1024).toFixed(0)} KB`);

// ---------------------------------------------------------------- SEA blob
const configPath = path.join(BUILD_DIR, 'sea-config.json');
fs.writeFileSync(
  configPath,
  JSON.stringify(
    {
      main: bundleOut,
      output: path.join(BUILD_DIR, 'sea-prep.blob'),
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
    },
    null,
    2,
  ),
  'utf8',
);
const gen = spawnSync(process.execPath, ['--experimental-sea-config', configPath], { cwd: ROOT, stdio: 'inherit' });
if (gen.status !== 0) {
  console.error('[build] 生成 SEA blob 失败');
  process.exit(1);
}
const blob = path.join(BUILD_DIR, 'sea-prep.blob');
console.log(`[build] blob: ${(fs.statSync(blob).size / 1024).toFixed(0)} KB`);

// ---------------------------------------------------------------- 注入
fs.mkdirSync(DIST, { recursive: true });
fs.copyFileSync(process.execPath, EXE);
const inject = spawnSync(process.execPath, [POSTJECT, EXE, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', FUSE], {
  cwd: ROOT,
  stdio: 'inherit',
});
if (inject.status !== 0) {
  console.error('[build] postject 注入失败');
  process.exit(1);
}

// ---------------------------------------------------------------- 改成 GUI 子系统（隐藏控制台）
function setGuiSubsystem(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt16LE(0) !== 0x5a4d) throw new Error('不是 PE 文件');
  const peOff = buf.readUInt32LE(0x3c);
  if (buf.readUInt32LE(peOff) !== 0x00004550) throw new Error('PE 签名不对');
  const optOff = peOff + 4 + 20;
  const magic = buf.readUInt16LE(optOff);
  if (magic !== 0x10b && magic !== 0x20b) throw new Error('未知的 optional header magic: 0x' + magic.toString(16));
  const subOff = optOff + 0x44; // 两种 PE 格式里 Subsystem 都在可选头 +0x44
  const before = buf.readUInt16LE(subOff);
  buf.writeUInt16LE(2, subOff); // IMAGE_SUBSYSTEM_WINDOWS_GUI
  fs.writeFileSync(file, buf);
  return before;
}

const wasSubsystem = setGuiSubsystem(EXE);
const names = { 2: 'WINDOWS_GUI', 3: 'WINDOWS_CUI' };
console.log(`[build] 子系统: ${names[wasSubsystem] || wasSubsystem} -> WINDOWS_GUI（双击不再弹控制台）`);
console.log(`[build] exe: ${path.relative(ROOT, EXE)}  ${(fs.statSync(EXE).size / 1024 / 1024).toFixed(1)} MB`);

// ---------------------------------------------------------------- 单文件 zip
const zipBuf = zipEntries([{ name: 'BombGame.exe', data: fs.readFileSync(EXE) }]);
const singleZip = path.join(DIST, 'BombGame-win-x64-single.zip');
fs.writeFileSync(singleZip, zipBuf);
console.log(
  `[build] 单文件压缩包: ${path.relative(ROOT, singleZip)}  ${(zipBuf.length / 1024 / 1024).toFixed(1)} MB（里面只有 BombGame.exe）`,
);

console.log('[build] 完成。测试：dist/BombGame.exe <端口>');
