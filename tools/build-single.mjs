// 打一个"真·单文件" exe：Node SEA（Single Executable Application）。
//
//   node tools/build-single.mjs
//   -> dist/BombGame.exe                （约 91 MB，双击即玩，旁边不需要任何文件）
//   -> dist/BombGame-win-x64-single.zip （只含那一个 exe）
//
// 设计要点（都是为了不被杀软当成"释放器"）：
//   1. client/ 的静态文件直接内联进 JS（globalThis.__BOMB_EMBEDDED_CLIENT__），
//      运行时不往磁盘写任何东西；
//   2. server/ 与 lib/ 用 esbuild 打成一个 CJS bundle，再作为 SEA 的 main；
//   3. 出错时不再"闪一下就消失"：打印堆栈、写 %LOCALAPPDATA%\BombGame\launch.log、
//      并且是双击启动的话等按键再退出。
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
const clientDir = path.join(ROOT, 'client');
const assets = {};
let assetBytes = 0;
const walk = (abs, rel) => {
  for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
    const r = rel ? rel + '/' + ent.name : ent.name;
    if (ent.isDirectory()) {
      walk(path.join(abs, ent.name), r);
    } else {
      const text = fs.readFileSync(path.join(abs, ent.name), 'utf8');
      assets[r] = text;
      assetBytes += Buffer.byteLength(text);
    }
  }
};
walk(clientDir, '');
console.log(`[build] 内联 client/: ${Object.keys(assets).length} 个文件, ${(assetBytes / 1024).toFixed(0)} KB`);

fs.writeFileSync(
  path.join(BUILD_DIR, 'client-assets.cjs'),
  '// 由 tools/build-single.mjs 生成：内联的 client/ 静态文件\nmodule.exports = ' +
    JSON.stringify(assets) +
    ';\n',
  'utf8',
);

// ---------------------------------------------------------------- 入口（SEA main 的源）
const mainSrc = `'use strict';
// 由 tools/build-single.mjs 生成
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

globalThis.__BOMB_EMBEDDED_CLIENT__ = require('./client-assets.cjs');

function logPath() {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'BombGame', 'launch.log');
}

function writeLog(text) {
  try {
    const f = logPath();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, '[' + new Date().toISOString() + '] ' + text + '\\n');
  } catch (e) {}
}

function fatal(e) {
  const text = (e && e.stack) || String(e);
  console.error('');
  console.error('[bomb] 启动失败，原因如下：');
  console.error(text);
  console.error('');
  writeLog('FATAL ' + text);
  console.error('这段信息也写到了: ' + logPath());
  if (process.stdin.isTTY) {
    console.error('按任意键退出…');
    try {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.once('data', function () { process.exit(1); });
      return;
    } catch (x) {}
  }
  process.exit(1);
}

process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);

// 双击启动（没有参数 + 有控制台）：切 UTF-8、顺手开浏览器
// BOMB_FORCE_DOUBLE=1 强制走这条分支，便于自动化验证
const doubleClicked = process.env.BOMB_FORCE_DOUBLE === '1' || (!process.argv[2] && process.stdout.isTTY);
writeLog('launch argv=' + JSON.stringify(process.argv) + ' tty=' + !!process.stdout.isTTY);
if (doubleClicked) {
  try { cp.execSync('cmd /c chcp 65001', { stdio: 'ignore' }); } catch (e) {}
  setTimeout(function () {
    try { cp.exec('start "" "http://localhost:' + (process.env.PORT || 3210) + '/"'); } catch (e) {}
  }, 900);
}

try {
  require('../server/server.js');
} catch (e) {
  fatal(e);
}
`;
fs.writeFileSync(path.join(BUILD_DIR, 'sea-main.cjs'), mainSrc, 'utf8');

// ---------------------------------------------------------------- esbuild 打成一个 bundle
// 注意：bundle 本身就是 SEA 的 main（里面不能再 require 自己，否则 SEA 里会找不到模块）
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
const config = {
  main: bundleOut,
  output: path.join(BUILD_DIR, 'sea-prep.blob'),
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
};
const configPath = path.join(BUILD_DIR, 'sea-config.json');
fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

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
console.log(`[build] exe: ${path.relative(ROOT, EXE)}  ${(fs.statSync(EXE).size / 1024 / 1024).toFixed(1)} MB`);

// ---------------------------------------------------------------- 只装一个 exe 的 zip
const zipBuf = zipEntries([{ name: 'BombGame.exe', data: fs.readFileSync(EXE) }]);
const singleZip = path.join(DIST, 'BombGame-win-x64-single.zip');
fs.writeFileSync(singleZip, zipBuf);
console.log(
  `[build] 单文件压缩包: ${path.relative(ROOT, singleZip)}  ${(zipBuf.length / 1024 / 1024).toFixed(1)} MB（里面只有 BombGame.exe）`,
);

console.log('[build] 完成。测试：dist/BombGame.exe <端口>');
