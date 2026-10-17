// 准备 Tauri 打包需要的资源：内置 node.exe + 游戏本体。
//
//   node tools/prepare-tauri-assets.mjs
//
// 产物在 src-tauri/bundle-assets/（已在 .gitignore 里，因为带着 90MB 的 node.exe）。
// 玩家机器上不编译任何东西；CI 里也跑同一个脚本。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'src-tauri', 'bundle-assets');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// 1) node.exe：直接用当前运行的这一份（版本 = 打包机版本）
const nodeSrc = process.execPath;
fs.copyFileSync(nodeSrc, path.join(OUT, 'node.exe'));
console.log(`[tauri] node.exe: ${path.basename(nodeSrc)} ${(fs.statSync(nodeSrc).size / 1024 / 1024).toFixed(1)} MB`);

// 2) 游戏本体
for (const dir of ['server', 'lib', 'client']) {
  const copy = (src, rel) => {
    for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
      const r = path.join(rel, ent.name);
      if (ent.isDirectory()) copy(path.join(src, ent.name), r);
      else {
        fs.mkdirSync(path.dirname(path.join(OUT, r)), { recursive: true });
        fs.copyFileSync(path.join(src, ent.name), path.join(OUT, r));
      }
    }
  };
  copy(path.join(ROOT, dir), dir);
}
const count = (d) => fs.readdirSync(d, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? count(path.join(d, e.name)) : 1), 0);
console.log(`[tauri] 游戏文件: ${count(OUT)} 个`);

// 3) 自查：关键文件必须在
for (const need of ['node.exe', 'server/server.js', 'lib/vocab.js', 'client/index.html']) {
  const p = path.join(OUT, need);
  if (!fs.existsSync(p)) {
    console.error(`[tauri] 缺少 ${need}`);
    process.exit(1);
  }
}
console.log(`[tauri] 就绪: ${path.relative(ROOT, OUT)}`);
