// 用 DOM 桩渲染"盲操猴"看到的每个模块，把仍然"看得见"的文字/数字列出来。
// 目的是验证：盲操猴的屏幕上不应该有颜色、数字、文字，只留可点的形状。
let failures = 0;
const fail = (m) => { failures++; console.error('  ✗ ' + m); };
const ok = (m) => console.log('  ✓ ' + m);

class StubNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase(); this.children = []; this.parentNode = null;
    this.attributes = {}; this.style = {}; this.dataset = {}; this._class = ''; this._text = '';
    this.listeners = {}; this.firstChild = null; this.disabled = false;
  }
  get className() { return this._class; }
  set className(v) { this._class = String(v); this.attributes.class = this._class; }
  get classList() {
    const self = this;
    const list = () => String(self.attributes.class || '').split(/\s+/).filter(Boolean);
    const write = (arr) => { self._class = [...new Set(arr)].join(' '); self.attributes.class = self._class; };
    return {
      add: (...c) => write(list().concat(c)),
      remove: (...c) => write(list().filter((x) => !c.includes(x))),
      toggle: (c, on) => { const has = list().includes(c); const want = on === undefined ? !has : !!on; if (want) write(list().concat(c)); else write(list().filter((x) => x !== c)); },
      contains: (c) => list().includes(c),
    };
  }
  get textContent() { return this.children.length ? this.children.map((c) => c.textContent).join('') : this._text; }
  set textContent(v) { this._text = String(v); this.children = []; this.firstChild = null; }
  set innerHTML(v) { this._text = String(v); this.children = []; this.firstChild = null; }
  append(...nodes) {
    for (const n of nodes) {
      const node = n instanceof StubNode ? n : Object.assign(new StubNode('#text'), { _text: String(n) });
      node.parentNode = this; this.children.push(node);
    }
    this.firstChild = this.children[0] || null;
  }
  appendChild(n) { this.append(n); return n; }
  removeChild(n) { this.children = this.children.filter((c) => c !== n); this.firstChild = this.children[0] || null; return n; }
  setAttribute(k, v) { this.attributes[k] = String(v); if (k === 'class') this._class = String(v); }
  getAttribute(k) { return this.attributes[k]; }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  dispatch(t, ev = {}) { for (const fn of this.listeners[t] || []) fn({ preventDefault() {}, target: this, ...ev }); }
  contains(n) { let cur = n; while (cur) { if (cur === this) return true; cur = cur.parentNode; } return false; }
  descendants() { const out = []; const walk = (n) => { for (const c of n.children) { out.push(c); walk(c); } }; walk(this); return out; }
}
const body = new StubNode('body');
globalThis.document = {
  createElement: (t) => new StubNode(t),
  createTextNode: (t) => Object.assign(new StubNode('#text'), { _text: String(t) }),
  body, querySelector: () => null, getElementById: () => null,
};
globalThis.Node = StubNode;
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 16);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

const { renderBomb, renderPreviewModule } = await import('../client/bomb.js');
const { MODULES } = await import('../lib/modules.js');
const { Rng } = await import('../lib/rng.js');

const cfg = { serial: 'AB1CD23', batteries: 2, batteryTypes: ['AA', 'AA'], indicatorMap: { SIG: true }, ports: ['parallel'] };

console.log('— 盲操猴视野：不应该出现颜色/数字/文字 —\n');
// 允许出现的只有两类：
//   * 模块图标（emoji）：用来分辨"第几个模块"，不含任何题目信息
//   * 倒计时 m:ss：队友要靠它判断"第几秒松手"之类的规则
const ALLOWED = /^[\p{Extended_Pictographic}\uFE0F\u20E3]+$/u;
// 盲操提示条是给玩家看的说明，允许它出现
const HINT = /盲操模式|白色轮廓|看不见颜色|白色高亮/;
const isAllowed = (t) => ALLOWED.test(t) || /^\d{1,2}:\d{2}$/.test(t) || HINT.test(t);
// 这些"语义控件"整个都不应该被生成（不是被 CSS 藏起来）
const FORBIDDEN_CLASSES = ['wire', 'big-button', 'keypad', 'simon', 'mem-display', 'mem-buttons',
  'tele-word', 'tele-key', 'maze-pos', 'dpad', 'pw-letter', 'quiz-q', 'quiz-opts',
  'gear-teeth', 'safe-value', 'numpad', 'letter-pad', 'cap-clock', 'tag'];

