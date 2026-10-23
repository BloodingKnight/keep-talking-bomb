// 骗子酒馆 HTTP / SSE 端到端测试：
//
//   node server/server.js 3388 --test
//   node tests/liar.mjs http://127.0.0.1:3388
//
// 依赖 --test 才开放的 liarDebug 后门来摆出确定的牌局。

import http from 'node:http';

const BASE = process.argv[2] || 'http://127.0.0.1:3388';

let failures = 0;
let checks = 0;
const ok = (m) => { checks++; console.log('  ✓ ' + m); };
const fail = (m) => { failures++; console.error('  ✗ ' + m); };
const assert = (cond, m) => (cond ? ok(m) : fail(m));

async function post(path, body = {}) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${path} -> ${res.status}`);
  return data;
}

async function postError(path, body = {}) {
  try {
    await post(path, body);
    return null;
  } catch (e) {
    return e.message;
  }
}

const create = (name, extra = {}) => post('/api/liar/create', { name, ...extra });
const join = (room, name) => post('/api/liar/join', { room, name });
const state = async (room, playerId) => {
  const res = await fetch(`${BASE}/api/liar/state?room=${encodeURIComponent(room)}&player=${encodeURIComponent(playerId)}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `state -> ${res.status}`);
  return data.state;
};
const act = (room, playerId, payload) => post('/api/liar/action', { room, playerId, ...payload });
const debug = (room, playerId, payload) => act(room, playerId, { type: 'debug', ...payload });
const rooms = async () => (await fetch(`${BASE}/api/liar/rooms`).then((r) => r.json())).rooms;

function sse(room, playerId) {
  const chunks = [];
  let done = false;
  const req = http.get(`${BASE}/api/liar/events?room=${encodeURIComponent(room)}&player=${encodeURIComponent(playerId)}`, (res) => {
    res.setEncoding('utf8');
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => { done = true; });
  });
  req.on('error', () => { done = true; });
  const text = () => chunks.join('');
  const waitFor = async (needle, ms = 4000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (text().includes(needle)) return true;
      if (done) return text().includes(needle);
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  };
  return { text, waitFor, close: () => { try { req.destroy(); } catch { /* ignore */ } } };
}

console.log(`骗子酒馆端到端测试 @ ${BASE}\n`);

// ---------------------------------------------------------------- 1) 建房 / 加入
console.log('— 建房 / 加入 / 房间列表 —');
const a = await create('甲');
const room = a.roomCode;
const b = await join(room, '乙');
const c = await join(room, '丙');
const d = await join(room, '丁');
if (/^[A-Z2-9]{4}$/.test(room)) ok(`拿到 4 位房间号 ${room}`);
else fail(`房间号格式不对：${room}`);
const full = await postError('/api/liar/join', { room, name: '第五人' });
assert(full && /坐满|最多/.test(full), `第 5 个人被拒绝：${full}`);
let st = await state(room, a.playerId);
assert(st.room.players.length === 4, '四个人都坐在桌上');
const list = await rooms();
const item = list.find((r) => r.code === room);
assert(!!item && item.players === 4 && item.phase === 'lobby', '房间出现在骗子酒馆列表里');
const catalog = await fetch(BASE + '/api/liar/rooms').then((r) => r.json());
assert(catalog.rules && catalog.rules.maxPlayers === 4, '房间接口带上了规则元数据');

// ---------------------------------------------------------------- 2) 开始 / 越权
console.log('\n— 开始游戏 / 越权 —');
const notHostStart = await postError('/api/liar/action', { room, playerId: b.playerId, type: 'start' });
assert(notHostStart && /房主/.test(notHostStart), `非房主不能开始：${notHostStart}`);
await act(room, a.playerId, { type: 'start' });
st = await state(room, a.playerId);
assert(st.room.phase === 'playing' && st.room.round === 1, '房主开始后进入第 1 轮');
assert(st.you.hand.length === 5, '开局后自己的视图里有 5 张手牌');
assert(st.room.players.filter((p) => !p.isYou).every((p) => p.cardCount === 5 && p.hand === undefined), '别人的手牌只有数量，没有内容');
assert(st.you.bulletAt === null, '活着的时候看不到自己的实弹位置');
assert(['Q', 'K', 'A'].includes(st.room.tableCard), `目标牌是 ${st.room.tableCard}`);
const turnId = st.room.turnId;
const notTurn = st.room.players.find((p) => p.id !== turnId);
const handOfNotTurn = (await state(room, notTurn.id)).you.hand;
const outOfTurn = await postError('/api/liar/action', { room, playerId: notTurn.id, type: 'play', cards: [handOfNotTurn[0]] });
assert(outOfTurn && /还没轮到/.test(outOfTurn), `没轮到的玩家不能出牌：${outOfTurn}`);

