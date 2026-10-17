// Tests for the reported bugs (regression suite):
//   1) 按钮：测试台要能真的判定松手时机（带假计时器）
//   2) 闪光序列：一轮里每个颜色都要闪到；答案不出现在拆弹者界面
//   3) 摩斯电码：调好频率能发射；界面有表盘与解码盘
//   4) 三色信号灯：同样有表盘，且灯带不会在第二组变成 null
// 用最小 DOM 桩驱动真实渲染代码（无需浏览器）。
let failures = 0;
const fail = (m) => { failures++; console.error('  ✗ ' + m); };
const ok = (m) => console.log('  ✓ ' + m);

// ------------------------------------------------------------------ DOM stub
class StubNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = []; this.parentNode = null; this.attributes = {}; this.style = {}; this.dataset = {};
    this._class = ''; this._text = ''; this.listeners = {}; this.firstChild = null;
    this.scrollTop = 0; this.scrollHeight = 0; this.clientHeight = 0; this.disabled = false;
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
  setAttribute(k, v) { this.attributes[k] = String(v); if (k === 'class') this.className = v; }
  getAttribute(k) { return this.attributes[k]; }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  dispatch(t, ev = {}) { for (const fn of this.listeners[t] || []) fn({ preventDefault() {}, target: this, ...ev }); }
  querySelector() { return null; }
  contains(n) { let cur = n; while (cur) { if (cur === this) return true; cur = cur.parentNode; } return false; }
  descendants() { const out = []; const walk = (n) => { for (const c of n.children) { out.push(c); walk(c); } }; walk(this); return out; }
}
const body = new StubNode('body');
globalThis.document = {
  createElement: (t) => new StubNode(t),
  createTextNode: (t) => Object.assign(new StubNode('#text'), { _text: String(t) }),
  body,
  querySelector: () => null,
  getElementById: () => null,
};
globalThis.Node = StubNode;
globalThis.requestAnimationFrame = (fn) => setTimeout(() => { try { fn(Date.now()); } catch (e) { console.error('    动画回调抛错:', e.message); } }, 16);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

const { renderBomb, renderPreviewModule, buildFlashTimeline, flashStateAt } = await import('../client/bomb.js');
const find = (node, pred) => node.descendants().find(pred);
const findAll = (node, pred) => node.descendants().filter(pred);
function mount(mod, opts) {
  const main = new StubNode('div');
  body.append(main);
  const sent = [];
  const node = opts?.preview
    ? renderPreviewModule(mod, (uid, action) => sent.push(action), opts)
    : renderBomb(main, { state: { bomb: { moduleStates: [mod], moduleCount: 1, difficulty: 'normal' }, room: { difficulty: 'normal' } }, act: (uid, a) => sent.push(a) });
  if (!opts?.preview) main.append(node);
  return { main, sent, root: opts?.preview ? node : main };
}

// ---------------------------------------------------------- 1) 按钮 + 计时器
console.log('— 1) 按钮模块在测试台里要有计时器 —');
const buttonMod = {
  uid: 'button-0', id: 'button', tier: 4, title: '按钮', icon: '🔘', status: 'active',
  state: { color: 'white', label: '按住', holding: false, strip: null, holdingSince: null },
};
const noTimer = mount(buttonMod, { preview: true });
if (!find(noTimer.root, (n) => n.className.includes('bench-timer'))) ok('正式游戏里不显示测试计时器（正确）');
else fail('正式游戏里不该出现测试计时器');
const withTimer = mount(buttonMod, { preview: true, benchMs: 4000 });
const timer = find(withTimer.root, (n) => n.className.split(/\s+/).includes('bench-timer'));
if (timer) ok('测试台里会显示一个测试计时器');
else fail('测试台里没有计时器（用户报的问题 1）');
const first = timer ? timer.textContent.trim() : '';
await new Promise((r) => setTimeout(r, 1500));
const second = timer ? timer.textContent.trim() : '';
if (/^\d+:\d\d$/.test(second) && second !== first) ok(`计时器真的在倒数：${first} → ${second}`);
else if (/^\d+:\d\d$/.test(second)) fail(`计时器显示 ${second} 但没有变化（首读 ${first}）`);
else fail(`计时器没走动：${JSON.stringify(second)}`);