let leaked = 0;
for (const [id, def] of Object.entries(MODULES)) {
  const mod = def.make(new Rng('blind-' + id), cfg, 3);
  const main = new StubNode('div');
  body.append(main);
  renderBomb(main, {
    state: {
      you: { vision: 'blind' },
      bomb: { moduleStates: [{ uid: id, id, tier: 3, title: def.title, icon: def.icon, status: 'active', state: mod.state, note: '' }], moduleCount: 1 },
      room: {}, strikes: 0, maxStrikes: 3, remainingMs: 120000,
    },
    act: () => {},
  });
  const texts = main.descendants()
    .filter((n) => n.children.length === 0)
    .map((n) => n.textContent.trim())
    .filter((t) => t.length);
  const bad = [...new Set(texts)].filter((t) => !isAllowed(t));
  const badClasses = [...new Set(main.descendants().flatMap((n) => String(n.className || '').split(/\s+/)))]
    .filter((c) => FORBIDDEN_CLASSES.includes(c));
  if (bad.length || badClasses.length) {
    leaked++;
    if (bad.length) console.log(`  ✗ ${def.title}（${id}）露出文字/数字：${JSON.stringify(bad).slice(0, 140)}`);
    if (badClasses.length) console.log(`  ✗ ${def.title}（${id}）仍然生成了语义控件：${badClasses.join(', ')}`);
  } else {
    console.log(`  ✓ ${def.title}（${id}）只有轮廓 + 图标（没有颜色/数字/文字）`);
  }
}
if (!leaked) ok(`${Object.keys(MODULES).length} 个模块在盲操模式下都没有泄漏任何题目信息`);
else fail(`有 ${leaked} 个模块在盲操模式下仍能读到信息`);

// 定点断言：按钮模块的"字"绝对不能出现在盲操 DOM 里
{
  const mod = MODULES.button.make(new Rng('blind-button'), cfg, 3);
  const main = new StubNode('div');
  body.append(main);
  renderBomb(main, {
    state: {
      you: { vision: 'blind' },
      bomb: { moduleStates: [{ uid: 'b', id: 'button', tier: 3, title: '按钮', icon: '🔘', status: 'active', state: mod.state, note: '' }], moduleCount: 1 },
      room: {}, strikes: 0, maxStrikes: 3, remainingMs: 120000,
    },
    act: () => {},
  });
  const text = main.descendants().map((n) => n.textContent).join(' ');
  const label = mod.state.label;
  if (label && !text.includes(label)) ok(`按钮上的字「${label}」不会出现在盲操屏幕上`);
  else fail(`按钮上的字「${label}」泄漏到了盲操屏幕上`);
  // 收紧检查：颜色字单独出现在某个元素里才算泄漏（避免把"盲操模式…白色轮廓"这句话误判）
  const colorName = { red: '红', blue: '蓝', yellow: '黄', white: '白', green: '绿', black: '黑' }[mod.state.color];
  const leaves = main.descendants().filter((n) => n.children.length === 0).map((n) => n.textContent.trim());
  if (!leaves.some((t) => new RegExp(`^[·\\s]*${colorName}[\\s·]*$`, 'u').test(t))) {
    ok(`按钮颜色名「${colorName}」也不会单独出现`);
  } else fail(`按钮颜色名「${colorName}」泄漏了`);
}

// 盲操者仍然点得动（剪影上绑了点击）
{
  const mod = MODULES.wires.make(new Rng('blind-wires'), cfg, 2);
  const main = new StubNode('div');
  body.append(main);
  const actions = [];
  renderBomb(main, {
    state: {
      you: { vision: 'blind' },
      bomb: { moduleStates: [{ uid: 'w', id: 'wires', tier: 2, title: '线缆', icon: '🪢', status: 'active', state: mod.state, note: '' }], moduleCount: 1 },
      room: {}, strikes: 0, maxStrikes: 3, remainingMs: 120000,
    },
    act: (uid, action) => actions.push(action),
  });
  const shapes = main.descendants().filter((n) => n.className.includes('bo-bar') && n.className.includes('clickable'));
  if (shapes.length === mod.state.wires.length) ok(`剪影画了 ${shapes.length} 根线，而且都能点`);
  else fail(`剪影的线数量不对：${shapes.length}（应为 ${mod.state.wires.length}）`);
  shapes[1].dispatch('click');
  await new Promise((r) => setTimeout(r, 30));
  if (actions.some((a) => a.type === 'cut' && a.index === 1)) ok('点第 2 个轮廓 → 发出 cut(index=1)');
  else fail(`点击没有转成操作：${JSON.stringify(actions)}`);
}

// 管理端"单模块盲操预览"也要一样干净（走的是同一条剪影路径）
{
  let badCount = 0;
  for (const [id, def] of Object.entries(MODULES)) {
    const mod = def.make(new Rng('preview-blind-' + id), cfg, 3);
    const node = renderPreviewModule(
      { uid: id, id, tier: 3, title: def.title, icon: def.icon, status: 'active', state: mod.state, note: '' },
      () => {},
      { blind: true },
    );
    const texts = node.descendants().filter((n) => n.children.length === 0).map((n) => n.textContent.trim()).filter((t) => t.length);
    const bad = [...new Set(texts)].filter((t) => !isAllowed(t));
    if (bad.length) { badCount++; fail(`单模块盲操预览（${def.title}）露出：${JSON.stringify(bad).slice(0, 120)}`); }
  }
  if (!badCount) ok('管理端"单模块盲操预览"也没有泄漏文字/数字');
}

console.log(`\n失败 ${failures} 项`);
process.exitCode = failures ? 1 : 0;
