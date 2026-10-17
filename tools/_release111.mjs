// 一次性：创建 v1.1.1 release 并上传 Node 版产物（Tauri 产物由 CI 追加）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const TOKEN = process.env.BOMB_GH_TOKEN;
const OWNER = 'BloodingKnight';
const REPO = 'keep-talking-bomb';
const TAG = 'v1.1.1';
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

const body = `## v1.1.1 — 修好 Tauri 桌面版 + 没有公网 IP 也能分享

### 关键修复：Tauri 版之前启动失败（"node 被拦截 / 3210 被占用"）

真正的错因不是杀软也不是端口，而是**资源目录找错了**：NSIS 装完之后资源在
\`resources/\` 下，而代码只认 \`resource_dir()/\` 和 \`bundle-assets/\`，于是找不到内置的
\`node.exe\`，等 25 秒后报了个"可能被杀软拦截或端口占用"的笼统错误。

这一版：

- 资源目录改成**逐个候选查找**（\`资源根/resources/\`、\`资源根/\`、\`exe 同级/\`、开发模式的 cwd…）
- **端口自动顺延**：3210 被占就试 3211…3240，不再让你改命令行；已有实例直接复用
- 失败时错误窗口**直接列出找过的目录内容 + node 日志最后 25 行**，一眼就能定位

### 新增：没有公网 IP 也能立刻分享

\`\`\`bash
node tools/share.mjs          # 自动挑工具（cloudflared / ngrok / localtunnel）
\`\`\`

打印一个 \`https://xxxx.trycloudflare.com\` 的公网地址，发给朋友就能玩。
用这个地址打开游戏后，**大厅二维码会自动变成公网地址**，朋友扫码直接进。

### 其他

- 绿色版打包不再把 \`src-tauri/\` 里的另一个 90MB node.exe 打进去（之前会莫名涨到 73MB）

### 下载哪个？

| 文件 | 大小 | 说明 |
|---|---|---|
| \`BombGame_1.1.1_x64-setup.exe\` | CI 产出 | **Tauri 桌面版安装包**（有窗口、关窗即退出）← 推荐 |
| \`BombGame.exe\` | ${mb(EXE)} MB | 无窗口单文件（\`--status\` / \`--stop\` 管理） |
| \`BombGame-win-x64.zip\` | ${mb(PORTABLE)} MB | 绿色版：官方原版 node.exe + \`play.cmd\`（含 \`tools/share.mjs\`） |
| \`BombGame-win-x64-single.zip\` | ${mb(SINGLE)} MB | 单文件 exe 的 zip |

### 校验（SHA-256，Node 版）

\`\`\`
BombGame.exe                ${sha(EXE)}
BombGame-win-x64-single.zip ${sha(SINGLE)}
BombGame-win-x64.zip        ${sha(PORTABLE)}
\`\`\`

14 个测试套件全绿（含二维码可解码验证、邀请地址在公网/局域网两种场景下都正确）。
`;

let rel = await (await fetch(`${API}/releases/tags/${TAG}`, { headers: H })).json();
if (!rel.id) {
  const res = await fetch(`${API}/releases`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      tag_name: TAG,
      target_commitish: 'main',
      name: 'v1.1.1 — 修好 Tauri 桌面版 + 无公网 IP 分享',
      body,
      draft: false,
      prerelease: false,
    }),
  });
  rel = await res.json();
  console.log('create release:', res.status, rel.tag_name || JSON.stringify(rel).slice(0, 200));
} else {
  await fetch(`${API}/releases/${rel.id}`, { method: 'PATCH', headers: H, body: JSON.stringify({ body }) });
  console.log('update release:', rel.tag_name);
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
console.log(`\n${TAG} assets:`);
for (const a of final) console.log(' -', a.name, (a.size / 1048576).toFixed(1), 'MB');
