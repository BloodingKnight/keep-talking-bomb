// 测试：聋桥猴能看到整颗炸弹 + 盲操猴的光标广播，以及 ROLE_HELP 不再缺失。
//
//   node server/server.js 3388 --test
//   node tests\deafsee.mjs http://127.0.0.1:3388 [adminToken]

const BASE = process.argv[2] || 'http://127.0.0.1:3388';
const TOKEN = process.argv[3] || '';
const N = 6;

let failures = 0;
const fail = (m) => { failures++; console.error('  ✗ ' + m); };
const ok = (m) => console.log('  ✓ ' + m);

async function playerApi(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${path} -> ${res.status}`);
  return data;
}
const state = async (room, playerId) => (await fetch(`${BASE}/api/state?room=${room}&player=${playerId}`).then((r) => r.json())).state;

console.log(`聋桥猴视野与光标 @ ${BASE}\n`);

// ------------------------------------------------------ 1) 三人局：光标广播
console.log('— 盲操猴的光标会被队友看到 —');
const host = await playerApi('/api/create', { name: '甲', difficulty: 'normal' });
const room = host.roomCode;
const blind = await playerApi('/api/join', { room, name: '盲操', role: 'blindop' });
const deaf = await playerApi('/api/join', { room, name: '聋桥', role: 'deafsee' });
const mute = await playerApi('/api/join', { room, name: '哑手册', role: 'muteexp' });
await playerApi('/api/action', { room, playerId: host.playerId, type: 'start' });

const s0 = await state(room, blind.playerId);
const firstMod = s0.bomb.moduleStates[0];
await playerApi('/api/action', {
  room, playerId: blind.playerId, type: 'cursor',
  uid: firstMod.uid, x: 0.42, y: 0.66,
});
const sDeaf = await state(room, deaf.playerId);
const c = sDeaf.teammateCursor;
if (c && Math.abs(c.x - 0.42) < 1e-6 && Math.abs(c.y - 0.66) < 1e-6) ok(`聋桥猴看到了光标位置 (${c.x}, ${c.y})`);
else fail(`聋桥猴没有收到光标：${JSON.stringify(c)}`);
if (c && c.uid === firstMod.uid) ok('光标带上了"在哪个模块上"');
else fail(`光标没有模块信息：${JSON.stringify(c)}`);
if (c && c.name === '盲操') ok('光标带上了操作者的名字');
else fail('光标没有操作者名字');

const sMute = await state(room, mute.playerId);
if (sMute.teammateCursor && sMute.teammateCursor.uid === firstMod.uid) ok('哑手册猴也能看到光标（他能打字指挥）');
else fail('哑手册猴看不到光标');

const sBlind = await state(room, blind.playerId);
if (!sBlind.teammateCursor) ok('盲操猴自己不会收到光标（他反正看不见）');
else fail('盲操猴不该收到光标数据');

// 坐标要被夹在 0~1
await playerApi('/api/action', { room, playerId: blind.playerId, type: 'cursor', uid: firstMod.uid, x: 9, y: -3 });
const sClamp = await state(room, deaf.playerId);
if (sClamp.teammateCursor.x === 1 && sClamp.teammateCursor.y === 0) ok('越界坐标会被夹到 0~1');
else fail(`坐标没有夹紧：${JSON.stringify(sClamp.teammateCursor)}`);

// --------------------------------------------------- 2) 聋桥猴看得到炸弹
console.log('\n— 聋桥猴看到的是完整炸弹 —');
if (sDeaf.you.vision === 'full') ok('聋桥猴 vision = full（不是轮廓）');
else fail(`聋桥猴 vision 不对：${sDeaf.you.vision}`);
if (sDeaf.bomb.moduleStates.every((m) => m.state)) ok(`聋桥猴能看到全部 ${sDeaf.bomb.moduleStates.length} 个模块的完整状态`);
else fail('聋桥猴看不到模块状态');
if (sDeaf.you.roleInfo.canSeeTime) ok('聋桥猴看得到倒计时（要给盲操猴报时）');
else fail('聋桥猴看不到倒计时');
if (!sDeaf.canInteract) ok('聋桥猴不能操作（他只负责转述）');
else fail('聋桥猴不该能操作');

// 盲操猴那边：同一次状态里应该是"轮廓"模式
const blindState = await state(room, blind.playerId);
if (blindState.you.vision === 'blind' && blindState.bomb.moduleStates[0].state) ok('盲操猴同一时刻拿到的是"轮廓"模式的数据（能操作）');
else fail('盲操猴的视图不对');

// ------------------------------------------- 3) 管理端：整颗炸弹 + 无 ROLE_HELP 报错
if (!TOKEN) {
  console.log('\n（没有给管理令牌，跳过管理端部分）');
} else {
  console.log('\n— 管理端"整颗炸弹"视角 —');
  const adminHtml = await fetch(`${BASE}/admin`).then((r) => r.text());
  const adminJs = await fetch(`${BASE}/static/admin.js`).then((r) => r.text());
  if (adminJs.includes('const ROLE_HELP = {')) ok('ROLE_HELP 常量已经补回来了（不会再报 is not defined）');
  else fail('ROLE_HELP 仍然缺失');
  if (adminJs.includes('const wholeBomb = v.key === \'deafsee\'')) ok('聋桥猴那一栏会渲染整颗炸弹');
  else fail('聋桥猴没有走"整颗炸弹"分支');
  if (adminJs.includes('cursorDot') && adminJs.includes('teammateCursor')) ok('管理端会画队友光标并把 state 传进去');
  else fail('管理端没有光标渲染逻辑');

  const rp = await fetch(BASE + '/api/admin/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-token': TOKEN },
    body: JSON.stringify({ type: 'rolePreview', difficulty: 'normal', moduleCount: 4 }),
  }).then((r) => r.json());
  const views = rp.rolePreview?.views || [];
  const deafView = views.find((v) => v.key === 'deafsee');
  if (deafView && deafView.moduleStates.length === rp.rolePreview.modules.length) ok(`聋桥猴视角拿到全部 ${deafView.moduleStates.length} 个模块（可以整块渲染）`);
  else fail('聋桥猴视角拿不到全部模块');
  // 角色视角里的盲操猴也要能看到自己的轮廓数据
  const bo = views.find((v) => v.key === 'blindop');
  if (bo && bo.vision === 'blind') ok('盲操猴视角在管理端标记为轮廓模式');
  else fail('盲操猴视角没有 vision 标记');
}

console.log(`\n失败 ${failures} 项`);
process.exitCode = failures ? 1 : 0;
