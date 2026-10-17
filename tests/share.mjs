// 分享隧道工具的纯逻辑测试（不会真的联网起隧道）。
//
//   node tests/share.mjs
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const { parsePublicUrl, TOOLS } = await import(pathToFileURL(path.join(ROOT, 'tools', 'share.mjs')).href);

let failures = 0;
const ok = (m) => console.log('  ✓ ' + m);
const fail = (m) => {
  failures++;
  console.log('  ✗ ' + m);
};

console.log('— 从隧道输出里认地址 —');
const cases = [
  [
    'cloudflared',
    '2026-01-01T00:00:00Z INF |  Your quick Tunnel has been created! Visit it at  |\n2026-01-01T00:00:00Z INF |  https://silly-cats-jump-here.trycloudflare.com  |',
    'https://silly-cats-jump-here.trycloudflare.com',
  ],
  ['ngrok', 't=2026-01-01 lvl=info msg="started tunnel" obj=tunnels name=command_line addr=http://localhost:3210 url=https://ab12-cd34.ngrok-free.app', 'https://ab12-cd34.ngrok-free.app'],
  ['localtunnel', 'your url is: https://quiet-panda-42.loca.lt', 'https://quiet-panda-42.loca.lt'],
  ['cpolar', 'Tunnel established at https://abc123.cpolar.cn', 'https://abc123.cpolar.cn'],
  ['不可识别', 'error: something went wrong\nlisten tcp 127.0.0.1:3210: bind: address already in use', null],
];

for (const [name, text, expect] of cases) {
  const got = parsePublicUrl(text);
  if (got === expect) ok(`${name} → ${got || '(没认出来，正确)'}`);
  else fail(`${name}: 期望 ${expect}，实际 ${got}`);
}

// 只认 https，避免把 http 的本地地址当公网地址
if (parsePublicUrl('http://127.0.0.1:3210') === null) ok('不会把 http 本地地址误认成公网地址');
else fail('把 http 本地地址误认成公网地址了');

console.log('\n— 工具定义 —');
for (const [name, tool] of Object.entries(TOOLS)) {
  const args = tool.args(3210);
  if (Array.isArray(args) && args.some((a) => String(a).includes('3210') || String(a).includes('localhost:3210'))) {
    ok(`${name}: ${tool.cmd} ${args.join(' ')}`);
  } else {
    fail(`${name}: 参数里没有端口：${JSON.stringify(args)}`);
  }
  if (tool.install && tool.why) ok(`${name}: 有安装说明与推荐理由`);
  else fail(`${name}: 缺少安装说明/理由`);
}

console.log(`\n失败 ${failures} 项`);
process.exitCode = failures ? 1 : 0;