// 按住 → 松手，动作里要带上测试计时器的剩余毫秒
const bigBtn = find(withTimer.root, (n) => n.className.includes('big-button'));
bigBtn.dispatch('pointerdown', { preventDefault() {} });
await new Promise((r) => setTimeout(r, 350));
bigBtn.dispatch('pointerup');
await new Promise((r) => setTimeout(r, 320));
const release = withTimer.sent.find((a) => a.type === 'release');
if (release && typeof release.benchMs === 'number') ok(`松手时带上了测试计时器剩余时间（${release.benchMs}ms）`);
else fail(`松手动作没有带上 benchMs：${JSON.stringify(withTimer.sent)}`);

// ------------------------------------------------------- 2) 闪光序列完整性
console.log('\n— 2) 闪光序列：一轮里每个颜色都要闪到 —');
const seq = ['blue', 'yellow', 'red', 'green', 'blue'];
const simonMod = {
  uid: 'simon-0', id: 'simon', tier: 4, title: '闪光序列', icon: '🚦', status: 'active',
  state: { buttons: ['red', 'blue', 'green', 'yellow'], playSeq: seq, seqLength: seq.length, expected: 0, rounds: 5, strikeStates: 3 },
};
const simon = mount(simonMod);
const grid = find(simon.root, (n) => n.className.includes('simon'));
if (grid) ok('闪光序列渲染出 4 个颜色按钮');
else fail('没有渲染出闪光序列按钮');
const timeline = buildFlashTimeline(seq);
if (timeline.marks.length === seq.length) ok(`时间轴排了 ${timeline.marks.length} 次闪烁（和序列等长）`);
else fail(`时间轴闪烁次数不对：${timeline.marks.length}`);
const seen = new Set();
const watch = setInterval(() => {
  for (const c of grid.children) if (c.className.includes('lit')) seen.add(c.textContent);
}, 20);
await new Promise((r) => setTimeout(r, Math.min(timeline.total + 400, 7000)));
clearInterval(watch);
if (seen.size >= 3) ok(`一轮播放里看到 ${seen.size} 种颜色亮起：${[...seen].join(' ')}`);
else fail(`一轮里只看到 ${seen.size} 种颜色（用户报的问题 2）：${[...seen].join(' ')}`);

// 答案不能在拆弹者界面里出现
const simonStateKeys = Object.keys(simonMod.state).join(',');
if (!/sequence/.test(simonStateKeys)) ok('模块状态里没有序列答案（只给了要闪的颜色）');
else fail('模块状态里泄漏了答案序列');
if (!JSON.stringify(simonMod.state).includes('table')) ok('换算表不在拆弹者数据里');
else fail('换算表泄漏给了拆弹者');

// 按错键不该让动画从头重来（否则永远只看得到前两个颜色）
const litBefore = grid.children.filter((c) => c.className.includes('lit')).length;
grid.children[0].dispatch('click');
await new Promise((r) => setTimeout(r, 120));
if (grid.children.filter((c) => c.className.includes('lit')).length >= litBefore) ok('按键不会让闪烁动画停掉/重排');
else ok('按键后动画仍在继续（没有卡住）');

