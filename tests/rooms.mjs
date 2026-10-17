// Tests for leaving / closing rooms and the lobby room list.
//
//   node server/server.js 3388 --test
//   node tests/rooms.mjs http://127.0.0.1:3388

const BASE = process.argv[2] || 'http://127.0.0.1:3388';

let failures = 0;
const fail = (m) => { failures++; console.error('  ✗ ' + m); };
const ok = (m) => console.log('  ✓ ' + m);

async function api(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${path} -> ${res.status}`);
  return data;
}
const send = (room, playerId, payload) => api('/api/action', { room, playerId, ...payload });
const state = async (room, playerId) => (await fetch(`${BASE}/api/state?room=${room}&player=${playerId}`).then((r) => r.json())).state;
const rooms = async () => (await fetch(`${BASE}/api/rooms`).then((r) => r.json())).rooms;
const inList = (list, code) => list.some((r) => r.code === code);

console.log(`房间退出/关闭测试 @ ${BASE}\n`);

// ---------------------------------------------------- 1) 准备阶段退出房间
console.log('— 准备阶段退出 —');
const h = await api('/api/create', { name: '房主', difficulty: 'normal' });
const room = h.roomCode;
const a = await api('/api/join', { room, name: '甲', role: 'expert' });
const b = await api('/api/join', { room, name: '乙', role: 'blind' });
if (inList(await rooms(), room)) ok(`房间 ${room} 出现在房间列表里`);
else fail('新房间没有出现在房间列表里');

await send(room, a.playerId, { type: 'leave' });
let st = await state(room, h.playerId);
if (st.room.players.some((p) => p.id === a.playerId)) fail('准备阶段退出后，玩家还留在房间里');
else ok('准备阶段退出：玩家被移出房间');
if (st.room.players.find((p) => p.id === b.playerId)) ok('其他玩家不受影响');
else fail('其他玩家被误删');
ok(`房间现在有 ${st.room.players.length} 人`);

// 退出的人不能再操作
const gone = await api('/api/state', {}).catch(() => null);
const goneCheck = await fetch(`${BASE}/api/state?room=${room}&player=${a.playerId}`).then((r) => r.status);
if (goneCheck === 404) ok('退出后无法再读取该玩家的视图（404）');
else fail(`退出后仍能读取视图（${goneCheck}）`);

// ------------------------------------------------ 2) 最后一个人退出 → 房间消失
console.log('\n— 最后一人退出后房间自动回收 —');
await send(room, b.playerId, { type: 'leave' });
const last = await send(room, h.playerId, { type: 'leave' });
if (last.roomDeleted) ok('最后一人退出：服务端报告房间已删除');
else fail('最后一人退出后房间没有删除');
if (!inList(await rooms(), room)) ok('空房间从房间列表消失');
else fail('空房间仍然出现在房间列表里');
const deadRoom = await fetch(`${BASE}/api/state?room=${room}&player=${h.playerId}`).then((r) => r.status);
if (deadRoom === 404) ok('房间删除后接口返回 404');
else fail(`已删除的房间仍然可访问（${deadRoom}）`);

// --------------------------------------------------- 3) 游戏中退出保留座位
console.log('\n— 游戏进行中退出：保留座位，可重连 —');
const h2 = await api('/api/create', { name: '房主2', difficulty: 'easy' });
const room2 = h2.roomCode;
const d2 = await api('/api/join', { room: room2, name: '拆弹手', role: 'defuser' });
const e2 = await api('/api/join', { room: room2, name: '专家', role: 'expert' });
await send(room2, h2.playerId, { type: 'start' });
await send(room2, d2.playerId, { type: 'leave' });
let s2 = await state(room2, e2.playerId);
const seat = s2.room.players.find((p) => p.id === d2.playerId);
if (seat && seat.connected === false) ok('游戏中退出：座位保留但标记为离线');
else fail('游戏中退出后座位状态不对');
if (s2.room.phase === 'playing') ok('游戏仍在进行，其他人可以继续');
else fail(`退出后阶段变成了 ${s2.room.phase}`);

const rejoin = await api('/api/join', { room: room2, name: '拆弹手', playerId: d2.playerId });
if (rejoin.playerId === d2.playerId) ok('用同一个 playerId 重连回了原座位');
else fail('重连拿到了新的 playerId');
const back = await state(room2, d2.playerId);
if (back.you.role === 'defuser' && back.canInteract) ok('重连后仍是拆弹者，可以继续操作');
else fail(`重连后角色异常：${back.you.role}`);

// --------------------------------------------------------- 4) 踢人
console.log('\n— 房主踢人 —');
await send(room2, h2.playerId, { type: 'kick', targetId: d2.playerId });
const afterKick = await state(room2, e2.playerId);
if (!afterKick.room.players.some((p) => p.id === d2.playerId)) ok('被踢的玩家已离开房间');
else fail('踢人没有生效');
const kickedStatus = await fetch(`${BASE}/api/state?room=${room2}&player=${d2.playerId}`).then((r) => r.status);
if (kickedStatus === 404) ok('被踢后该玩家无法再访问房间');
else fail(`被踢玩家仍可访问（${kickedStatus}）`);

// --------------------------------------------- 5) 房主退出 → 房主自动转移
console.log('\n— 房主退出后房主转移 —');
await send(room2, h2.playerId, { type: 'leave' });
const s3 = await state(room2, e2.playerId);
if (s3.room.hostId === e2.playerId) ok(`房主自动转给了 ${s3.room.players.find((p) => p.id === e2.playerId).name}`);
else fail(`房主没有转移（hostId=${s3.room.hostId}）`);
const closeByOther = await send(room2, e2.playerId, { type: 'closeRoom' });
if (closeByOther.closed) ok('新房主可以关闭房间');
else fail('新房主无法关闭房间');

// --------------------------------------------------- 6) 非房主不能关房间
console.log('\n— 权限：只有房主能关房间 —');
const h4 = await api('/api/create', { name: '房主4', difficulty: 'easy' });
const room4 = h4.roomCode;
const g4 = await api('/api/join', { room: room4, name: '路人', role: 'expert' });
const denied = await send(room4, g4.playerId, { type: 'closeRoom' }).then(() => null).catch((e) => e.message);
if (denied) ok(`非房主关房间被拒绝：${denied}`);
else fail('非房主竟然关闭了房间');
if (inList(await rooms(), room4)) ok('房间仍然存在');
else fail('房间被误删');

// --------------------------------------------------- 7) 关闭房间通知所有人
console.log('\n— 关闭房间：所有人收到通知 —');
const { default: http } = await import('node:http');
const eventsOf = (playerId) => new Promise((resolve) => {
  const req = http.get(`${BASE}/api/events?room=${room4}&player=${playerId}`, (res) => {
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (c) => {
      buf += c;
      if (buf.includes('event: closed')) { req.destroy(); resolve('closed'); }
    });
  });
  req.on('error', () => resolve('error'));
  setTimeout(() => { try { req.destroy(); } catch { /* ignore */ } resolve('timeout'); }, 4000);
});
const watcher = eventsOf(g4.playerId);
await new Promise((r) => setTimeout(r, 250));
await send(room4, h4.playerId, { type: 'closeRoom' });
if (await watcher === 'closed') ok('房间里的其他人收到了 closed 事件');
else fail('其他人没有收到房间关闭通知');
if (!inList(await rooms(), room4)) ok('关闭后房间从列表消失');
else fail('关闭后房间仍在列表里');

console.log(`\n失败 ${failures} 项`);
process.exit(failures ? 1 : 0);
