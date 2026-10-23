// 手机适配的结构性检查（没有浏览器也能跑）。
//
//   node tests/mobile.mjs
//
// 布局是否"好看"没法用断言证明，但下面这些是**手机端最常见的坑**，
// 每一项都必须存在，否则就是回退了：
//   · 网格子项 min-width:0（不然长表格把整页撑宽）
//   · 游戏区在窄屏上把"炸弹/手册"提到最前，聊天垫底
//   · 输入框 16px（iOS 聚焦不会放大整页）
//   · 触屏 44px 点击高度 + touch-action
//   · 100dvh + 安全区（刘海机）
//   · 所有页面 viewport-fit=cover（env(safe-area-*) 才生效）
//   · PWA manifest 与图标存在
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let failures = 0;
const ok = (m) => console.log('  ✓ ' + m);
const fail = (m) => {
  failures++;
  console.log('  ✗ ' + m);
};
const need = (src, pattern, label) => {
  if (pattern.test(src)) ok(label);
  else fail(label);
};

const css = read('client/style.css');

console.log('— 手机断点与关键规则 —');
need(css, /@media\s*\(max-width:\s*760px\)/, '存在 max-width:760px 断点');
need(css, /\.lobby-grid\s*>\s*\*,\s*\.game-grid\s*>\s*\*[^{]*\{[^}]*min-width:\s*0/, '网格子项设了 min-width:0（防横向溢出）');
need(css, /#main-area\s*\{\s*order:\s*1/, '游戏区把炸弹/手册提到最前（#main-area order:1）');
need(css, /\.game-grid\s*>\s*aside\.chat-panel\s*\{\s*order:\s*3/, '聊天面板排到最后');
need(css, /\.modules\s*\{\s*grid-template-columns:\s*1fr/, '模块在手机上单列');
need(css, /input,\s*select,\s*textarea\s*\{[^}]*font-size:\s*16px/, '输入框 16px（iOS 不会自动放大）');
need(css, /button,\s*\.btn\s*\{\s*min-height:\s*44px/, '按钮触屏高度 44px');
need(css, /@media\s*\(pointer:\s*coarse\)[\s\S]{0,200}touch-action:\s*manipulation/, '触屏 touch-action:manipulation');
need(css, /100dvh/, '用 100dvh（移动浏览器地址栏收起时不会截断）');
need(css, /env\(safe-area-inset-bottom\)/, '底部安全区');
need(css, /main\.tutorial[^{]*\{[^}]*overflow-x:\s*auto/, '教程页表格可横向滚动');

console.log('\n— 花括号配平（CSS 没被截断）—');
{
  const open = (css.match(/{/g) || []).length;
  const close = (css.match(/}/g) || []).length;
  if (open === close && open > 300) ok(`{ ${open} } ${close} 配平`);
  else fail(`花括号不配平：{ ${open} } ${close}`);
}

console.log('\n— 各页面 viewport —');
for (const page of ['client/index.html', 'client/tutorial.html', 'client/admin.html', 'docs/index.html']) {
  const html = read(page);
  if (/name="viewport"[^>]*viewport-fit=cover/.test(html)) ok(`${page} 有 viewport-fit=cover`);
  else fail(`${page} 缺 viewport-fit=cover（env(safe-area-*) 会失效）`);
}

console.log('\n— PWA（"添加到主屏幕"）—');
{
  const html = read('client/index.html');
  need(html, /rel="manifest"/, 'index.html 引用了 manifest');
  need(html, /apple-touch-icon/, '有 apple-touch-icon（iOS 主屏图标）');
  const mf = JSON.parse(read('client/manifest.webmanifest'));
  if (mf.display === 'standalone') ok('manifest display=standalone（独立窗口）');
  else fail(`manifest display 应该是 standalone，实际 ${mf.display}`);
  for (const icon of mf.icons || []) {
    const rel = icon.src.replace(/^\/static\//, 'client/');
    if (fs.existsSync(path.join(ROOT, rel))) ok(`图标存在：${icon.src} (${icon.sizes})`);
    else fail(`图标缺失：${icon.src}`);
  }
}

console.log(`\n失败 ${failures} 项`);
process.exitCode = failures ? 1 : 0;
