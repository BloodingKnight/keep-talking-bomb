// Tests for the three-monkey classic setup (blind operator / deaf bridge / mute manual),
// modelled on BOMBANANA's "see no evil / hear no evil / speak no evil" trio.
//
//   node server/server.js 3388 --test
//   node tests\threemonkeys.mjs http://127.0.0.1:3388

const BASE = process.argv[2] || 'http://127.0.0.1:3388';

let failures = 0;
const fail = (m) => { failures++; console.error('  ✗ ' + m); };
const ok = (m) => console.log('  ✓ ' + m);

async function api(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${path} -> ${res.status}`);
  return data;
}
const state = async (room, playerId) => (await fetch(`${BASE}/api/state?room=${room}&player=${playerId}`).then((r) => r.json())).state;

console.log(`三人经典配置（盲操 / 聋桥 / 哑手册）@ ${BASE}\n`);

// -------------------------------------------------------------- 预设与角色
console.log('— 角色预设 —');
const catalog = await fetch(`${BASE}/api/rooms`).then((r) => r.json());
const classic = (catalog.presets || []).find((p) => p.id === 'classic3');
if (classic) ok(`目录里有「${classic.name}」预设：${classic.roles.join(' / ')}`);
else fail('没有三人经典预设');
if ((catalog.roles || []).some((r) => r.id === 'blindop')) ok('角色列表里有「盲操猴」');
else fail('角色列表里没有盲操猴');

const host = await api('/api/create', { name: '甲', difficulty: 'normal' });
const room = host.roomCode;
const b = await api('/api/join', { room, name: '乙', role: 'deafsee' });
const c = await api('/api/join', { room, name: '丙', role: 'muteexp' });

// 房主自己还没选角色（默认专家）—— 先用他试一下"动手座位唯一"
const dup = await api('/api/join', { room, name: '丁' }).then((r) => r.role).catch((e) => `ERR:${e.message}`);
if (dup !== 'blindop') ok('没有抢先占动手座位（新玩家拿到的是专家位）');
else fail('动手座位被重复占用');

// 一键套用预设：把三个角色按顺序分给三个人
const presetRes = await api('/api/action', { room, playerId: host.playerId, type: 'preset', preset: 'classic3' });
if (presetRes.preset?.id === 'classic3') ok('房主可以一键套用「三人经典」预设');
else fail(`套用预设失败：${JSON.stringify(presetRes)}`);
const roomAfter = await state(room, host.playerId);
const seats = roomAfter.room.players.filter((p) => p.role && p.role !== 'expert');
if (seats.length === 3) ok(`三个人各就各位：${roomAfter.room.players.map((p) => `${p.name}=${p.role}`).join(' ')}`);
else fail(`预设后的角色不对：${roomAfter.room.players.map((p) => `${p.name}=${p.role}`).join(' ')}`);
const presetNonHost = await api('/api/action', { room, playerId: b.playerId, type: 'preset', preset: 'duo' })
  .then(() => null).catch((e) => e.message);
if (presetNonHost) ok(`非房主不能改预设：${presetNonHost}`);
else fail('非房主也能套用预设');

// ---------------------------------------------------------------- 视野差异
console.log('\n— 三种角色看到/能做什么 —');
await api('/api/action', { room, playerId: host.playerId, type: 'start' });
const va = await state(room, host.playerId);   // 盲操猴
const vb = await state(room, b.playerId);       // 聋桥猴
const vc = await state(room, c.playerId);       // 哑手册猴
if (va.you.role !== 'blindop') fail(`预设没有把房主变成盲操猴（实际 ${va.you.role}）`);

if (va.you.vision === 'blind') ok(`盲操猴：vision=blind（客户端会把画面变成白色轮廓）`);
else fail(`盲操猴的 vision 不对：${va.you.vision}`);
if (va.canInteract && !va.manual && va.bomb.moduleStates[0].state) ok('盲操猴：能操作、有模块轮廓数据、没有手册');
else fail('盲操猴的权限不对');
if (!va.you.roleInfo.canSeeTime) ok('盲操猴看不到倒计时（要队友喊还剩多久）');
else fail('盲操猴不该看到精确倒计时');

if (vb.you.vision === 'full' && vb.bomb.moduleStates[0].state && !vb.canInteract) ok('聋桥猴：能看清炸弹颜色数字、不能操作');
else fail('聋桥猴的权限不对');
if (vb.you.roleInfo.canSeeTime) ok('聋桥猴看得到倒计时（可以替盲操猴报时）');
else fail('聋桥猴应该看得到倒计时');
if (vb.you.roleInfo.canSpeak !== false) ok('聋桥猴可以说话（他是转述的那一环）');
else fail('聋桥猴不该被限制发言');

if (vc.manual && !vc.bomb.moduleStates[0].state) ok('哑手册猴：有手册、看不到模块内部状态');
else fail('哑手册猴的权限不对');
if (vc.you.roleInfo.canSpeak === false) ok('哑手册猴不能说话');
else fail('哑手册猴应该不能说话');
if (vc.you.roleInfo.canManual) ok('哑手册猴有手册');
else fail('哑手册猴没有手册');

// ------------------------------------------------------------ 手势 / 信号
console.log('\n— 手势 / 信号（中间商式沟通的关键）—');
await api('/api/action', { room, playerId: c.playerId, type: 'signal', signal: '1' });
await api('/api/action', { room, playerId: c.playerId, type: 'signal', signal: '🔴 红' });
const vb2 = await state(room, b.playerId);
if ((vb2.signals || []).length === 2) ok(`聋桥猴收到了 ${vb2.signals.length} 条信号：${vb2.signals.map((s) => s.kind).join(' ')}`);
else fail(`聋桥猴没有收到信号：${JSON.stringify(vb2.signals)}`);
if (vb2.signals.some((s) => s.name === '丙')) ok('信号带发送者名字（知道是谁在比划）');
else fail('信号没有发送者信息');
const va2 = await state(room, host.playerId);
if ((va2.signals || []).length === 0) ok('盲操猴看不到信号（他"看不见"，只能靠喊）');
else fail('盲操猴不该收到信号');
const vc2 = await state(room, c.playerId);
if ((vc2.signals || []).length === 2) ok('哑手册猴自己也能看到信号（确认对方收到没）');
else fail('哑手册猴看不到自己发的信号');

// 空信号要拒绝
const emptySignal = await api('/api/action', { room, playerId: c.playerId, type: 'signal', signal: '' })
  .then(() => null).catch((e) => e.message);
if (emptySignal) ok(`空信号被拒绝：${emptySignal}`);
else fail('空信号被接受了');

// -------------------------------------------------- 盲操猴仍然能真的操作
console.log('\n— 盲操猴虽然"看不见"，但操作是有效的 —');
const defMod = va.bomb.moduleStates.find((m) => m.status !== 'solved');
const oracle = await api('/api/action', { room, playerId: host.playerId, type: 'module', uid: defMod.uid, action: { type: 'oracle' } });
let solvedOne = false;
if (oracle.moduleId === 'wires') {
  const r = await api('/api/action', { room, playerId: host.playerId, type: 'module', uid: defMod.uid, action: { type: 'cut', index: oracle.oracle.target } });
  solvedOne = !!r.solved;
} else if (oracle.moduleId === 'wires2') {
  const r = await api('/api/action', { room, playerId: host.playerId, type: 'module', uid: defMod.uid, action: { type: 'cut', index: oracle.oracle.cutIndex } });
  solvedOne = !!r.solved;
} else if (oracle.moduleId === 'quiz') {
  const r = await api('/api/action', { room, playerId: host.playerId, type: 'module', uid: defMod.uid, action: { type: 'choose', index: oracle.oracle.index } });
  solvedOne = !!r.solved;
} else if (oracle.moduleId === 'capacitor') {
  const r = await api('/api/action', { room, playerId: host.playerId, type: 'module', uid: defMod.uid, action: { type: 'pull', t: oracle.oracle.trigger } });
  solvedOne = !!r.solved;
} else if (oracle.moduleId === 'password') {
  const r = await api('/api/action', { room, playerId: host.playerId, type: 'module', uid: defMod.uid, action: { type: 'submit' } });
  solvedOne = !!r.strike || !!r.solved; // 至少证明操作被受理
} else if (oracle.moduleId === 'maze') {
  const r = await api('/api/action', { room, playerId: host.playerId, type: 'module', uid: defMod.uid, action: { type: 'move', dir: 'up' } });
  solvedOne = !!(r.note || r.strike || r.solved);
} else {
  // 其他模块：证明"操作被受理"即可（不是被权限拒绝）
  const r = await api('/api/action', { room, playerId: host.playerId, type: 'module', uid: defMod.uid, action: { type: 'tap', pos: 1 } });
  solvedOne = !r.error || r.error !== '盲操猴 不能操作炸弹';
}
if (solvedOne) ok(`盲操猴的操作真的生效（${oracle.moduleId}）`);
else fail(`盲操猴的操作没有生效（${oracle.moduleId}）`);

// 聋桥猴不能操作
const denyB = await api('/api/action', { room, playerId: b.playerId, type: 'module', uid: defMod.uid, action: { type: 'tap' } })
  .then(() => null).catch((e) => e.message);
if (denyB) ok(`聋桥猴不能操作：${denyB}`);
else fail('聋桥猴竟然能操作');

// ---------------------------------------------------------------- 回归：只有 3 个人也要能开局
// （之前 start() 只把 defuser/mute 当操作者、"需要专家"只认 expert/expert2/expert3，
//   于是三人经典必定报"需要拆弹者/专家"，只有多一个专家才侥幸能开）
console.log('\n— 回归：刚好 3 人的三人经典能开局 —');
{
  const h = await api('/api/create', { name: '三甲', difficulty: 'normal' });
  const r = h.roomCode;
  const p2 = await api('/api/join', { room: r, name: '三乙' });
  const p3 = await api('/api/join', { room: r, name: '三丙' });
  await api('/api/action', { room: r, playerId: h.playerId, type: 'preset', preset: 'classic3' });
  const before = await state(r, h.playerId);
  const roles = before.room.players.map((p) => p.role).sort();
  if (roles.join(',') === 'blindop,deafsee,muteexp') ok(`3 人各就各位：${roles.join(',')}`);
  else fail(`3 人预设角色不对：${roles.join(',')}`);

  const err = await api('/api/action', { room: r, playerId: h.playerId, type: 'start' })
    .then(() => null)
    .catch((e) => e.message);
  if (!err) ok('3 人的三人经典能正常开局（不再要求一个"专家"）');
  else fail(`3 人开局失败：${err}`);

  const after = await state(r, p3.playerId);
  if (after.room.phase === 'playing') ok('开局后阶段 = playing');
  else fail(`开局后阶段不对：${after.room.phase}`);
  if (after.manual && after.manual.sections?.length) ok('哑手册猴拿到了手册（canManual 角色）');
  else fail('哑手册猴没拿到手册');
  const blindView = await state(r, h.playerId);
  if (!blindView.manual) ok('盲操猴没有手册（信息隔离仍然有效）');
  else fail('盲操猴竟然拿到手册');
}

console.log(`\n失败 ${failures} 项`);
// 明确设置退出码即可；不要用 process.exit()，在 Windows 上残留连接会触发 libuv 断言
process.exitCode = failures ? 1 : 0;

