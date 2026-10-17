// 没有公网 IP 也能把游戏分享给外面的朋友：起一条隧道，拿到一个公网 https 地址。
//
//   node tools/share.mjs                 自动挑一个可用工具
//   node tools/share.mjs 3210            指定端口
//   node tools/share.mjs --tool cloudflared
//
// 支持的隧道（按优先级）：
//   1. cloudflared —— 不需要注册，一条命令就有 https://xxx.trycloudflare.com（推荐）
//   2. ngrok       —— 需要你自己的 authtoken（ngrok config add-authtoken ...）
//   3. localtunnel —— 纯 npx，不用装东西；首次访问可能要填一个密码（就是你自己的公网 IP）
//
// 提示：隧道地址每次启动都会变。用这个地址打开游戏后，大厅里的二维码会自动变成公网地址，
//       朋友扫码/点链接就能进来（不用同一个 Wi-Fi）。
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');

/** 从隧道程序的输出里认出公网地址（纯函数，方便单测） */
export function parsePublicUrl(text) {
  const patterns = [
    /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i,
    /https:\/\/[a-z0-9][a-z0-9-]*\.ngrok(?:-free)?\.(?:app|io|dev)/i,
    /https:\/\/[a-z0-9][a-z0-9-]*\.loca\.lt/i,
    /https:\/\/[a-z0-9][a-z0-9-]*\.(?:cpolar|natapp|natappfree|ngrok)\.(?:cn|cc|top|io|vip)/i,
    /https:\/\/[a-z0-9][a-z0-9-]*\.(?:serveo\.net|localhost\.run|pinggy\.link)/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[0];
  }
  return null;
}

export const TOOLS = {
  cloudflared: {
    cmd: 'cloudflared',
    args: (port) => ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'],
    install: 'https://github.com/cloudflare/cloudflared/releases（下载 cloudflared-windows-amd64.exe，改名 cloudflared.exe 放进 PATH）',
    why: '不用注册、地址最稳、最省事',
  },
  ngrok: {
    cmd: 'ngrok',
    args: (port) => ['http', String(port), '--log=stdout', '--log-format=logfmt'],
    install: 'https://ngrok.com/download，然后 ngrok config add-authtoken <你的token>',
    why: '需要免费注册一个账号',
  },
  lt: {
    cmd: process.platform === 'win32' ? 'npx.cmd' : 'npx',
    args: (port) => ['--yes', 'localtunnel', '--port', String(port)],
    install: '不用装（走 npx，需要 Node）',
    why: '不用装任何东西；首次访问要填一次密码（就是你自己的公网 IP）',
  },
};

async function serverUp(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/rooms`);
    return res.ok;
  } catch {
    return false;
  }
}

function printBanner(url, tool, port) {
  const line = '─'.repeat(Math.min(64, url.length + 6));
  console.log('');
  console.log(line);
  console.log('  公网地址（发给朋友就能玩，不需要同一个 Wi-Fi）：');
  console.log('');
  console.log(`      ${url}`);
  console.log('');
  console.log(line);
  console.log(`  隧道工具：${tool}（本地服务 http://127.0.0.1:${port}）`);
  console.log('  · 先自己用这个地址打开一次 → 大厅里的二维码会自动变成公网地址，朋友扫码即可');
  console.log('  · 这个地址每次重启都会变；想让地址固定就部署到云主机（见 README「公网在线版」）');
  console.log('  · 按 Ctrl+C 结束隧道（游戏服务本身还在跑）');
  console.log('');
}

function main() {
  const argv = process.argv.slice(2);
  const toolIdx = argv.indexOf('--tool');
  const wantTool = toolIdx >= 0 ? argv[toolIdx + 1] : null;
  const portArg = argv.find((a) => /^\d+$/.test(a));
  const port = Number(portArg || process.env.PORT || 3210);

  return (async () => {
    if (!(await serverUp(port))) {
      console.error(`[share] 端口 ${port} 上还没有游戏服务。先启动它：`);
      console.error(`        node server/server.js ${port}`);
      console.error('        （或者双击 BombGame.exe / play.cmd）');
      process.exitCode = 1;
      return;
    }

    const order = wantTool ? [wantTool] : ['cloudflared', 'ngrok', 'lt'];
    const known = order.filter((t) => TOOLS[t]);

    for (const name of known) {
      const tool = TOOLS[name];
      if (name === 'cloudflared' && !hasCommand(tool.cmd)) continue;
      if (name === 'ngrok' && !hasCommand(tool.cmd)) continue;
      // localtunnel 兜底：npx 一般都在
      if (name === 'lt' && !hasCommand(tool.cmd)) continue;
      return run(name, tool, port);
    }

    console.error('[share] 没找到可用的隧道工具。任选一个装上就能用：');
    for (const [name, tool] of Object.entries(TOOLS)) {
      console.error(`  · ${name}：${tool.why}\n      安装：${tool.install}`);
    }
    console.error('');
    console.error('国内网络如果 GitHub 打不开，也可以用国内的内网穿透：natapp / cpolar / 花生壳，');
    console.error(`把它们的隧道指向 http://127.0.0.1:${port} 即可（思路完全一样）。`);
    process.exitCode = 1;
  })();
}

function hasCommand(cmd) {
  const which = process.platform === 'win32' ? 'where' : 'which';
  try {
    const r = spawnSync(which, [cmd], { stdio: 'ignore' });
    return r.status === 0;
  } catch {
    return false;
  }
}

function run(name, tool, port) {
  console.log(`[share] 用 ${name} 起隧道…（第一次可能要几秒）`);
  const child = spawn(tool.cmd, tool.args(port), { stdio: ['ignore', 'pipe', 'pipe'] });
  let printed = false;

  const onData = (chunk) => {
    const text = chunk.toString();
    if (process.env.BOMB_DEBUG) process.stderr.write(text);
    const url = parsePublicUrl(text);
    if (url && !printed) {
      printed = true;
      printBanner(url, name, port);
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  child.on('error', (e) => {
    console.error(`[share] 启动 ${name} 失败：${e.message}`);
    console.error(`        安装方式：${tool.install}`);
    process.exitCode = 1;
  });

  child.on('exit', (code) => {
    if (!printed) {
      console.error(`[share] ${name} 退出了（code ${code}），没拿到公网地址。`);
      console.error(`        如果提示要登录/令牌：${tool.install}`);
      console.error('        加 BOMB_DEBUG=1 重跑可以看到原始输出。');
      process.exitCode = 1;
    }
  });

  const stop = () => {
    try {
      child.kill();
    } catch {}
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

// 只有直接运行时才执行（被测试 import 时不要跑）
const invokedDirectly =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  main();
}
