// Tests for the /admin management entry: token gate, module bench over HTTP,
// all-module self-check report, room monitoring and admin room actions.
//
//   node server/server.js 3388 --test            # 读启动日志里的令牌
//   BOMB_ADMIN_TOKEN=secret node server/server.js 3388 --test
//   node tests/admin.mjs http://127.0.0.1:3388 secret

const BASE = process.argv[2] || 'http://127.0.0.1:3388';
const TOKEN = process.argv[3] || process.env.BOMB_ADMIN_TOKEN || '';

let failures = 0;
const fail = (m) => { failures++; console.error('  ✗ ' + m); };
const ok = (m) => console.log('  ✓ ' + m);

async function req(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { 'x-admin-token': token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}
const admin = (path, body) => req(path, { method: 'POST', token: TOKEN, body });

async function playerApi(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${path} -> ${res.status}`);
  return data;
}

console.log(`管理入口 @ ${BASE}\n`);
if (!TOKEN) {
  console.error('需要管理令牌：node tests/admin.mjs <baseUrl> <token>（令牌在服务器启动日志里）');
  process.exit(2);
}

// ------------------------------------------------------------ 1) 令牌门禁
console.log('— 令牌门禁 —');
const noToken = await req('/api/admin/state');
if (noToken.status === 401) ok('不带令牌访问管理 API 被拒绝（401）');
else fail(`不带令牌竟然可以访问（${noToken.status}）`);
const badToken = await req('/api/admin/state', { token: 'wrong-token' });
if (badToken.status === 401) ok('错误令牌被拒绝（401）');
else fail(`错误令牌竟然可以访问（${badToken.status}）`);
const good = await req('/api/admin/state', { token: TOKEN });
if (good.status === 200 && good.data.ok) ok('正确令牌可以读取管理状态');
else fail(`正确令牌无法访问（${good.status} ${JSON.stringify(good.data)}）`);
const badAction = await req('/api/admin/action', { method: 'POST', token: 'nope', body: { type: 'preview' } });
if (badAction.status === 401) ok('错误令牌不能调用管理动作');
else fail('错误令牌可以调用管理动作');

// 管理页面本身是静态页（需要令牌才能用）
const page = await fetch(BASE + '/admin');
const html = await page.text();
if (page.status === 200 && html.includes('管理入口')) ok('/admin 能打开管理页面');
else fail(`/admin 打不开（${page.status}）`);

// ------------------------------------------------------- 2) 验题台（全部模块）
console.log('\n— 模块验题台 —');
const modules = good.data.modules.map((m) => m.id);
if (modules.length >= 13) ok(`管理端给出 ${modules.length} 个模块`);
else fail(`模块列表不完整：${modules.length}`);
let checked = 0;
const problems = [];
for (const id of modules) {
  for (const tier of [1, 2, 3, 4, 5]) {
    const r = await admin('/api/admin/action', { type: 'preview', module: id, tier });
    const pv = r.data.preview;
    if (!pv) { problems.push(`${id}/${tier}: 没有 preview`); continue; }
    if (!pv.state?.state) problems.push(`${id}/${tier}: 缺题目`);
    if (!pv.manual?.sections?.[0]?.groups?.length) problems.push(`${id}/${tier}: 缺手册`);
    if (pv.tier !== tier) problems.push(`${id}/${tier}: 等级错`);
    checked++;
  }
}
if (!problems.length) ok(`${modules.length} 模块 × 5 等级 = ${checked} 道题都能生成题目 + 手册`);
else fail(`有问题的题目：${problems.slice(0, 5).join('；')}`);

// 在管理端直接做题：线缆
const wirePv = (await admin('/api/admin/action', { type: 'preview', module: 'wires', tier: 3 })).data.preview;
const rows = wirePv.manual.sections[0].groups.filter((g) => g.kind === 'table').flatMap((g) => g.rows || []);
const wantIdx = Number(/剪断第 (\d+) 根线/.exec(rows[rows.length - 1].action)[1]) - 1;
const solved = await admin('/api/admin/action', {
  type: 'previewAction', uid: wirePv.state.uid, action: { type: 'cut', index: wantIdx },
});
if (solved.data.previewResult?.solved) ok(`在管理端按手册操作可以解题（剪第 ${wantIdx + 1} 根 → 正确）`);
else fail(`管理端做题没有被判定正确：${JSON.stringify(solved.data)}`);
const wrong = await admin('/api/admin/action', {
  type: 'previewAction', uid: wirePv.state.uid, action: { type: 'cut', index: (wantIdx + 1) % 3 },
});
if (wrong.data.previewResult?.solved || wrong.data.previewResult?.note?.includes('已经做对')) ok('同一道题做对后再操作会提示已完成');
else fail('做对后的状态不对');

// 另一道题故意做错
const wirePv2 = (await admin('/api/admin/action', { type: 'preview', module: 'wires', tier: 1 })).data.preview;
const rows2 = wirePv2.manual.sections[0].groups.filter((g) => g.kind === 'table').flatMap((g) => g.rows || []);
const want2 = Number(/剪断第 (\d+) 根线/.exec(rows2[rows2.length - 1].action)[1]) - 1;
const other = wirePv2.state.state.wires.find((w) => w.i !== want2)?.i ?? 0;
const strike = await admin('/api/admin/action', {
  type: 'previewAction', uid: wirePv2.state.uid, action: { type: 'cut', index: other },
});
if (strike.data.previewResult?.strike) ok(`故意做错会报失误：${strike.data.previewResult.note}`);
else fail('故意做错没有报失误');

// -------------------------------------------------------------- 3) 全量自检
console.log('\n— 一键全量自检 —');
const check = await admin('/api/admin/action', { type: 'selfCheck' });
const rep = check.data.report;
if (rep && rep.checked === modules.length * 5 && rep.problems.length === 0) {
  ok(`自检通过：${rep.ok}/${rep.checked} 道题（题目、手册、空表格、迷宫墙、键盘唯一解）`);
} else if (rep) {
  fail(`自检发现问题：${JSON.stringify(rep.problems.slice(0, 3))}`);
} else {
  fail('自检没有返回报告');
}

// ---------------------------------------------------------- 3.5) 角色视角预览
console.log('\n— 角色视角预览（每个角色能看到什么）—');
const rolePv = await admin('/api/admin/action', { type: 'rolePreview', difficulty: 'hard', moduleCount: 4 });
const rp = rolePv.data.rolePreview;
if (!rp || !rp.views?.length) {
  fail('没有返回角色视角');
} else {
  const byKey = Object.fromEntries(rp.views.map((v) => [v.key, v]));
  const expect = ['truth', 'defuser', 'expert', 'blind', 'mute', 'expert2'];
  if (expect.every((k) => byKey[k])) ok(`返回了 ${rp.views.length} 个视角：${expect.join(' / ')}`);
  else fail(`缺视角：${expect.filter((k) => !byKey[k]).join(',')}`);

  const bombView = (v) => (v.moduleStates || []).filter((m) => m.state).length;
  if (!byKey.defuser.manual && bombView(byKey.defuser) > 0) ok('拆弹者：有炸弹状态、没有手册');
  else fail('拆弹者视角不对');
  if (byKey.expert.manual && bombView(byKey.expert) === 0) ok('专家：有手册、没有模块内部状态');
  else fail('专家视角不对');
  if (byKey.blind.manual?.mode === 'partial') ok(`盲眼观察员：半本手册（座位 ${byKey.blind.seat}，${byKey.blind.manual.sections.flatMap((s) => s.groups.flatMap((g) => g.rows || [])).length} 条）`);
  else fail(`盲眼观察员的手册模式不对：${byKey.blind.manual?.mode}`);
  if (byKey.expert2.manual?.mode === 'partial') ok('专家 II：拿到另一半手册');
  else fail(`专家 II 的手册模式不对：${byKey.expert2.manual?.mode}`);
  if (byKey.mute.canInteract && !byKey.mute.manual && bombView(byKey.mute) > 0) ok('静默操作员：能看炸弹、能操作、没有手册');
  else fail('静默操作员视角不对');

  // 两个专家座位的条目应该互补（有重合但不是包含关系）
  const rowsOf = (m) => m.sections.flatMap((s) => s.groups.flatMap((g) => (g.rows || []).map((r) => `${s.uid}|${r.label}`)));
  const a = rowsOf(byKey.blind.manual), b = rowsOf(byKey.expert2.manual);
  if (a.length && b.length && JSON.stringify(a) !== JSON.stringify(b)) ok(`半本手册互补：座位0 ${a.length} 条 / 座位1 ${b.length} 条`);
  else fail('两半手册没有差异');
  if (!JSON.stringify(rp).includes('"solution"')) ok('角色视角里没有泄漏 solution 字段');
  else fail('角色视角泄漏了 solution');
}

// ------------------------------------------------------------ 4) 房间监控
console.log('\n— 房间监控与管理动作 —');
const host = await playerApi('/api/create', { name: '房主', difficulty: 'easy' });
const room = host.roomCode;
const guest = await playerApi('/api/join', { room, name: '客人', role: 'expert' });
const snap = await req('/api/admin/state', { token: TOKEN });
const listed = snap.data.rooms.find((r) => r.code === room);
if (listed && listed.players.length === 2) ok(`管理端能看到房间 ${room} 和里面的 ${listed.players.length} 名玩家`);
else fail(`管理端看不到房间信息：${JSON.stringify(listed)}`);
if (listed.players.every((p) => 'role' in p && 'connected' in p)) ok('房间快照包含角色与在线状态');
else fail('房间快照缺字段');

// 管理端踢人
const kicked = await admin('/api/admin/action', { type: 'kickPlayer', room, playerId: guest.playerId });
const afterKick = await req('/api/admin/state', { token: TOKEN });
const roomAfter = afterKick.data.rooms.find((r) => r.code === room);
if (kicked.status === 200 && roomAfter.players.length === 1) ok('管理端可以把玩家移出房间');
else fail(`管理端踢人失败：${JSON.stringify(kicked.data)}`);

// 管理端把倒计时压短（另开一个"拆弹者 + 专家"的房间，方便开始游戏）
const host2 = await playerApi('/api/create', { name: '房主2', difficulty: 'easy' });
const room2 = host2.roomCode;
const d2 = await playerApi('/api/join', { room: room2, name: '拆弹者', role: 'defuser' });
await playerApi('/api/join', { room: room2, name: '专家', role: 'expert' });
await playerApi('/api/action', { room: room2, playerId: host2.playerId, type: 'start' });
const setTime = await admin('/api/admin/action', { type: 'setTime', room: room2, ms: 1200 });
if (setTime.status === 200) {
  await new Promise((r) => setTimeout(r, 2400));
  const state = await fetch(`${BASE}/api/state?room=${room2}&player=${d2.playerId}`).then((r) => r.json());
  if (state.state.status === 'timeout') ok('管理端把倒计时压短后，房间按超时结束');
  else fail(`压短倒计时后状态不对：${state.state.status}`);
} else fail(`设置倒计时失败：${JSON.stringify(setTime.data)}`);

// 管理端关闭房间
const close1 = await admin('/api/admin/action', { type: 'closeRoom', room: room2 });
const afterClose = await req('/api/admin/state', { token: TOKEN });
if (close1.status === 200 && !afterClose.data.rooms.some((r) => r.code === room2)) ok('管理端可以关闭房间');
else fail('管理端关房间失败');

// 未知动作要报错
const unknown = await admin('/api/admin/action', { type: 'nope' });
if (unknown.status >= 400) ok('未知管理动作返回错误');
else fail('未知管理动作没报错');

console.log(`\n失败 ${failures} 项`);
process.exit(failures ? 1 : 0);
