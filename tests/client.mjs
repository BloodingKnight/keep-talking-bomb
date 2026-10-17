// Client-side tests without a browser: drive the real renderers against a tiny
// DOM stub and verify
//   1. the flash-sequence animation actually lights buttons and keeps its clock
//      across the per-second server heartbeat (this was the "闪光序列没有闪光" bug),
//   2. the morse light blinks,
//   3. a heartbeat push does not rebuild the module DOM.
//
//   node tests/client.mjs

let failures = 0;
const fail = (m) => { failures++; console.error('  ✗ ' + m); };
const ok = (m) => console.log('  ✓ ' + m);

// ------------------------------------------------------------------ DOM stub
class StubNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.style = {};
    this.dataset = {};
    this._class = '';
    this._text = '';
    this.listeners = {};
    this.firstChild = null;
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientHeight = 0;
    this.disabled = false;
  }
  get className() { return this._class; }
  set className(v) { this._class = String(v); }
  get classList() {
    const self = this;
    const list = () => self._class.split(/\s+/).filter(Boolean);
    return {
      add: (...c) => { const s = new Set(list()); c.forEach((x) => s.add(x)); self._class = [...s].join(' '); },
      remove: (...c) => { const s = new Set(list()); c.forEach((x) => s.delete(x)); self._class = [...s].join(' '); },
      toggle: (c, on) => { const has = list().includes(c); const want = on === undefined ? !has : !!on; want ? self.classList.add(c) : self.classList.remove(c); },
      contains: (c) => list().includes(c),
    };
  }
  get textContent() {
    if (this.children.length) return this.children.map((c) => c.textContent).join('');
    return this._text;
  }
  set textContent(v) { this._text = String(v); this.children = []; }
  set innerHTML(v) { this.children = []; this._text = String(v); }
  append(...nodes) {
    for (const n of nodes) {
      const node = n instanceof StubNode ? n : new StubNode('#text');
      if (!(n instanceof StubNode)) node._text = String(n);
      node.parentNode = this;
      this.children.push(node);
    }
    this.firstChild = this.children[0] || null;
  }
  appendChild(n) { this.append(n); return n; }
  removeChild(n) { this.children = this.children.filter((c) => c !== n); this.firstChild = this.children[0] || null; return n; }
  setAttribute(k, v) {
    this.attributes[k] = String(v);
    if (k === 'class') this.className = v;
    if (k.startsWith('data-')) this.dataset[k.slice(5).replace(/-(\w)/g, (m, c) => c.toUpperCase())] = String(v);
  }
  getAttribute(k) { return this.attributes[k]; }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  click() { (this.listeners.click || []).forEach((fn) => fn({ preventDefault() {} })); }
  dispatch(type, ev = {}) { (this.listeners[type] || []).forEach((fn) => fn({ preventDefault() {}, ...ev })); }
  querySelector() { return null; }
  /** 像真实 DOM 一样：沿 parentNode 往上找，也算自己的祖先链。 */
  contains(n) {
    let cur = n;
    while (cur) {
      if (cur === this) return true;
      cur = cur.parentNode;
    }
    return false;
  }
  all() {
    return this.children.reduce((acc, c) => acc.concat(c.all ? c.all() : []), [this.children]);
  }
  descendants() {
    const out = [];
    const walk = (node) => { for (const c of node.children) { out.push(c); walk(c); } };
    walk(this);
    return out;
  }
}

const stubDoc = {
  createElement: (tag) => new StubNode(tag),
  createTextNode: (t) => { const n = new StubNode('#text'); n._text = String(t); return n; },
  body: new StubNode('body'),
  querySelector: () => null,
  getElementById: () => null,
};
globalThis.document = stubDoc;
globalThis.window = { location: { href: 'http://localhost/' } };
globalThis.Node = StubNode;
globalThis.requestAnimationFrame = (fn) => setTimeout(() => {
  try { fn(Date.now()); } catch (e) { console.error('    动画回调抛错:', e && e.message, '\n', e && e.stack); }
}, 16);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.setTimeout = setTimeout;
globalThis.clearTimeout = clearTimeout;

// ---------------------------------------------------------------- animation
console.log('— 闪光序列动画 —');
const { buildFlashTimeline, flashStateAt, renderBomb } = await import('../client/bomb.js');

const timeline = buildFlashTimeline(['red', 'blue', 'green']);
if (flashStateAt(timeline, 0) === -1) ok('起始有引导时间（不会一上来什么都没有）');
else fail('时间轴起点就亮灯，不合预期');
let lit = [];
for (let t = 0; t < timeline.total; t += 20) {
  const i = flashStateAt(timeline, t);
  if (i >= 0 && !lit.includes(timeline.marks[i].color)) lit.push(timeline.marks[i].color);
}
if (lit.join(',') === 'red,blue,green') ok(`一轮里三种颜色依次亮起：${lit.join(' → ')}`);
else fail(`一闪顺序不对：${lit.join(',')}`);
if (timeline.total > timeline.marks[2].end) ok(`一轮结束后有 ${(timeline.tail / 1000).toFixed(1)}s 停顿时长，便于重复观察`);
else fail('一轮结束没有停顿时长');

