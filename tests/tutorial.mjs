// 教程页 + 管理端"角色自选"的测试。
//
//   node server/server.js 3388 --test
//   node tests\tutorial.mjs http://127.0.0.1:3388 [adminToken]

const BASE = process.argv[2] || 'http://127.0.0.1:3388';
const TOKEN = process.argv[3] || '';

let failures = 0;
const fail = (m) => { failures++; console.error('  ✗ ' + m); };
const ok = (m) => console.log('  ✓ ' + m);

console.log(`教程与角色自选 @ ${BASE}\n`);

// ---------------------------------------------------------------- 教程页
console.log('— 教程页 —');
const res = await fetch(`${BASE}/tutorial`);
const html = await res.text();
if (res.status === 200) ok('/tutorial 可以打开');
else fail(`/tutorial 打不开（${res.status}）`);

const mustHave = [
  ['怎么开始', '有"怎么开始"章节'],
  ['拆弹者', '介绍了拆弹者'],
  ['专家', '介绍了专家'],
  ['盲眼观察员', '介绍了盲眼观察员'],
  ['静默操作员', '介绍了静默操作员'],
  ['盲操猴', '介绍了盲操猴（只有轮廓）'],
  ['聋桥猴', '介绍了聋桥猴（听不见）'],
  ['哑手册猴', '介绍了哑手册猴（不能说话）'],
  ['中间商式', '讲清了"中间商式"沟通链路'],
  ['模块验题', '指向了模块验题'],
  ['角色视角', '指向了角色视角'],
  ['序列号', '列了外壳信息（序列号）'],
];
for (const [needle, label] of mustHave) {
  if (html.includes(needle)) ok(label);
  else fail(`教程里缺少：${label}（没找到「${needle}」）`);
}
// 模块清单要覆盖到新模块
const modules = ['线缆', '复杂线路', '按钮', '符号键盘', '闪光序列', '双序列闪光', '记忆', '摩斯电报', '三色电报', '迷宫', '密码', '逻辑问答', '齿轮传动', '天平配重', '十进制解码', '电容放电', '保险柜旋钮', '字母键盘'];
const missing = modules.filter((m) => !html.includes(m));
if (!missing.length) ok(`18 个模块都在速查表里`);
else fail(`教程里缺少这些模块：${missing.join('、')}`);
// 教程里的角色数量声明
if (html.includes('9 个座位')) ok('标明了角色座位数（9 个）');
else fail('没有写明角色座位数');
// 教程不能泄漏答案表（它只是说明，不该内嵌真实规则表数据）
if (!/剪断第 \d+ 根/.test(html)) ok('教程里没有混入真实题目的答案');
else fail('教程里出现了具体题目答案（应该只是说明）');

// 首页要能点进教程
const home = await fetch(`${BASE}/`).then((r) => r.text());
if (home.includes('href="/tutorial"')) ok('玩家首页有教程入口链接');
else fail('玩家首页没有教程入口');

// ------------------------------------------------- 管理端角色自选
if (!TOKEN) {
  console.log('\n（没有给管理令牌，跳过角色视角部分）');
  console.log(`\n失败 ${failures} 项`);
  process.exitCode = failures ? 1 : 0;
} else {
  console.log('\n— 管理端：角色可以自己选 —');
  const admin = (path, body) => fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-token': TOKEN },
    body: JSON.stringify(body || {}),
  }).then((r) => r.json());
  const rp = (await admin('/api/admin/action', { type: 'rolePreview', difficulty: 'hard', moduleCount: 4 })).rolePreview;
  if (!rp) {
    fail('没有拿到角色视角数据');
  } else {
    const keys = rp.views.map((v) => v.key);
    const need = ['truth', 'defuser', 'expert', 'blind', 'mute', 'blindop', 'deafsee', 'muteexp', 'expert2'];
    const miss = need.filter((k) => !keys.includes(k));
    if (!miss.length) ok(`可切换的角色有 ${keys.length} 个：${keys.join(', ')}`);
    else fail(`缺少角色视角：${miss.join(', ')}`);

    // 三个"三不猴"角色的关键属性
    const byKey = Object.fromEntries(rp.views.map((v) => [v.key, v]));
    if (byKey.blindop.vision === 'blind' && byKey.blindop.canInteract) ok('盲操猴：只有轮廓（vision=blind）+ 能操作');
    else fail(`盲操猴视角不对：vision=${byKey.blindop.vision} canInteract=${byKey.blindop.canInteract}`);
    if (byKey.deafsee.vision === 'full' && byKey.deafsee.seesBomb && !byKey.deafsee.canInteract) ok('聋桥猴：看得见炸弹（完整画面）+ 不能操作');
    else fail('聋桥猴视角不对');
    if (byKey.muteexp.canManual && !byKey.muteexp.seesBomb) ok('哑手册猴：有手册、看不到炸弹');
    else fail('哑手册猴视角不对');
    if (byKey.blind.manual?.mode === 'partial' && byKey.expert2.manual?.mode === 'partial') ok('盲眼观察员 / 专家 II 各拿半本手册');
    else fail('半本手册分配不对');

    // 每个"能看炸弹"的角色都要有可渲染的模块状态
    for (const k of ['defuser', 'blindop', 'deafsee', 'mute']) {
      const v = byKey[k];
      if (v.seesBomb && v.moduleStates?.length && v.moduleStates[0].state) ok(`${v.roleName} 有可渲染的模块状态`);
      else fail(`${v.roleName} 缺少模块状态`);
    }
    // 每个"有手册"的角色都要有章节
    for (const k of ['expert', 'blind', 'muteexp', 'expert2']) {
      const v = byKey[k];
      if (v.manual?.sections?.length) ok(`${v.roleName} 有 ${v.manual.sections.length} 个手册章节`);
      else fail(`${v.roleName} 没有手册章节`);
    }
  }

  // 管理页面：出题与视角已合并成一个页面
  const adminHtml = await fetch(`${BASE}/admin`).then((r) => r.text());
  const adminJs = await fetch(`${BASE}/static/admin.js`).then((r) => r.text());
  if (adminHtml.includes('id="q-source"')) ok('出题页可以选题目来源（单个模块 / 整颗炸弹）');
  else fail('出题页没有题目来源选择');
  if (adminHtml.includes('id="view-picker"')) ok('出题页有视角多选容器');
  else fail('出题页没有视角选择器');
  if (!adminHtml.includes('data-tab="roles"') && adminHtml.includes('data-tab="question"')) ok('「模块验题」和「角色视角」已经合并成一个标签页');
  else fail('两个标签页还没有合并');
  if (adminJs.includes('function renderQuestion')) ok('合并后的统一渲染函数 renderQuestion 存在');
  else fail('缺少统一的 renderQuestion');
  if (adminJs.includes("viewPick: ['operator', 'expert']")) ok('默认视角是「操作者 + 专家」');
  else fail('默认视角不是操作者+专家');
  if (adminJs.includes('function toggleView')) ok('视角可以自由加/减');
  else fail('视角不能自由加减');
  if (adminJs.includes('blindop') && adminJs.includes('deafsee') && adminJs.includes('muteexp')) ok('三个"三不猴"角色都在可选视角里');
  else fail('缺少新角色的视角选项');
  if (adminJs.includes('renderBlindBomb') || (await fetch(`${BASE}/static/bomb.js`).then((r) => r.text())).includes('renderBlindBomb')) ok('盲操猴走独立的轮廓渲染路径');
  else fail('缺少盲操渲染路径');
}

console.log(`\n失败 ${failures} 项`);
process.exitCode = failures ? 1 : 0;
