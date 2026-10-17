// Cloudflare 移植的本地冒烟测试（不需要 wrangler / 不需要 Cloudflare 账号）。
//
//   node tests/cloudflare.mjs
//
// 思路：Durable Object 的 fetch 就是一个普通的 `fetch(Request) -> Response`，
// Node 18+ 自带 Request/Response/ReadableStream，所以可以直接把 DO 类实例化出来打请求。
// 这样就能验证"传输层移植"是否正确 —— 游戏逻辑本来就是同一份 server/room.js。
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const { RoomDurableObject } = await import(pathToFileURL(path.join(ROOT, 'cloudflare/src/room-do.js')).href);
const worker = (await import(pathToFileURL(path.join(ROOT, 'cloudflare/src/index.js')).href)).default;

let failures = 0;
const ok = (m) => console.log('  ✓ ' + m);
const fail = (m) => {
  failures++;
  console.log('  ✗ ' + m);
};

const room = new RoomDurableObject({}, {});
const call = async (pathAndQuery, { method = 'GET', body } = {}) => {
  const res = await room.fetch(
    new Request(`https://room.example${pathAndQuery}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }),
  );
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data, headers: res.headers, text };
};

console.log('— Worker 路由（不需要 DO）—');
{
  const res = await worker.fetch(new Request('https://bomb.example.workers.dev/api/rooms'), {});
  const j = await res.json();
  if (res.ok && j.difficulties?.length === 5 && j.roles?.length >= 9) {
    ok(`/api/rooms 返回目录：${j.difficulties.length} 档难度 / ${j.roles.length} 个角色`);
  } else {
    fail(`/api/rooms 不对：${JSON.stringify(j).slice(0, 200)}`);
  }
}

console.log('\n— DO：建房 —');
const host = await call('/create?code=ABCD', { method: 'POST', body: { name: '云房主' } });
if (host.status === 200 && host.data.roomCode === 'ABCD') ok(`建房成功，房间号 ${host.data.roomCode}`);
else fail(`建房失败：${host.status} ${JSON.stringify(host.data)}`);
const hostId = host.data.playerId;

{
  const dup = await call('/create?code=ABCD', { method: 'POST', body: { name: '撞号' } });
  if (dup.status === 409) ok('同一个房间号重复建房会被拒（409）');
  else fail(`重复建房应该 409，实际 ${dup.status}`);
}

console.log('\n— DO：加入 / 状态 —');
const guest = await call('/join', { method: 'POST', body: { room: 'ABCD', name: '云专家' } });
if (guest.status === 200 && guest.data.playerId) ok('第二个人加入成功');
else fail(`加入失败：${guest.status} ${JSON.stringify(guest.data)}`);
const guestId = guest.data.playerId;

{
  const s = await call(`/state?room=ABCD&player=${hostId}`);
  // 契约：{ rev, state } —— 客户端是 applyState(payload.state, payload.rev)
  const st = s.data.state;
  if (s.status === 200 && st?.room?.phase === 'lobby' && st.room.players.length === 2) {
    ok(`/state 正常：阶段 ${st.room.phase}，${st.room.players.length} 人`);
  } else {
    fail(`/state 不对：${JSON.stringify(s.data).slice(0, 240)}`);
  }
  if (typeof s.data.rev === 'number') ok(`/state 带上了 rev（${s.data.rev}）——客户端靠它丢弃乱序旧帧`);
  else fail('/state 缺少 rev 字段，客户端 applyState 会拿到 undefined');
  if (st?.you?.id === hostId) ok('视图是按玩家过滤的（you 字段正确）');
}

console.log('\n— DO：动作（角色 / 开始 / 模块）—');
{
  const r1 = await call('/action', { method: 'POST', body: { room: 'ABCD', playerId: hostId, type: 'role', role: 'defuser' } });
  const r2 = await call('/action', { method: 'POST', body: { room: 'ABCD', playerId: guestId, type: 'role', role: 'expert' } });
  if (r1.status === 200 && r2.status === 200) ok('分配角色成功（拆弹者 / 专家）');
  else fail(`分配角色失败：${r1.status}/${r2.status}`);

  const start = await call('/action', { method: 'POST', body: { room: 'ABCD', playerId: hostId, type: 'start' } });
  if (start.status === 200) ok('开始游戏成功');
  else fail(`开始游戏失败：${start.status} ${JSON.stringify(start.data)}`);

  const s = await call(`/state?room=ABCD&player=${hostId}`);
  const st = s.data.state || {};
  if (st.room?.phase === 'playing' && st.bomb?.moduleStates?.length > 0) {
    ok(`进入游戏：${st.bomb.moduleStates.length} 个模块，剩余 ${Math.round((st.remainingMs || 0) / 1000)} 秒`);
  } else {
    fail(`没进入游戏：${JSON.stringify(st.bomb || st.room).slice(0, 200)}`);
  }

  // 拆弹者用错的动作 → 应该记失误（服务端权威逻辑原样复用）
  const mod = st.bomb.moduleStates[0];
  const wrong = await call('/action', {
    method: 'POST',
    body: { room: 'ABCD', playerId: hostId, type: 'module', uid: mod.uid, action: { type: 'tap' } },
  });
  if (wrong.status === 200) ok('模块操作被受理（判定走的是同一套 Game.act）');
  else fail(`模块操作失败：${wrong.status} ${JSON.stringify(wrong.data)}`);

  // 专家不能操作模块
  const deny = await call('/action', {
    method: 'POST',
    body: { room: 'ABCD', playerId: guestId, type: 'module', uid: mod.uid, action: { type: 'tap' } },
  });
  if (deny.status >= 400) ok(`专家操作模块被拒绝（${deny.status}）`);
  else fail(`专家居然能操作模块：${deny.status}`);
}

console.log('\n— DO：SSE —');
{
  const res = await room.fetch(new Request(`https://room.example/events?room=ABCD&player=${hostId}`));
  const ct = res.headers.get('content-type') || '';
  if (res.ok && ct.includes('text/event-stream')) ok(`SSE 建立成功（${ct}）`);
  else fail(`SSE 失败：${res.status} ${ct}`);

  const reader = res.body.getReader();
  const { value } = await reader.read();
  const first = new TextDecoder().decode(value || new Uint8Array());
  // 客户端用 es.onmessage 收状态 -> 必须是无名事件（只有 data:，不能带 event: state）
  if (first.includes('data: {') && !first.includes('event: state')) {
    ok('SSE 第一帧就是完整 state，且是"无名事件"（客户端 es.onmessage 才收得到）');
  } else {
    fail(`SSE 第一帧格式不对（客户端会收不到）：${first.slice(0, 120)}`);
  }
  // 还要是 { rev, state } 包裹，否则客户端 applyState(undefined) 页面不更新
  const payload = JSON.parse(first.replace(/^data: /, '').trim());
  if (typeof payload.rev === 'number' && payload.state?.you?.id === hostId) {
    ok(`SSE 帧结构正确：{ rev: ${payload.rev}, state }`);
  } else {
    fail(`SSE 帧结构不对（客户端会拿不到 state）：${JSON.stringify(payload).slice(0, 160)}`);
  }

  await reader.cancel();
  room.stopTickerIfIdle();
  if (!room.ticker) ok('取消订阅后定时器停掉了（不会白烧 CPU）');
  else fail('订阅取消后 ticker 还在跑');
}

console.log('\n— Worker 转发（关键：查询参数不能被吞掉）—');
{
  // 假 ROOMS 绑定：把 Worker 的 stub.fetch 转给我们手里的 DO，并记录它收到的 URL
  const inner = new RoomDurableObject({}, {});
  const seen = [];
  const env = {
    ROOMS: {
      idFromName: (name) => name,
      get: () => ({
        fetch: (target, init) => {
          seen.push(String(target));
          return inner.fetch(new Request(String(target), init));
        },
      }),
    },
  };
  const wfetch = async (p, init) => {
    const res = await worker.fetch(new Request(`https://bomb.example.workers.dev${p}`, init), env);
    return res;
  };

  const created = await wfetch('/api/create', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Worker 房主' }),
  });
  const cj = await created.json();
  if (created.status === 200 && cj.roomCode) ok(`Worker /api/create 成功（房间 ${cj.roomCode}）`);
  else fail(`Worker /api/create 失败：${created.status} ${JSON.stringify(cj)}`);

  const code = cj.roomCode;
  const pid = cj.playerId;

  const stateRes = await wfetch(`/api/state?room=${code}&player=${pid}`);
  const stateJson = await stateRes.json().catch(() => ({}));
  const stateUrl = seen.find((u) => u.includes('/state')) || '';
  if (stateUrl.includes(`player=${pid}`)) ok('转发 /api/state 时保留了 player 参数');
  else fail(`转发 /api/state 丢了 player：${stateUrl}`);
  if (stateRes.status === 200 && stateJson.state?.room?.code === code) ok('Worker /api/state 返回正常');
  else fail(`Worker /api/state 失败：${stateRes.status} ${JSON.stringify(stateJson).slice(0, 160)}`);

  // 这一条就是用户报的"点击加入后右上角连接断开"：SSE 到 DO 时必须带 player
  const sseRes = await wfetch(`/api/events?room=${code}&player=${pid}`);
  const sseUrl = seen.find((u) => u.includes('/events')) || '';
  const ct = sseRes.headers.get('content-type') || '';
  if (sseUrl.includes(`player=${pid}`)) ok('转发 /api/events 时保留了 player 参数');
  else fail(`转发 /api/events 丢了 player（EventSource 会直接报错）：${sseUrl}`);
  if (sseRes.status === 200 && ct.includes('text/event-stream')) ok(`SSE 透传正常（${ct}）`);
  else fail(`SSE 转发失败：${sseRes.status} ${ct}`);

  if (sseRes.body) {
    const reader = sseRes.body.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value || new Uint8Array());
    if (text.includes('data: {')) ok('SSE 第一帧经 Worker 透传后仍然可读（无名事件）');
    else fail(`SSE 第一帧经转发后不对：${text.slice(0, 100)}`);
    await reader.cancel();
  }
  inner.stopTickerIfIdle();
}

console.log('\n— 房间不存在时的行为 —');
{
  const bad = await call('/state?room=ZZZZ&player=x');
  if (bad.status === 404) ok('不存在的房间返回 404');
  else fail(`应该 404，实际 ${bad.status}`);
}

console.log(`\n失败 ${failures} 项`);
process.exitCode = failures ? 1 : 0;
