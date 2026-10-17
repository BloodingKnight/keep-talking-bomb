// 生成"纯静态"站点目录：可以扔到 EdgeOne Pages / GitHub Pages / 任意 CDN。
//
//   node tools/build-static-site.mjs
//   -> site/index.html        （游戏客户端）
//   -> site/static/*          （js / css / 图标 / manifest）
//   -> site/tutorial.html     （新手教程）
//
// 注意：静态站点里没有服务端，所以打开后要先填房主地址（?server=... 或页面上填），
// API 会直接跨域打到房主那台机器（服务端已开 CORS）。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLIENT = path.join(ROOT, 'client');
const OUT = path.join(ROOT, 'site');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'static'), { recursive: true });

const copy = (from, to) => {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
};

// 页面（放在根目录，因为 index.html 里引用的是 /static/...）
copy(path.join(CLIENT, 'index.html'), path.join(OUT, 'index.html'));
copy(path.join(CLIENT, 'tutorial.html'), path.join(OUT, 'tutorial.html'));

// 资源：全部进 static/
let n = 0;
let bytes = 0;
for (const ent of fs.readdirSync(CLIENT, { withFileTypes: true })) {
  if (ent.isDirectory()) continue;
  if (ent.name === 'index.html' || ent.name === 'tutorial.html') continue;
  if (ent.name === 'admin.html' || ent.name === 'admin.js') continue; // 管理端只在有服务端时可用
  const src = path.join(CLIENT, ent.name);
  copy(src, path.join(OUT, 'static', ent.name));
  n++;
  bytes += fs.statSync(src).size;
}

// 让静态托管也能处理 /tutorial（没有扩展名的路径）
fs.mkdirSync(path.join(OUT, 'tutorial'), { recursive: true });
copy(path.join(CLIENT, 'tutorial.html'), path.join(OUT, 'tutorial', 'index.html'));

// 一份给 EdgeOne / Pages 的说明
fs.writeFileSync(
  path.join(OUT, 'README.txt'),
  `这是纯静态站点目录（由 tools/build-static-site.mjs 生成）。

部署到 EdgeOne Pages / GitHub Pages 时：
  · 构建命令：node tools/build-static-site.mjs
  · 输出目录：site
  · 框架：静态 / 其他（不要选 Next.js 之类）

打开后如果显示"连接到房主的游戏"，把房主的地址填进去即可
（也可以用 ?server=https://xxx.trycloudflare.com 直接带上）。
`,
  'utf8',
);

console.log(`[site] ${path.relative(ROOT, OUT)}/index.html + ${n} 个静态资源, ${(bytes / 1024).toFixed(0)} KB`);
console.log('[site] 部署：输出目录填 site，构建命令填 node tools/build-static-site.mjs');
