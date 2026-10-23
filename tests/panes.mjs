// 分块布局（docs/ui-design.md）的单元 + 结构测试。
//
//   node tests/panes.mjs
//
// 纯逻辑部分直接 import client/panes.js；DOM 部分只做结构性断言
// （各块 data-pane 齐不齐、每个 stage 有没有标签栏容器）。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const P = await import(pathToFileURL(path.join(ROOT, 'client', 'panes.js')).href);
const html = fs.readFileSync(path.join(ROOT, 'client', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'client', 'style.css'), 'utf8');
const appjs = fs.readFileSync(path.join(ROOT, 'client', 'app.js'), 'utf8');

let failures = 0;
const ok = (m) => console.log('  ✓ ' + m);
const fail = (m) => {
  failures++;
  console.log('  ✗ ' + m);
};

console.log('— 角色 → 主区标题 —');
for (const [role, label] of [
  ['defuser', '炸弹'],
  ['mute', '炸弹'],
  ['deafsee', '炸弹'],
  ['blindop', '轮廓'],
  ['expert', '手册'],
  ['blind', '手册'],
  ['muteexp', '手册'],
  ['expert2', '手册'],
]) {
  const got = P.mainTitleForRole(role).label;
  if (got === label) ok(`${role} → ${label}`);
  else fail(`${role} 主区标题应为 ${label}，实际 ${got}`);
}

console.log('\n— 标签顺序（按角色最缺的情报排）—');
{
  const keys = (r) => P.panesForRole(r).map((p) => p.key);
  const def = keys('defuser');
  if (def[0] === 'main' && def.length === 4) ok(`拆弹者：${def.join(' → ')}`);
  else fail(`拆弹者的块不对：${def.join(',')}`);
  const deaf = keys('deafsee');
  if (deaf[1] === 'signals') ok(`聋桥猴信号靠前：${deaf.join(' → ')}`);
  else fail(`聋桥猴的块顺序不对：${deaf.join(',')}`);
  const mute = keys('mute');
  if (mute[1] === 'chat') ok(`静默操作员聊天靠前：${mute.join(' → ')}`);
  else fail(`静默操作员的块顺序不对：${mute.join(',')}`);
  if (P.defaultPaneForRole() === 'main') ok('默认停在主区');
  else fail('默认块不是主区');
  if (P.defaultLobbyPane() === 'roles') ok('大厅默认停在「角色」');
  else fail('大厅默认块不是 roles');
}

console.log('\n— 动手座位判定（大厅"开始"按钮的门槛）—');
{
  const ops = ['defuser', 'mute', 'blindop'];
  let bad = 0;
  for (const r of ops) {
    if (!P.isOperatorRole(r)) {
      bad++;
      console.log(`     ${r} 应该算动手角色`);
    }
  }
  if (!bad) ok(`动手角色齐了：${ops.join(' / ')}`);
  else fail('动手角色判定有误');

  for (const r of ['deafsee', 'expert', 'blind', 'muteexp', 'expert2']) {
    if (P.isOperatorRole(r)) fail(`${r} 不该算动手角色（否则大厅会误放行）`);
  }
  ok('聋桥猴 / 专家 / 盲眼 / 哑手册猴 都不算动手角色');

  if (P.isManualRole('muteexp') && P.isManualRole('expert') && !P.isManualRole('blindop')) {
    ok('手册角色判定正确（哑手册猴有手册，盲操猴没有）');
  } else {
    fail('手册角色判定不对');
  }

  // 三人经典：盲操猴动手 + 哑手册猴读手册 → 大厅必须允许开始
  const players = [{ role: 'blindop' }, { role: 'deafsee' }, { role: 'muteexp' }];
  const hasOp = players.some((p) => P.isOperatorRole(p.role));
  const hasManual = players.some((p) => p.role && !P.isOperatorRole(p.role));
  if (hasOp && hasManual) ok('三人经典（正好 3 人）满足开局条件，不会再报"需要拆弹者"');
  else fail('三人经典仍然不满足开局条件');
}

