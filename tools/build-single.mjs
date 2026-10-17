// 打一个"真·单文件" exe：Node SEA（Single Executable Application）。
//
//   node tools/build-single.mjs
//   -> dist/BombGame.exe                （约 91 MB，双击即玩，旁边不需要任何文件）
//   -> dist/BombGame-win-x64-single.zip （只含那一个 exe）
//
// 原理：把 client/ lib/ server/ 作为 SEA 资源嵌进 node.exe，exe 启动时先把这些文件
// 释放到 %LOCALAPPDATA%\BombGame\<构建号>\（第一次之后直接复用），再以真实 ESM 模块
// 启动 server.js —— 所以运行时行为和仓库里完全一致，没有改写过的打包版本。
//
// 依赖（只在"打包机"上需要，玩家不需要）：
//   cd .build && npm install --ignore-scripts postject
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { zipEntries } from './lib-zip.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const BUILD_DIR = path.join(ROOT, '.build');
const DIST = path.join(ROOT, 'dist');
const EXE = path.join(DIST, 'BombGame.exe');
const POSTJECT = path.join(BUILD_DIR, 'node_modules', 'postject', 'dist', 'cli.js');
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

if (!fs.existsSync(POSTJECT)) {
  console.error('[build] 缺少 postject，请先执行:');
  console.error('        cd .build && npm install --ignore-scripts postject');
  process.exit(1);
}

// ---------------------------------------------------------------- 收集要嵌入的文件
const SRC_DIRS = ['client', 'lib', 'server'];
const files = [];
for (const dir of SRC_DIRS) {
  const walk = (abs, rel) => {
    for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? rel + '/' + ent.name : ent.name;
      if (ent.isDirectory()) walk(path.join(abs, ent.name), r);
      else files.push({ key: dir + '/' + r, abs: path.join(abs, ent.name) });
    }
  };
  walk(path.join(ROOT, dir), '');
}
const totalBytes = files.reduce((n, f) => n + fs.statSync(f.abs).size, 0);
console.log(`[build] 要嵌入的文件: ${files.length} 个, ${(totalBytes / 1024).toFixed(0)} KB`);

// 构建号 = 内容指纹，改了代码就会释放到新目录，不会用到旧的残留
const crypto = await import('node:crypto');
const hash = crypto.createHash('sha256');
for (const f of files) hash.update(f.key).update(fs.readFileSync(f.abs));
const BUILD_ID = hash.digest('hex').slice(0, 12);
console.log('[build] 构建号:', BUILD_ID);

// ---------------------------------------------------------------- 生成入口脚本
const entry = `'use strict';
// 由 tools/build-single.mjs 生成：单文件入口，先解包再启动真正的 server.js
const sea = require('node:sea');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const { pathToFileURL } = require('node:url');

const BUILD_ID = ${JSON.stringify(BUILD_ID)};
const FILES = ${JSON.stringify(files.map((f) => f.key))};

function dataDirs() {
  const list = [];
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  list.push(path.join(local, 'BombGame', BUILD_ID));
  try { list.push(path.join(os.tmpdir(), 'BombGame', BUILD_ID)); } catch (e) {}
  list.push(path.join(path.dirname(process.execPath), '.bomb-data', BUILD_ID));
  return list;
}

function ensureFiles() {
  let lastErr;
  for (const dir of dataDirs()) {
    try {
      const stamp = path.join(dir, '.complete');
      if (fs.existsSync(stamp)) return dir;
      for (const rel of FILES) {
        const dest = path.join(dir, rel.split('/').join(path.sep));
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, Buffer.from(sea.getRawAsset(rel)));
      }
      fs.writeFileSync(stamp, 'ok');
      return dir;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

// 双击启动时（没有参数、有控制台）顺手把浏览器打开，并把控制台切到 UTF-8 好显示中文
const doubleClicked = !process.argv[2] && process.stdout.isTTY;
if (doubleClicked) {
  try { cp.execSync('cmd /c chcp 65001', { stdio: 'ignore' }); } catch (e) {}
  setTimeout(function () {
    try { cp.exec('start "" "http://localhost:' + (process.env.PORT || 3210) + '/"'); } catch (e) {}
  }, 700);
}

const dir = ensureFiles();
const serverPath = path.join(dir, 'server', 'server.js');
process.argv[1] = serverPath;

(async function () {
  try {
    await import(pathToFileURL(serverPath).href);
  } catch (e) {
    if (e && (e.code === 'ERR_REQUIRE_ESM' || e.code === 'ERR_UNSUPPORTED_ESM_URL_SCHEME')) {
      require(serverPath);
      return;
    }
    throw e;
  }
})().catch(function (e) {
  console.error('[bomb] 启动失败:', (e && e.stack) || e);
  try { if (doubleClicked) process.stdin.resume(); } catch (x) {}
});
`;

const entryPath = path.join(BUILD_DIR, 'sea-entry.cjs');
fs.writeFileSync(entryPath, entry, 'utf8');

// ---------------------------------------------------------------- SEA 配置
const config = {
  main: entryPath,
  output: path.join(BUILD_DIR, 'sea-prep.blob'),
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  assets: Object.fromEntries(files.map((f) => [f.key, f.abs])),
};
const configPath = path.join(BUILD_DIR, 'sea-config.json');
fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

// ---------------------------------------------------------------- 生成 blob
const gen = spawnSync(process.execPath, ['--experimental-sea-config', configPath], {
  cwd: ROOT,
  stdio: 'inherit',
});
if (gen.status !== 0) {
  console.error('[build] 生成 SEA blob 失败');
  process.exit(1);
}
const blob = path.join(BUILD_DIR, 'sea-prep.blob');
console.log(`[build] blob: ${(fs.statSync(blob).size / 1024).toFixed(0)} KB`);

// ---------------------------------------------------------------- 复制 node.exe 并注入
fs.mkdirSync(DIST, { recursive: true });
fs.copyFileSync(process.execPath, EXE);
console.log(`[build] 已复制 node.exe (${(fs.statSync(EXE).size / 1024 / 1024).toFixed(1)} MB)`);

const inject = spawnSync(
  process.execPath,
  [POSTJECT, EXE, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', FUSE],
  { cwd: ROOT, stdio: 'inherit' },
);
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