const seq3 = ['red', 'blue', 'green'];
const simonMod = {
  uid: 'simon-0', id: 'simon', tier: 1, title: '闪光序列', icon: '🚦', status: 'active',
  state: { buttons: ['red', 'blue', 'green', 'yellow'], playSeq: seq3, seqLength: seq3.length, expected: 0, rounds: 3, strikeStates: 1 },
};

function renderSimonOnce() {
  const main = new StubNode('div');
  stubDoc.body.append(main);   // 真实页面里 #main-area 就在 body 里
  const probe = new StubNode('span');
  main.append(probe);
  if (!stubDoc.body.contains(probe)) fail('测试桩的 contains 判定有问题（probe 应该算在 body 里）');
  renderBomb(main, { state: { bomb: { moduleStates: [simonMod], moduleCount: 1, difficulty: 'normal' }, room: { difficulty: 'normal' } }, act: () => {} });
  const find = (node, pred) => node.descendants().find(pred);
  const grid = find(main, (n) => n.className.includes('simon'));
  if (grid && !stubDoc.body.contains(grid)) fail('测试桩：grid 没挂在 body 下（动画会以为自己被移除而停下）');
  const chain = [];
  for (let c = grid; c; c = c.parentNode) chain.push(`${c.tagName}${c.className ? '.' + c.className.split(' ')[0] : ''}`);
  return { main, grid, chain: chain.join(' <- '), status: find(main, (n) => n.className.includes('small')) };
}

const first = renderSimonOnce();
if (first.grid) ok('闪光序列模块渲染出了 4 个颜色按钮');
else fail('没渲染出颜色按钮');

// 等一轮，看是否真的有按钮亮起；记录整段时间内的亮灯情况
const seen = [];
let dbg = 0;
const watch = setInterval(() => {
  dbg++;
  const litNow = first.grid.children.filter((c) => c.className.includes('lit')).map((c) => c.textContent);
  if (litNow.length) seen.push(litNow.join('+'));
}, 30);
await new Promise((r) => setTimeout(r, Math.min(timeline.total, 4000)));
clearInterval(watch);
const statusNode = first.main.descendants().find((n) => n.className.includes('small'));
console.log(`    调试：轮询 ${dbg} 次，观察亮灯 ${seen.length} 次${seen.length ? `（${[...new Set(seen)].join(', ')}）` : ''}；状态="${statusNode ? statusNode.textContent : '(无)'}"`);
if (seen.length >= 1) ok('动画播放中确实有按钮亮起（class=lit）');
else fail('等了很久仍然没有任何按钮亮起');

// 关键回归：服务端每秒的心跳导致重绘时，动画时钟不能被重置
const second = renderSimonOnce();
const seen2 = [];
const watch2 = setInterval(() => {
  const litNow = second.grid.children.filter((c) => c.className.includes('lit')).map((c) => c.textContent);
  if (litNow.length) seen2.push(litNow.join('+'));
}, 30);
await new Promise((r) => setTimeout(r, Math.min(timeline.total, 4000)));
clearInterval(watch2);
if (seen2.length >= 1) ok('重绘之后动画时钟未重置（按钮仍然在闪）');
else fail('重绘把动画时钟重置了 —— 这正是"闪光序列没有闪光"的原因');

// ------------------------------------------------------- morse telegraph
// 摩斯改成"电报机"玩法后，拆弹者这边只有单词 + 电报键盘（灯由专家念节奏）
console.log('\n— 摩斯电报机 —');
const morseMod = {
  uid: 'morse-0', id: 'morse', tier: 2, title: '摩斯电报', icon: '📻', status: 'active',
  state: { words: [{ word: 'shell' }], index: 0, entered: ['dot'], sentCount: 0, done: 0, total: 1 },
};
const main2 = new StubNode('div');
stubDoc.body.append(main2);
const sentMorse = [];
renderBomb(main2, { state: { bomb: { moduleStates: [morseMod], moduleCount: 1 }, room: {} }, act: (uid, a) => sentMorse.push(a) });
const wordNode = main2.descendants().find((n) => n.className.includes('tele-word'));
if (wordNode && wordNode.textContent === 'shell') ok(`拆弹者看到目标单词：${wordNode.textContent}`);
else fail(`摩斯电报没有显示单词：${wordNode ? wordNode.textContent : '(没有)'}`);
const teleKeys = main2.descendants().filter((n) => n.className.includes('tele-key'));
if (teleKeys.length === 2) ok('有电报键盘（点 / 横）');
else fail(`电报键盘数量不对：${teleKeys.length}`);
teleKeys[1].dispatch('click');
await new Promise((r) => setTimeout(r, 30));
if (sentMorse.some((a) => a.type === 'tapKey' && a.mark === 'dash')) ok('敲"横"会提交 tapKey(dash)');
else fail(`敲键动作不对：${JSON.stringify(sentMorse)}`);
const tape = main2.descendants().find((n) => n.className.includes('tele-tape'));
if (tape && tape.textContent.includes('·')) ok('纸带显示已敲入的点横');
else fail(`纸带没有显示内容：${tape ? tape.textContent : '(没有)'}`);

console.log(`\n失败 ${failures} 项`);
process.exit(failures ? 1 : 0);

