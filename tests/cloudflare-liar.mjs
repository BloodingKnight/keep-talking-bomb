// 骗子酒馆 Cloudflare Durable Object 的本地冒烟测试（不需要 wrangler / 账号）。
//
//   node tests/cloudflare-liar.mjs
//
// 和 tests/cloudflare.mjs 一样：DO 的 fetch 就是 fetch(Request) -> Response，
// 直接在 Node 里实例化，再走一遍建房、加入、开始、出牌、SSE、Worker 转发。
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const { LiarRoomDurableObject } = await import(pathToFileURL(path.join(ROOT, 'cloudflare/src/liar-do.js')).href);
const worker = (await import(pathToFileURL(path.join(ROOT, 'cloudflare/src/index.js')).href)).default;

let failures = 0;
const ok = (m) => console.log('  ✓ ' + m);
const fail = (m) => { failures++; console.log('  ✗ ' + m); };
const assert = (cond, m) => (cond ? ok(m) : fail(m));

const room = new LiarRoomDurableObject({}, {});
const call = async (pathAndQuery, { method = 'GET', body } = {}) => {
  const res = await room.fetch(new Request(`https://liar.example${pathAndQuery}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }));
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers, text };
};

console.log('— DO：建房 / 加入 —');
const host = await call('/create?code=L1AB', { method: 'POST', body: { name: '云房主', turnSeconds: 30 } });
assert(host.status === 200 && host.data.roomCode === 'L1AB', `建房成功（${host.data.roomCode}）`);
const hostId = host.data.playerId;

const dup = await call('/create?code=L1AB', { method: 'POST', body: { name: '撞号' } });
assert(dup.status === 409, '重复的房间号会被拒（409）');

const guest = await call('/join', { method: 'POST', body: { room: 'L1AB', name: '云酒客' } });
assert(guest.status === 200 && guest.data.playerId, '第二个人加入成功');
const guestId = guest.data.playerId;

const lobby = await call(`/state?room=L1AB&player=${hostId}`);
assert(lobby.data.state?.room?.phase === 'lobby', '准备阶段视图正常');
assert(lobby.data.state?.room?.config?.turnSeconds === 30, '房主设置的倒计时同步到视图');
assert(!JSON.stringify(lobby.data.state).includes('"hand":["Q'), '准备区没有泄漏手牌');

console.log('\n— DO：开始 / 出牌 / 越权 —');
const start = await call('/action', { method: 'POST', body: { room: 'L1AB', playerId: hostId, type: 'start' } });
assert(start.status === 200, '房主开始游戏成功');
let st = (await call(`/state?room=L1AB&player=${hostId}`)).data.state;
assert(st.room.phase === 'playing' && st.you.hand.length === 5, '开局后每人 5 张手牌');
assert(st.room.players.filter((p) => !p.isYou).every((p) => p.cardCount === 5 && p.hand === undefined), '对手手牌只有数量');

const turnId = st.room.turnId;
const otherId = turnId === hostId ? guestId : hostId;
const other = (await call(`/state?room=L1AB&player=${otherId}`)).data.state;
const outOfTurn = await call('/action', { method: 'POST', body: { room: 'L1AB', playerId: otherId, type: 'play', cards: [other.you.hand[0]] } });
assert(outOfTurn.status === 400 && /还没轮到/.test(outOfTurn.data.error), `没轮到的人不能出牌（${outOfTurn.data.error}）`);

const current = (await call(`/state?room=L1AB&player=${turnId}`)).data.state;
const play = await call('/action', { method: 'POST', body: { room: 'L1AB', playerId: turnId, type: 'play', cards: [current.you.hand[0]] } });
assert(play.status === 200, '轮到的玩家可以出牌');
st = (await call(`/state?room=L1AB&player=${turnId}`)).data.state;
assert(st.you.hand.length === 4 && st.room.turnId !== turnId, '出牌后手牌 -1，并轮到下家');
assert(st.room.players.find((p) => p.id === turnId).cardCount === 4, '其他人看到的是手牌数量 4');

const chat = await call('/action', { method: 'POST', body: { room: 'L1AB', playerId: guestId, type: 'chat', text: '云聊天' } });
assert(chat.status === 200, '聊天接口正常');
const chatState = (await call(`/state?room=L1AB&player=${hostId}`)).data.state;
assert(chatState.chat.at(-1)?.text === '云聊天', '聊天出现在所有人的视图里');

const outsiderClose = await call('/action', { method: 'POST', body: { room: 'L1AB', playerId: guestId, type: 'closeRoom' } });
assert(outsiderClose.status === 400, '非房主不能关闭房间');

console.log('\n— DO：SSE —');
{
  const res = await room.fetch(new Request(`https://liar.example/events?room=L1AB&player=${hostId}`));
  assert((res.headers.get('content-type') || '').includes('text/event-stream'), 'SSE 建立成功');
  const reader = res.body.getReader();
  const { value } = await reader.read();
  const first = new TextDecoder().decode(value || new Uint8Array());
  const payload = JSON.parse(first.replace(/^data: /, '').trim());
  assert(payload.state?.you?.id === hostId && typeof payload.rev === 'number', 'SSE 第一帧是 { rev, state }，且是无名事件');
  await reader.cancel();
  room.stopTickerIfIdle();
  assert(!room.ticker, '取消订阅后 ticker 停掉');
}

console.log('\n— Worker：/api/liar/* 转发 —');
{
  const inner = new LiarRoomDurableObject({}, {});
  const seen = [];
  const env = {
    ROOMS: { idFromName: (n) => n, get: () => ({ fetch: () => new Response('{}') }) },
    LIAR_ROOMS: {
      idFromName: (name) => name,
      get: () => ({
        fetch: (target, init) => {
          seen.push(String(target));
          return inner.fetch(new Request(String(target), init));
        },
      }),
    },
  };
  const wfetch = (p, init) => worker.fetch(new Request(`https://bomb.example.workers.dev${p}`, init), env);

  const catalog = await (await wfetch('/api/liar/rooms')).json();
  assert(catalog.rules?.maxPlayers === 4, 'README 里说的目录接口在 Workers 版也返回规则');

  const created = await wfetch('/api/liar/create', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'W 房主' }),
  });
  const cj = await created.json();
  assert(created.status === 200 && cj.roomCode, `Worker /api/liar/create 成功（${cj.roomCode}）`);

  const code = cj.roomCode;
  const pid = cj.playerId;
  const stateRes = await wfetch(`/api/liar/state?room=${code}&player=${pid}`);
  const sj = await stateRes.json().catch(() => ({}));
  const stateUrl = seen.find((u) => u.includes('/state')) || '';
  assert(stateUrl.includes(`player=${pid}`), '转发 /api/liar/state 时保留了 player 参数');
  assert(stateRes.status === 200 && sj.state?.room?.code === code, 'Worker /api/liar/state 返回正常');

  const sseRes = await wfetch(`/api/liar/events?room=${code}&player=${pid}`);
  const sseUrl = seen.find((u) => u.includes('/events')) || '';
  assert(sseUrl.includes(`player=${pid}`), '转发 /api/liar/events 时保留了 player 参数');
  assert((sseRes.headers.get('content-type') || '').includes('text/event-stream'), 'SSE 经 Worker 透传正常');
  if (sseRes.body) {
    const reader = sseRes.body.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value || new Uint8Array());
    assert(text.includes('data: {'), 'SSE 第一帧经 Worker 透传后仍可读');
    await reader.cancel();
  }
  inner.stopTickerIfIdle();
}

console.log(`\n失败 ${failures} 项`);
process.exitCode = failures ? 1 : 0;
