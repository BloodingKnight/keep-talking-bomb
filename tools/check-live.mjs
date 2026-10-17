// 线上自检：确认"出题与视角"合并页与盲操剪影都已部署。
const B = process.argv[2] || 'http://127.0.0.1:3210';
const T = process.argv[3] || '';

const html = await fetch(B + '/admin').then((r) => r.text());
const js = await fetch(B + '/static/admin.js').then((r) => r.text());
const bomb = await fetch(B + '/static/bomb.js').then((r) => r.text());
const css = await fetch(B + '/static/style.css').then((r) => r.text());
const catalog = await fetch(B + '/api/rooms').then((r) => r.json());

let bad = 0;
const t = (label, cond) => { console.log(`${cond ? '  ✓' : '  ✗'} ${label}`); if (!cond) bad++; };

console.log('— 管理页已合并为「出题与视角」—');
t('标签页合并（没有单独的"角色视角"标签）', html.includes('data-tab="question"') && !html.includes('data-tab="roles"'));
t('题目来源可选（单个模块 / 整颗炸弹）', html.includes('id="q-source"'));
t('视角多选条', html.includes('id="view-picker"'));
t('模块/等级/难度/模块数选择器齐全',
  html.includes('id="bench-module"') && html.includes('id="bench-tier"') &&
  html.includes('id="role-difficulty"') && html.includes('id="role-count"'));

console.log('\n— 视角逻辑 —');
t('默认视角 = 操作者 + 专家', js.includes("viewPick: ['operator', 'expert']"));
t('可以自由加/减视角', js.includes('function toggleView'));
t('有「全选」和「只留操作者+专家」', js.includes('全选') && js.includes('只留操作者+专家'));
t('三个"三不猴"角色都在可选项里', js.includes('blindop') && js.includes('deafsee') && js.includes('muteexp'));
t('旧的两个函数已移除', !js.includes('function renderBench') && !js.includes('async function loadRolePreview'));

console.log('\n— 盲操猴剪影 —');
t('整屏走独立渲染（renderBlindBomb）', bomb.includes('renderBlindBomb'));
t('单模块也能画剪影（renderBlindModule）', bomb.includes('renderBlindModule'));
t('剪影形状由 blindSilhouette 生成', bomb.includes('blindSilhouette'));
t('剪影上绑了点击（bindBlindActions）', bomb.includes('bindBlindActions'));
t('点击有白色高亮反馈', css.includes('.clickable.hit'));

console.log('\n— 会话目录 —');
t(`角色 ${catalog.roles.length} 个（含三个"三不猴"）`,
  ['blindop', 'deafsee', 'muteexp'].every((k) => catalog.roles.some((r) => r.id === k)));
t(`角色预设 ${catalog.presets.length} 个`, catalog.presets.length >= 4);

console.log(`\n${bad ? `有 ${bad} 项不合格` : '全部通过'}`);
process.exitCode = bad ? 1 : 0;
