// 一次性工具：创建 GitHub Release 并把绿色版 zip 作为附件上传。
// （沙箱里 github.com:443 不通，但 api.github.com / uploads.github.com 可以）
import fs from 'node:fs';
import crypto from 'node:crypto';

const TOKEN = process.env.BOMB_GH_TOKEN;
const OWNER = 'BloodingKnight';
const REPO = 'keep-talking-bomb';
const API = `https://api.github.com/repos/${OWNER}/${REPO}`;
const TAG = 'v1.0.0';
const FILE = 'dist/BombGame-win-x64.zip';

const H = {
  authorization: `Bearer ${TOKEN}`,
  'user-agent': 'bomb-release',
  accept: 'application/vnd.github+json',
};

const zip = fs.readFileSync(FILE);
const sha256 = crypto.createHash('sha256').update(zip).digest('hex');
const mb = (zip.length / 1024 / 1024).toFixed(1);
console.log(`zip: ${mb} MB | sha256: ${sha256}`);

const body = `## 保持沟通就没人爆炸 v1.0.0

本地多人合作拆弹游戏：**一个人看炸弹，其他人查手册**，全程靠你们自己沟通 —— 不提供语音/视频，说话是你们自己的事。

![角色](https://img.shields.io/badge/角色-9_个座位-blue) ![模块](https://img.shields.io/badge/模块-18_个-green) ![依赖](https://img.shields.io/badge/第三方依赖-0-orange)

## 下载即玩（Windows，不用装 Node）

**\`BombGame-win-x64.zip\`** — ${mb} MB，包里自带 Node 运行时。

1. 解压到一个文件夹（**不要**在压缩包里直接双击）
2. 双击 **\`play.cmd\`**
3. 浏览器自动打开 → 把窗口里打印的「同一局域网」地址 + 房间号发给朋友
4. 朋友用手机/电脑浏览器打开就能加入

> - 第一次可能弹 SmartScreen：「更多信息」→「仍要运行」
> - 防火墙弹窗要允许**专用网络**，否则同一个 Wi-Fi 的设备连不上
> - 端口被占用就用 \`play.cmd 8080\`

## 这个版本包含

- **18 个模块 × 5 档难度**，按难度权重自动出题；同一模块每次的表都不一样，背不了表
- **服务端权威 + 按角色隔离视图**：拆弹者的视图里没有答案，专家的视图里没有题面
- **三种感官各缺一个的「三人经典」**
  - 🙈 盲操猴：只有白色轮廓，看不见颜色/数字/文字，连倒计时都要别人报
  - 🙉 聋桥猴：看得见**整颗炸弹** + 队友的**幽灵光标**（盲操猴点到哪他都看得到）
  - 🙊 哑手册猴：有完整手册，只能说信号/打字
- **\`/admin\`**：出题与视角验题页（18 模块 × 5 等级一键全量自检）、房间监控、服务器状态
- **\`/tutorial\`**：新手指南（9 个角色、18 个模块速查、沟通链路示例对白）
- **零第三方依赖**：只用 Node 内置 HTTP + SSE，没有 \`npm install\`
- **12 个测试套件全绿**（生成可解性、盲视野不泄漏、三人经典、端到端拆完整颗炸弹…）

## 其他玩法

- **macOS / Linux**：\`./start.sh\`（需要 Node 18+）
- **异地一起玩**：仓库里有 \`Dockerfile\`，部署到任意容器平台后发链接即可（房间状态在内存里，只能单实例）

## 校验

- 文件大小：${zip.length} 字节（${mb} MB）
- SHA-256：\`${sha256}\`

## 说明

所有规则表、模块设计与文案均为本项目原创；附件里的《Keep Talking and Nobody Explodes》手册
只用于理解这类玩法的结构，正文没有被复制进仓库（抽取文本已在 \`.gitignore\` 中排除）。
`;

const rel = await fetch(`${API}/releases`, {
  method: 'POST',
  headers: { ...H, 'content-type': 'application/json' },
  body: JSON.stringify({
    tag_name: TAG,
    target_commitish: 'main',
    name: 'v1.0.0 — 第一个可玩版本',
    body,
    draft: false,
    prerelease: false,
  }),
});
const release = await rel.json();
if (!rel.ok) {
  console.error('create release failed:', rel.status, JSON.stringify(release).slice(0, 400));
  process.exit(1);
}
console.log('release:', release.id, '|', release.tag_name, '|', release.html_url);

const up = await fetch(
  `https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${release.id}/assets?name=BombGame-win-x64.zip`,
  {
    method: 'POST',
    headers: { ...H, 'content-type': 'application/zip', 'content-length': String(zip.length) },
    body: zip,
  },
);
const asset = await up.json();
if (!up.ok) {
  console.error('upload failed:', up.status, JSON.stringify(asset).slice(0, 400));
  process.exit(1);
}
console.log('asset:', asset.name, '|', asset.size, 'bytes | state:', asset.state);
console.log('download:', asset.browser_download_url);
if (asset.digest) console.log('digest:', asset.digest, asset.digest === 'sha256:' + sha256 ? '(matches local)' : '(MISMATCH!)');
