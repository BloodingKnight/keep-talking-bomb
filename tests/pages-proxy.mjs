// Pages Function 反向代理的本地测试：不需要 Cloudflare 账号。
//
//   node tests/pages-proxy.mjs
//
// 做法：起一个本地游戏服务端（Node 版），把 functions/api/[[path]].js 里的
// onRequest 当成普通函数调用，env.GAME_ORIGIN 指向本地端口。
// 覆盖：目录接口转发、POST 转发（带 body）、SSE 流式转发、上游挂掉时的 502。
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 3495;
const ORIGIN = `http://127.0.0.1:${PORT}`;

let failures = 0;
const ok = (m) => console.log('  ✓ ' + m);
const fail = (m) => {
  failures++;
  console.log('  ✗ ' + m);
};

const { onRequest } = await import(pathToFileURL(path.join(ROOT, 'functions', 'api', '[[path]].js')).href);

// 起一个本地服务端当"上游"
const server = spawn(process.execPath, ['server/server.js', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUp() {
  for (let i = 0; i < 200; i++) {
    try {
      const res = await fetch(`${ORIGIN}/api/rooms`, { signal: AbortSignal.timeout(500) });
      if (res.ok) return true;
    } catch {}
    await sleep(50);
  }
  return false;
}

const call = async (pathAndQuery, init = {}, env = { GAME_ORIGIN: ORIGIN }) => {
  const request = new Request(`https://demo.pages.dev${pathAndQuery}`, init);
  const res = await onRequest({ request, env });
  return res;
};

try {
  if (!(await waitUp())) {
    console.error('本地上游没起来，测试没法继续');
    process.exitCode = 1;
  } else {
    console.log('— 目录接口 —');
    {
      const res = await call('/api/rooms');
      const j = await res.json();
      if (res.status === 200 && j.difficulties?.length === 5) ok(`GET /api/rooms 被正确转发（${j.difficulties.length} 档难度）`);
      else fail(`GET /api/rooms 不对：${res.status} ${JSON.stringify(j).slice(0, 160)}`);
      if (j.network?.urls?.length) ok(`上游的 network 信息也带回来了：${j.network.urls[0]}`);
    }

    console.log('\n— POST 转发（带 body）—');
    let roomCode = '';
    let playerId = '';
    {
      const res = await call('/api/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Pages 房主' }),
      });
      const j = await res.json();
      roomCode = j.roomCode;
      playerId = j.playerId;
      if (res.status === 200 && roomCode && playerId) ok(`POST /api/create 转发成功（房间 ${roomCode}）`);
      else fail(`POST /api/create 失败：${res.status} ${JSON.stringify(j)}`);
    }

    console.log('\n— 状态接口 —');
    {
      const res = await call(`/api/state?room=${roomCode}&player=${playerId}`);
      const j = await res.json();
      // 注意：/api/state 返回的是 { rev, state: {...} } 包了一层
      if (res.status === 200 && j.state?.room?.code === roomCode) ok('/api/state 转发成功，房间号一致');
      else fail(`/api/state 不对：${res.status} ${JSON.stringify(j).slice(0, 160)}`);
    }

    console.log('\n— SSE 流式转发（不能 buffer）—');
    {
      const res = await call(`/api/events?room=${roomCode}&player=${playerId}`);
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('text/event-stream')) ok(`SSE 的 content-type 被保留：${ct}`);
      else fail(`SSE content-type 不对：${ct}`);

      const reader = res.body.getReader();
      const started = performance.now();
      const { value } = await reader.read();
      const took = performance.now() - started;
      const text = new TextDecoder().decode(value || new Uint8Array());
      // 客户端用 es.onmessage 收状态，所以必须是无名事件（只有 data:）
      if (text.includes('data: {') && took < 3000) ok(`SSE 第一帧在 ${Math.round(took)} ms 内到达（说明是流式转发）`);
      else fail(`SSE 第一帧不对或太慢（${Math.round(took)} ms）：${text.slice(0, 100)}`);
      await reader.cancel();
    }

    console.log('\n— 上游不可用 —');
    {
      const res = await call('/api/rooms', {}, { GAME_ORIGIN: 'http://127.0.0.1:1' });
      const j = await res.json();
      if (res.status === 502 && j.error) ok(`上游不通时返回 502 并给出原因（${j.error}）`);
      else fail(`上游不通时应该 502，实际 ${res.status}`);
    }

    console.log('\n— 没配 GAME_ORIGIN —');
    {
      const res = await call('/api/rooms', {}, {});
      const j = await res.json();
      if (res.status === 502 || res.status === 500) ok(`没配环境变量时明确报错（${res.status}）`);
      else fail(`没配 GAME_ORIGIN 时行为不明：${res.status}`);
    }
  }
} finally {
  server.kill();
  await sleep(300);
  console.log(`\n失败 ${failures} 项`);
  process.exitCode = failures ? 1 : 0;
}