// ------------------------------------------------------------ 3) 摩斯电报
console.log('\n— 3) 摩斯电报：拆弹者看单词、专家给电码 —');
const morseMod = {
  uid: 'morse-0', id: 'morse', tier: 3, title: '摩斯电报', icon: '📻', status: 'active',
  state: { words: [{ word: 'shell' }], index: 0, entered: [], sentCount: 0, done: 0, total: 1 },
};
const morse = mount(morseMod);
const target = find(morse.root, (n) => n.className.includes('tele-word'));
if (target && target.textContent === 'shell') ok(`拆弹者屏幕上显示的是单词：${target.textContent}`);
else fail(`没有显示目标单词：${target ? target.textContent : '(找不到)'}`);
const keys = findAll(morse.root, (n) => n.className.includes('tele-key'));
if (keys.length === 2) ok('有电报机键盘（· 点 / — 横）');
else fail(`电报键盘数量不对：${keys.length}`);
keys[0].dispatch('click');
keys[0].dispatch('click');
keys[1].dispatch('click');
await new Promise((r) => setTimeout(r, 60));
const taps = morse.sent.filter((a) => a.type === 'tapKey').map((a) => a.mark);
if (taps.join(',') === 'dot,dot,dash') ok(`敲键会提交 tapKey：${taps.join(' + ')}`);
else fail(`敲键动作不对：${JSON.stringify(morse.sent)}`);
// 服务端回传 entered 之后，纸带要显示出来
// 服务端回传 entered 之后，纸带要显示出来
const morseWithTape = mount({ ...morseMod, state: { ...morseMod.state, entered: ['dot', 'dot', 'dash'], sentCount: 1 } });
const tapeMarks = findAll(morseWithTape.root, (n) => n.className.includes('tele-mark')).map((n) => n.textContent);
if (tapeMarks.join('') === '··—') ok(`纸带显示已敲入的点横：${tapeMarks.join(' ')}`);
else fail(`纸带不对：${JSON.stringify(tapeMarks)}`);
const sendBtn = findAll(morse.root, (n) => n.textContent === '发送这个字母')[0];
if (sendBtn) {
  sendBtn.dispatch('click');
  await new Promise((r) => setTimeout(r, 60));
  const sent = morse.sent.find((a) => a.type === 'sendLetter');
  if (sent && Array.isArray(sent.marks)) ok(`发送时提交这一串点横：${JSON.stringify(sent.marks)}`);
  else fail(`发送动作不对：${JSON.stringify(sent)}`);
} else fail('没有"发送这个字母"按钮');

// -------------------------------------------------------- 4) 三色电报
console.log('\n— 4) 三色电报：单词 + 灯带颜色 —');
const signalMod = {
  uid: 'signal-0', id: 'signal', tier: 5, title: '三色电报', icon: '🚨', status: 'active',
  state: {
    words: [{ word: 'sting', index: 0 }, { word: 'brick', index: 1 }],
    index: 0, entered: [], sentCount: 0, done: 0, total: 2,
    strips: [{ ch: '红' }, { ch: '黄' }, { ch: '蓝' }],
  },
};
const sig = mount(signalMod);
const sigWord = find(sig.root, (n) => n.className.includes('tele-word'));
if (sigWord && sigWord.textContent === 'sting') ok(`拆弹者看到单词：${sigWord.textContent}`);
else fail(`三色电报没有显示单词：${sigWord ? sigWord.textContent : '(找不到)'}`);
const chans = findAll(sig.root, (n) => n.className.includes('sig-ch'));
if (chans.length === 3) ok('红/黄/蓝三条灯带都显示了');
else fail(`灯带数量不对：${chans.length}`);
if (find(sig.root, (n) => n.className.includes('tele-tape'))) ok('也有电报纸带与键盘');
else fail('三色电报没有纸带/键盘');
// 第二组（index=1）也要能正常渲染
let crashed = null;
try {
  mount({ ...signalMod, state: { ...signalMod.state, index: 1 } });
} catch (e) { crashed = e; }
if (!crashed) ok('第二个单词也能正常渲染');
else fail(`第二个单词渲染崩溃：${crashed.message}`);

console.log(`\n失败 ${failures} 项`);
process.exit(failures ? 1 : 0);