console.log('\n— 断点 —');
{
  const cases = [
    [375, 'phone'],
    [639, 'phone'],
    [640, 'tablet'],
    [900, 'tablet'],
    [1023, 'tablet'],
    [1024, 'desktop'],
    [1600, 'desktop'],
  ];
  let bad = 0;
  for (const [w, want] of cases) {
    if (P.layoutForWidth(w) !== want) {
      bad++;
      console.log(`     ${w}px 期望 ${want}，实际 ${P.layoutForWidth(w)}`);
    }
  }
  if (!bad) ok('断点正确：<640 单块 / 640~1023 两块 / ≥1024 多块');
  else fail(`${bad} 个断点不对`);
  if (P.paneByIndex(P.panesForRole('expert'), 2) === 'status') ok('专注模式下数字键 2 → 第 2 块');
  else fail('数字键映射不对');
}

console.log('\n— DOM 结构 —');
{
  const gamePanes = ['status', 'main', 'signals', 'chat'];
  let missing = 0;
  for (const k of gamePanes) {
    if (!new RegExp('data-pane="' + k + '"').test(html)) {
      missing++;
      console.log(`     缺少 data-pane="${k}"`);
    }
  }
  if (!missing) ok('游戏区四块都在（状态 / 主区 / 信号 / 聊天）');
  else fail(`游戏区缺 ${missing} 块`);

  const lobbyPanes = ['players', 'roles', 'settings', 'chat'];
  let lm = 0;
  for (const k of lobbyPanes) {
    if (!new RegExp('data-pane="' + k + '"').test(html)) {
      lm++;
      console.log(`     缺少大厅 data-pane="${k}"`);
    }
  }
  if (!lm) ok('大厅四块都在（玩家 / 角色 / 设置 / 聊天）');
  else fail(`大厅缺 ${lm} 块`);

  for (const stage of ['stage-game', 'stage-lobby']) {
    if (new RegExp('data-tabs="' + stage + '"').test(html)) ok(`${stage} 有标签栏容器`);
    else fail(`${stage} 没有标签栏容器`);
  }
  if (/id="mini-hud"/.test(html)) ok('有迷你状态条容器');
  else fail('缺少迷你状态条');
  if (/id="btn-focus"/.test(html)) ok('有桌面「专注」开关');
  else fail('缺少专注开关');
}

console.log('\n— 接线 —');
{
  if (/bindPanes\(\);/.test(appjs)) ok('app.js 启动了分块控制器');
  else fail('app.js 没调用 bindPanes()');
  if (/renderMiniHud\(\);/.test(appjs)) ok('渲染时更新迷你状态条');
  else fail('没调用 renderMiniHud()');
  if (/mountPanes\(\);/.test(appjs)) ok('切换阶段时会重挂标签（角色变了标签也跟着变）');
  else fail('没调用 mountPanes()');
}

console.log('\n— 样式 —');
{
  const rules = [
    [/\.pane-tabs/, '标签栏样式'],
    [/grid-template-areas:\s*"status main chat"/, '桌面四块的网格区域'],
    [/\.stage\.single \[data-pane\]\s*\{\s*display:\s*none/, '单块模式隐藏其它块'],
    [/\.stage\.twopane/, '平板两块模式'],
    [/\.mini-hud/, '迷你状态条样式'],
  ];
  for (const [re, label] of rules) {
    if (re.test(css)) ok(label);
    else fail(`缺少${label}`);
  }
  const open = (css.match(/{/g) || []).length;
  const close = (css.match(/}/g) || []).length;
  if (open === close) ok(`CSS 花括号配平（${open}）`);
  else fail('CSS 花括号不配平');
}

console.log(`\n失败 ${failures} 项`);
process.exitCode = failures ? 1 : 0;