// ---------------------------------------------------------------- 3) 诚实质疑
console.log('\n— 质疑：上家没撒谎 → 质疑者挨枪 —');
await debug(room, a.playerId, { op: 'setTable', rank: 'Q' });
await debug(room, a.playerId, { op: 'setHand', targetId: a.playerId, cards: ['Q1', 'J1'] });
await debug(room, a.playerId, { op: 'setTurn', targetId: a.playerId });
await debug(room, a.playerId, { op: 'setBullet', targetId: b.playerId, chamber: 1 });
await act(room, a.playerId, { type: 'play', cards: ['Q1', 'J1'] });
const bTurn = await state(room, b.playerId);
assert(bTurn.canChallenge === true, '下家可以质疑');
assert(bTurn.room.turnId === b.playerId, '出牌后轮到下家');
await act(room, b.playerId, { type: 'challenge' });
const stA = await state(room, a.playerId);
assert(stA.room.phase === 'reveal' && stA.reveal.kind === 'challenge', '质疑后所有人在亮牌阶段');
assert(stA.reveal.honest === true && stA.reveal.shot.playerId === b.playerId, 'Q + 赖子判为诚实，质疑者挨枪');
assert(stA.room.players.find((p) => p.id === b.playerId).alive === false, '质疑者第 1 枪命中实弹，出局');
await debug(room, a.playerId, { op: 'advance' });
const round2 = await state(room, a.playerId);
assert(round2.room.phase === 'playing' && round2.room.round === 2, '亮牌结束自动进入第 2 轮');
assert(round2.room.turnId === c.playerId, '上一轮输家（出局）的下一位先出牌');
assert(round2.you.hand.length === 5, '新一轮重新摸 5 张');

// ---------------------------------------------------------------- 4) 聊天 / 重连
console.log('\n— 聊天 / 重连 —');
await act(room, c.playerId, { type: 'chat', text: '  这把我一定不抽到实弹  ' });
const chatState = await state(room, a.playerId);
assert(chatState.chat.at(-1).text === '这把我一定不抽到实弹', '聊天广播到所有人，并去掉首尾空白');
await act(room, b.playerId, { type: 'leave' });
let bState = await state(room, a.playerId);
assert(bState.room.players.find((p) => p.id === b.playerId).connected === false, '游戏中退出只标记离线，保留座位');
const bBack = await post('/api/liar/join', { room, name: '乙', playerId: b.playerId });
assert(bBack.playerId === b.playerId, '用同一个玩家 id 重连回原座位');
bState = await state(room, a.playerId);
assert(bState.room.players.find((p) => p.id === b.playerId).connected === true, '重连后恢复在线');
await act(room, a.playerId, { type: 'closeRoom' });

// ---------------------------------------------------------------- 5) 出完手牌 / 放过
console.log('\n— 出完手牌：放过 → 本轮结束 —');
const r2 = await create('房主2');
const room2 = r2.roomCode;
const e2 = await join(room2, '乙2');
await act(room2, r2.playerId, { type: 'start' });
await debug(room2, r2.playerId, { op: 'setTable', rank: 'K' });
await debug(room2, r2.playerId, { op: 'setHand', targetId: r2.playerId, cards: ['K2'] });
await debug(room2, r2.playerId, { op: 'setTurn', targetId: r2.playerId });
await act(room2, r2.playerId, { type: 'play', cards: ['K2'] });
const finalState = await state(room2, e2.playerId);
assert(finalState.room.stage === 'finalcall', '出完手牌进入"质疑 / 放过"阶段');
assert(finalState.canPassFinal === true && finalState.canPlay === false, '下家只能质疑或放过，不能继续出牌');
assert(finalState.finalPlayerName === '房主2', '视图里标出了出完手牌的人');
await act(room2, e2.playerId, { type: 'passFinal' });
const passed = await state(room2, e2.playerId);
assert(passed.reveal.kind === 'passed' && passed.reveal.winnerId === r2.playerId, '放过 = 出完牌的人赢下本轮');
assert(passed.you.shots === 0, '放过时没有人挨枪');
await debug(room2, r2.playerId, { op: 'advance' });
const nextRound = await state(room2, e2.playerId);
assert(nextRound.room.phase === 'playing' && nextRound.room.round === 2 && nextRound.room.turnId === r2.playerId, '下一轮由本轮赢家先出');

