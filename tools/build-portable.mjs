// 打包 Windows 绿色版：把 node.exe 一起塞进去，解压双击就能玩，对方不用装 Node。
//
//   node tools/build-portable.mjs            # 生成 dist/BombGame-win-x64/ 和 .zip
//   node tools/build-portable.mjs --no-zip   # 只要文件夹
//
// 说明：
//  - node.exe 直接取当前运行的这个（process.execPath），所以打包机的 Node 版本 = 玩家用的版本；
//  - 只复制仓库里"会发布"的文件（跳过 .git / dist / 日志 / 手册抽取文本等）；
//  - zip 用 Node 自带的 zlib 手写（不依赖任何第三方库，也不需要 PowerShell 的 Compress-Archive）。
import fs from 'node:fs';
import path from 'node:path';
import { zipEntries } from './lib-zip.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const NAME = 'BombGame-win-x64';
const OUT = path.join(DIST, NAME);
const ZIP = path.join(DIST, NAME + '.zip');

const SKIP_DIRS = new Set([
  '.git',
  'dist',
  'node_modules',
  '.vscode',
  '.idea',
  '.build',
  '.npmcache',
  // Tauri 相关：bundle-assets 里也有一个 90MB 的 node.exe，别再打一份进来
  'src-tauri',
  'keep-talking-bomb',
  '.github',
]);
const SKIP_FILE = /^(manual-text.*\.txt|.*\.log|.*\.pdf|.*\.zip|\.DS_Store|Thumbs\.db|desktop\.ini)$/i;

// ---------------------------------------------------------------- 文件收集
function walk(dir, rel = '') {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? rel + '/' + ent.name : ent.name;
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      out.push(...walk(path.join(dir, ent.name), r));
    } else if (!SKIP_FILE.test(ent.name)) {
      out.push(r);
    }
  }
  return out;
}

if (!fs.existsSync(path.join(ROOT, 'server', 'server.js'))) {
  console.error('[build] 找不到 server/server.js，请在项目根目录下运行');
  process.exit(1);
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const files = walk(ROOT).filter((f) => !f.startsWith('tools/build-portable'));
let bytes = 0;
for (const rel of files) {
  const dest = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const data = fs.readFileSync(path.join(ROOT, rel));
  fs.writeFileSync(dest, data);
  bytes += data.length;
}
console.log(`[build] 项目文件: ${files.length} 个, ${(bytes / 1024).toFixed(0)} KB`);

// ---------------------------------------------------------------- 内置 node
const nodeSrc = process.execPath;
const nodeDir = path.join(OUT, 'node');
fs.mkdirSync(nodeDir, { recursive: true });
fs.copyFileSync(nodeSrc, path.join(nodeDir, 'node.exe'));
console.log(`[build] 内置 node: ${path.basename(nodeSrc)} ${(fs.statSync(nodeSrc).size / 1024 / 1024).toFixed(1)} MB`);

// ---------------------------------------------------------------- 启动器
// 注意：.cmd 必须 CRLF，否则 cmd.exe 解析会崩。
const launcher = [
  '@echo off',
  'rem ============================================================',
  'rem  BombGame - 双击这个文件就能玩（自带 Node，无需安装）',
  'rem',
  'rem    play.cmd          启动并自动打开浏览器（默认端口 3210）',
  'rem    play.cmd 8080     换端口',
  'rem    play.cmd -Detached  后台运行（日志在 server.log）',
  'rem',
  'rem  关闭窗口 = 停止游戏。',
  'rem ============================================================',
  'setlocal',
  'rem 把自带的 node 放到 PATH 最前面，后面的脚本就能直接用 node',
  'set "PATH=%~dp0node;%PATH%"',
  '',
  'if not exist "%~dp0node\\node.exe" (',
  '  echo [bomb] 缺少 node\\node.exe，压缩包可能解压不完整，请重新解压。',
  '  pause',
  '  exit /b 1',
  ')',
  '',
  'set "PS=%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"',
  'if not exist "%PS%" set "PS=powershell.exe"',
  '',
  '"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*',
  'echo.',
  'pause',
  '',
].join('\r\n');
fs.writeFileSync(path.join(OUT, 'play.cmd'), launcher, 'utf8');

// ---------------------------------------------------------------- 使用说明
const readme = `\uFEFF保持沟通就没人爆炸 - Windows 绿色版使用说明
=================================================

【怎么开始】
  1. 把压缩包解压到一个文件夹（不要在压缩包里直接双击）。
  2. 双击 play.cmd。
  3. 会自动打开浏览器，看到游戏首页就说明服务起好了。
     那一刻窗口里会打印两行地址：
        本机打开:     http://localhost:3210
        同一局域网:   http://192.168.x.x:3210
     把"同一局域网"那一行+房间号发给你朋友，他们用手机/电脑浏览器打开就能加入。

【不用装 Node】
  这个包里已经带了 node\\node.exe（Node ${process.version}），
  所以不需要你另外安装任何东西，也不用联网下载依赖（本项目零依赖）。

【第一次运行可能会被拦】
  - Windows SmartScreen："已保护你的电脑" -> 点"更多信息" -> "仍要运行"。
  - 防火墙弹窗："允许访问"要勾上"专用网络"，否则同一局域网的设备连不上。
  - 如果朋友连不上：确认大家连的是同一个 Wi-Fi，并且这台电脑的防火墙放行了 Node。

【端口被占用怎么办】
  默认端口 3210。如果提示端口被占用，可以在命令行里换个端口：
      play.cmd 8080

【停止】
  直接关掉那个黑色窗口，或者按 Ctrl+C。

【朋友不在同一个 Wi-Fi（异地）怎么办】
  这个绿色版是把服务跑在你这台电脑上，只能用局域网地址访问。
  想异地一起玩，需要把服务放到有公网地址的机器上（见项目 README 的"分发与部署"）。

【文件说明】
  play.cmd        启动器（用自带的 node 跑 start.ps1）
  start.ps1       启动脚本：端口、令牌、测试模式、后台模式、自动开浏览器
  stop.ps1        停掉后台模式（play.cmd -Detached）起的服务
  node\\node.exe   内置的 Node 运行时
  server\\ lib\\    服务端与游戏逻辑
  client\\          浏览器端页面（游戏界面、手册、管理入口、教程）
  README.md        完整说明（玩法、角色、模块、测试、部署）
  tutorial.html    新手指南，也可以用浏览器打开
`;
fs.writeFileSync(path.join(OUT, '使用说明.txt'), readme, 'utf8');

// ---------------------------------------------------------------- ZIP
// zip 写入实现在 tools/lib-zip.mjs（单文件 exe 的打包脚本也用它）

if (!process.argv.includes('--no-zip')) {
  const entries = [];
  const collect = (dir, rel = '') => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? rel + '/' + ent.name : ent.name;
      if (ent.isDirectory()) collect(path.join(dir, ent.name), r);
      else entries.push({ name: NAME + '/' + r, data: fs.readFileSync(path.join(dir, ent.name)) });
    }
  };
  collect(OUT);
  console.log('[build] 正在压缩…');
  const zip = zipEntries(entries);
  fs.mkdirSync(DIST, { recursive: true });
  fs.writeFileSync(ZIP, zip);
  console.log(`[build] 压缩包: ${path.relative(ROOT, ZIP)}  ${(zip.length / 1024 / 1024).toFixed(1)} MB (${entries.length} 个文件)`);
}

console.log(`[build] 绿色版目录: ${path.relative(ROOT, OUT)}`);
console.log('[build] 玩家操作: 解压 -> 双击 play.cmd');
