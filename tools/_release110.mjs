// 一次性：创建 v1.1.0 release 并上传 Node 版产物（Tauri 产物由 CI 追加）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const TOKEN = process.env.BOMB_GH_TOKEN;
const OWNER = 'BloodingKnight';
const REPO = 'keep-talking-bomb';
const API = `https://api.github.com/repos/${OWNER}/${REPO}`;
const H = {
  authorization: `Bearer ${TOKEN}`,
  'user-agent': 'bomb-release',
  accept: 'application/vnd.github+json',
  'content-type': 'application/json',
  'x-github-api-version': '2022-11-28',
};

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const mb = (f) => (fs.statSync(f).size / 1024 / 1024).toFixed(1);
const EXE = 'dist/BombGame.exe';
const SINGLE = 'dist/BombGame-win-x64-single.zip';
const PORTABLE = 'dist/BombGame-win-x64.zip';

const body = `## v1.1.0 — 扫码加入 + 无窗口 exe + Tauri 桌面版

### 这一版新增

- **大厅邀请二维码**：房主一开局就能看到「扫一扫加入」的二维码和局域网地址，朋友扫码直接进房间，
  不用再手打 IP + 4 位房间号。二维码是仓库里自己实现的编码器（零依赖、离线可用）。
- **单文件 exe 变成"无窗口"**：双击不再弹黑色控制台，直接开浏览器；同时补上了
  - 启动成功弹**托盘气泡**（能看到地址，知道成功没）
  - \`BombGame.exe --status\` 看状态（是否在跑 / 进程号 / 地址）
  - \`BombGame.exe --stop\` 关掉它
  - **单实例保护**：已在跑时再双击只开浏览器，不会多出看不见的进程
  - 启动失败：弹消息框 + 写 \`%LOCALAPPDATA%\\BombGame\\BombGame.log\`，然后退出（不再留孤儿进程）
- **Tauri 桌面版**（有窗口、能关、带安装包）：源码在 \`src-tauri/\`，由 GitHub Actions 编译，
  **本机不需要装 Rust**。产物会追加到这个 Release。

### 下载哪个？

| 文件 | 大小 | 说明 |
|---|---|---|
| \`BombGame.exe\` | ${mb(EXE)} MB | **无窗口**单文件，双击即玩；用 \`--status\` / \`--stop\` 管理 |
| \`BombGame-win-x64-single.zip\` | ${mb(SINGLE)} MB | 上面那个 exe 打了个 zip |
| \`BombGame-win-x64.zip\` | ${mb(PORTABLE)} MB | 绿色版：**官方原版 node.exe**（签名完好）+ \`play.cmd\`，最不容易被杀软拦 |
| \`BombGame_1.0.0_x64-setup.exe\` | 22.5 MB | **Tauri 桌面版安装包**（CI 编出来的）：有窗口、点关闭就退出 |
| \`BombGame_1.0.0_x64_en-US.msi\` | 33.1 MB | 同上，MSI 版（企业部署用） |

> 杀软提示：\`BombGame.exe\` 是"官方 node.exe + 注入启动代码"，注入会破坏它的数字签名，
> 所以可能被当成未知发布者。要给别人就优先发**绿色版**或 **Tauri 安装包**。

### 怎么开始

1. 双击 exe / 安装后打开 BombGame
2. 浏览器（或应用窗口）里会自动打开游戏首页
3. 在大厅把二维码给朋友扫，或者复制邀请链接发过去

### 校验（SHA-256，Node 版）

\`\`\`
BombGame.exe                ${sha(EXE)}
BombGame-win-x64-single.zip ${sha(SINGLE)}
BombGame-win-x64.zip        ${sha(PORTABLE)}
\`\`\`

### 测试

13 个测试套件全绿（生成可解性 / 盲视野不泄漏 / 三人经典 / 端到端拆完整颗炸弹 / 二维码可解码…），
其中二维码编码器用 jsqr 真解码验证过 11 组样本。
`;

let rel = await (await fetch(`${API}/releases/tags/v1.1.0`, { headers: H })).json();
if (!rel.id) {
  const res = await fetch(`${API}/releases`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      tag_name: 'v1.1.0',
      target_commitish: 'main',
      name: 'v1.1.0 — 扫码加入 + 无窗口 exe + Tauri 桌面版',
      body,
      draft: false,
      prerelease: false,
    }),
  });
  rel = await res.json();
  console.log('create release:', res.status, rel.tag_name);
} else {
  await fetch(`${API}/releases/${rel.id}`, { method: 'PATCH', headers: H, body: JSON.stringify({ body }) });
  console.log('update existing release:', rel.tag_name);
}

const existing = await (await fetch(`${API}/releases/${rel.id}/assets`, { headers: H })).json();
const have = new Set(existing.map((a) => a.name));
for (const file of [EXE, SINGLE, PORTABLE]) {
  const name = path.basename(file);
  if (have.has(name)) {
    console.log('skip:', name);
    continue;
  }
  const buf = fs.readFileSync(file);
  const res = await fetch(
    `https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${rel.id}/assets?name=${encodeURIComponent(name)}`,
    {
      method: 'POST',
      headers: { ...H, 'content-type': file.endsWith('.zip') ? 'application/zip' : 'application/octet-stream' },
      body: buf,
    },
  );
  const out = await res.json();
  console.log('upload', name, res.status, (out.size / 1024 / 1024).toFixed(1), 'MB');
}

const final = await (await fetch(`${API}/releases/${rel.id}/assets`, { headers: H })).json();
console.log('\nv1.1.0 assets:');
for (const a of final) console.log(' -', a.name, (a.size / 1048576).toFixed(1), 'MB');