// ---------------------------------------------------------------- 6) 抓到骗子 / 终局
console.log('\n— 抓到骗子 / 出局 / 终局 —');
const r3 = await create('房主3');
const room3 = r3.roomCode;
const e3 = await join(room3, '乙3');
await act(room3, r3.playerId, { type: 'start' });
await debug(room3, r3.playerId, { op: 'setTable', rank: 'A' });
await debug(room3, r3.playerId, { op: 'setHand', targetId: r3.playerId, cards: ['K1'] });
await debug(room3, r3.playerId, { op: 'setTurn', targetId: r3.playerId });
await debug(room3, r3.playerId, { op: 'setBullet', targetId: r3.playerId, chamber: 1 });
await act(room3, r3.playerId, { type: 'play', cards: ['K1'] });
await act(room3, e3.playerId, { type: 'challenge' });
const caught = await state(room3, e3.playerId);
assert(caught.reveal.honest === false && caught.reveal.shot.playerId === r3.playerId, 'K 在目标 A 下被抓，出牌人挨枪');
assert(caught.room.players.find((p) => p.id === r3.playerId).alive === false, '出牌人第 1 枪出局');
await debug(room3, r3.playerId, { op: 'advance' });
const ended = await state(room3, e3.playerId);
assert(ended.room.phase === 'ended' && ended.result.winnerId === e3.playerId, '只剩一人 → 游戏结束，乙3 获胜');
assert(ended.result.players.find((p) => p.id === r3.playerId).bulletAt === 1, '终局公开所有人的实弹位置');
const deadView = await state(room3, r3.playerId);
assert(deadView.result && deadView.result.winnerId === e3.playerId, '出局的人也能看终局');
const notHostRestart = await postError('/api/liar/action', { room: room3, playerId: e3.playerId, type: 'restart' });
assert(notHostRestart && /房主/.test(notHostRestart), '非房主不能开下一局');
await act(room3, r3.playerId, { type: 'restart' });
const restarted = await state(room3, e3.playerId);
assert(restarted.room.phase === 'lobby', '再来一局回到准备区');
await act(room3, r3.playerId, { type: 'closeRoom' });

// ---------------------------------------------------------------- 7) 设置 / 踢人 / 关闭
console.log('\n— 设置 / 踢人 / 关闭房间 —');
const r4 = await create('房主4');
const room4 = r4.roomCode;
const e4 = await join(room4, '乙4');
const notHostCfg = await postError('/api/liar/action', { room: room4, playerId: e4.playerId, type: 'configure', turnSeconds: 60 });
assert(notHostCfg && /房主/.test(notHostCfg), '非房主不能改设置');
await act(room4, r4.playerId, { type: 'configure', turnSeconds: 30 });
const cfg = await state(room4, e4.playerId);
assert(cfg.room.config.turnSeconds === 30, '房主把出牌倒计时设为 30 秒');
const badCfg = await postError('/api/liar/action', { room: room4, playerId: r4.playerId, type: 'configure', turnSeconds: 7 });
assert(!badCfg, '非法倒计时不会报错，而是回落到不限时');
const cfg2 = await state(room4, e4.playerId);
assert(cfg2.room.config.turnSeconds === 0, '7 秒被规范成 0（不限时）');

const kickedSse = sse(room4, e4.playerId);
await kickedSse.waitFor('"phase":"lobby"');
await act(room4, r4.playerId, { type: 'kick', targetId: e4.playerId });
assert(await kickedSse.waitFor('event: closed'), '被踢的人收到 closed 事件');
kickedSse.close();
const kickedStatus = await fetch(`${BASE}/api/liar/state?room=${room4}&player=${e4.playerId}`).then((r) => r.status);
assert(kickedStatus === 404, '被踢后无法再读取该座位（404）');

const watcher = sse(room4, r4.playerId);
await watcher.waitFor('"phase":"lobby"');
await act(room4, r4.playerId, { type: 'closeRoom' });
assert(await watcher.waitFor('event: closed'), '房主关闭房间时其他人收到 closed 事件');
watcher.close();
const closedStatus = await fetch(`${BASE}/api/liar/state?room=${room4}&player=${r4.playerId}`).then((r) => r.status);
assert(closedStatus === 404, '关闭后房间不存在');
assert(!(await rooms()).some((r) => r.code === room4), '关闭的房间从列表消失');

// ---------------------------------------------------------------- 8) SSE 状态推送
console.log('\n— SSE 实时推送 —');
const r5 = await create('房主5');
const room5 = r5.roomCode;
const e5 = await join(room5, '乙5');
const live = sse(room5, e5.playerId);
assert(await live.waitFor('"phase":"lobby"'), 'SSE 连上后立刻收到一帧状态');
await act(room5, r5.playerId, { type: 'chat', text: 'SSE 测试消息' });
assert(await live.waitFor('SSE 测试消息'), '别的玩家发聊天，SSE 推送新状态');
await act(room5, r5.playerId, { type: 'start' });
assert(await live.waitFor('"phase":"playing"'), '房主开始后 SSE 推送 playing 状态');
live.close();
await act(room5, r5.playerId, { type: 'closeRoom' });

// ---------------------------------------------------------------- 9) 页面 / 静态资源
console.log('\n— 页面 —');
for (const [path, needle] of [
  ['/liar', '骗子酒馆'],
  ['/static/liar.js', '骗子酒馆客户端'],
  ['/static/liar.css', '.liar-board'],
]) {
  const res = await fetch(BASE + path);
  const text = await res.text();
  assert(res.ok && text.includes(needle), `GET ${path} 正常（${res.status}）`);
}

console.log(`\n${checks} 项检查，失败 ${failures} 项`);
process.exit(failures ? 1 : 0);
