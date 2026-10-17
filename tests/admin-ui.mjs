// Regression test for the admin panel's module picker:
// the 2-second auto refresh must NOT rebuild the <select> and snap the choice
// back to whatever module was last previewed (that made "只能选线缆").
//
// No browser needed: drive client/admin.js against a small DOM stub and a fake
// fetch that answers /api/admin/state and /api/admin/action.
//
//   node tests/admin-ui.mjs

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
    this.scrollTop = 0; this.scrollHeight = 0; this.clientHeight = 0;
    this._value = '';
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
  }
  get className() { return this._class; }
  set className(v) { this._class = String(v); }
  get classList() {
    const self = this;
    const list = () => self._class.split(/\s+/).filter(Boolean);
    return {
      add: (...c) => { const s = new Set(list()); c.forEach((x) => s.add(x)); self._class = [...s].join(' '); },
      remove: (...c) => { const s = new Set(list()); c.forEach((x) => s.delete(x)); self._class = [...s].join(' '); },
      toggle: (c, on) => { const has = list().includes(c); const want = on === undefined ? !has : !!on; if (want) self.classList.add(c); else self.classList.remove(c); },
      contains: (c) => list().includes(c),
    };
  }
  get textContent() { return this.children.length ? this.children.map((c) => c.textContent).join('') : this._text; }
  set textContent(v) { this._text = String(v); this.children = []; this.firstChild = null; }
  set innerHTML(v) { this._text = String(v); this.children = []; this.firstChild = null; }
  get value() { return this._value || (this.children[0] ? this.children[0].value : ''); }
  set value(v) { this._value = String(v); }
  append(...nodes) {
    for (const n of nodes) {
      const node = n instanceof StubNode ? n : Object.assign(new StubNode('#text'), { _text: String(n) });
      node.parentNode = this;
      this.children.push(node);
      if (this.tagName === 'SELECT') {
        const selected = node.attributes && node.attributes.selected !== undefined;
        if (selected || !this._value) this._value = node.value !== undefined ? node.value : node.getAttribute('value');
      }
    }
    this.firstChild = this.children[0] || null;
  }
  appendChild(n) { this.append(n); return n; }
  removeChild(n) { this.children = this.children.filter((c) => c !== n); this.firstChild = this.children[0] || null; return n; }
  setAttribute(k, v) {
    this.attributes[k] = String(v);
    if (k === 'class') this.className = v;
    if (k === 'value') this._value = String(v);
    if (k === 'selected') this._value = this.attributes.value || this._value;
  }
  getAttribute(k) { return this.attributes[k]; }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  dispatch(type, ev = {}) { for (const fn of this.listeners[type] || []) fn({ preventDefault() {}, target: this, ...ev }); }
  querySelector() { return null; }
  contains(n) { let cur = n; while (cur) { if (cur === this) return true; cur = cur.parentNode; } return false; }
  descendants() { const out = []; const walk = (n) => { for (const c of n.children) { out.push(c); walk(c); } }; walk(this); return out; }
}

const byId = new Map();
const node = (id) => {
  if (!byId.has(id)) {
    const n = new StubNode(id.includes('module') || id.includes('tier') || id === 'bench-module' || id === 'bench-tier' ? 'select' : 'div');
    n.setAttribute('id', id);
    byId.set(id, n);
  }
  return byId.get(id);
};
// 页面上真实存在的元素
for (const id of ['stage-token', 'stage-admin', 'token-error', 'token-input', 'btn-token', 'bench-module', 'bench-tier',
  'bench-status', 'bench-body', 'check-report', 'rooms-list', 'server-info', 'diff-table', 'admin-badge', 'auto-refresh',
  'btn-generate', 'btn-check-all', 'btn-refresh-rooms', 'toast',
  'tab-bench', 'tab-rooms', 'tab-server']) {
  node(id);
}
// 三个标签按钮（点它们会触发完整的 refreshAll → renderAll，和自动刷新同一条路径）
const tabButtons = ['bench', 'rooms', 'server'].map((name) => {
  const b = new StubNode('button');
  b.className = 'tab';
  b.dataset.tab = name;
  return b;
});

globalThis.document = {
  createElement: (t) => new StubNode(t),
  createTextNode: (t) => Object.assign(new StubNode('#text'), { _text: String(t) }),
  body: new StubNode('body'),
  hidden: false,
  querySelector: (sel) => (sel.startsWith('#') ? node(sel.slice(1)) : null),
  querySelectorAll: (sel) => (sel === '.tab' ? tabButtons : []),
  getElementById: (id) => node(id),
};
globalThis.Node = StubNode;
globalThis.window = { location: { href: 'http://localhost/admin?token=tok' } };
globalThis.location = { href: 'http://localhost/admin?token=tok' };
globalThis.history = { replaceState() {} };
globalThis.confirm = () => true;
globalThis.sessionStorage = {
  _m: new Map(),
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
  setItem(k, v) { this._m.set(k, String(v)); },
  removeItem(k) { this._m.delete(k); },
};
let toasts = [];
globalThis.fetch = async (path, opts = {}) => {
  if (path === '/api/admin/state') {
    return jsonResponse({
      ok: true,
      server: { startedAt: Date.now() - 1000, now: Date.now(), uptimeMs: 1000, node: 'v25', testMode: false, rooms: 0, players: 0, connected: 0, previews: 1 },
      modules: MODULES.map((m) => ({ id: m, title: m })),
      difficulties: [],
      rooms: [],
    });
  }
  if (path === '/api/admin/action') {
    const body = JSON.parse(opts.body || '{}');
    if (body.type === 'preview') {
      lastPreviewRequest = body;
      return jsonResponse({ preview: makePreview(body.module, body.tier) });
    }
    if (body.type === 'previewAction') return jsonResponse({ previewResult: {} });
    if (body.type === 'selfCheck') return jsonResponse({ report: { checked: 65, ok: 65, problems: [] } });
  }
  throw new Error(`unexpected fetch ${path}`);
};
function jsonResponse(data) {
  return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) };
}

const MODULES = ['wires', 'button', 'keypad', 'simon', 'memory', 'morse', 'maze', 'password', 'quiz', 'gears', 'balance', 'decoder', 'signal'];
let lastPreviewRequest = null;
let previewCounter = 0;
function makePreview(module, tier) {
  previewCounter++;
  return {
    module, moduleId: module, tier, icon: '🧩', asks: ['问点什么'],
    state: { uid: `p${previewCounter}`, id: module, tier, title: module, icon: '🧩', status: 'active', state: {}, note: '' },
    manual: { mode: 'full', seat: 0, ecount: 1, colorLegend: [], casing: { serial: 'AB1CD23', batteries: 1, batteryTypes: [], indicators: [], ports: [] }, sections: [] },
  };
}

// --------------------------------------------------------------------- run
/** 等一次完整刷新（点标签 → refreshAll() → renderAll()，与自动刷新同一条路径）。 */
async function refreshOnce() {
  tabButtons[1].dispatch('click');
  await new Promise((r) => setTimeout(r, 30));
}
/** 当前"上一道题"用的模块（admin.js 内部通过 state.preview.moduleId 写过选择框）。 */
function statePreviewModule() { return lastPreviewRequest ? lastPreviewRequest.module : ''; }

console.log('— 管理面板：模块选择器不会被自动刷新改回去 —');
await import('../client/admin.js');
// 触发令牌登录（boot() 里绑定好的按钮）
node('token-input').value = 'tok';
node('btn-token').dispatch('click');
await new Promise((r) => setTimeout(r, 60));

const sel = node('bench-module');
const options = sel.children.map((c) => c.getAttribute('value'));
if (options.length === MODULES.length) ok(`模块下拉框列出了 ${options.length} 个模块`);
else fail(`模块下拉框选项数不对：${options.length}（期望 ${MODULES.length}）`);
if (sel.value === 'wires') ok(`初始选中：${sel.value}`);
else fail(`初始选中不对：${sel.value}`);

// 换一个模块（用户操作）
sel.value = 'maze';
node('bench-tier').value = '4';
sel.dispatch('change');
await new Promise((r) => setTimeout(r, 60));
if (lastPreviewRequest && lastPreviewRequest.module === 'maze' && lastPreviewRequest.tier === 4) {
  ok(`切换到「迷宫 / 等级 4」后，请求的就是这个组合（模块=${lastPreviewRequest.module}）`);
} else {
  fail(`切换模块后请求的参数不对：${JSON.stringify(lastPreviewRequest)}`);
}

// 直接验证"刷新时不许动下拉框"：把选择改成别的模块，等一次完整刷新，
// 选择必须原封不动（旧版会按 state.preview.moduleId 把值写回去）
const previewModule = statePreviewModule();
sel.value = previewModule === 'wires' ? 'quiz' : 'wires';
await refreshOnce();
if (sel.value === (previewModule === 'wires' ? 'quiz' : 'wires')) {
  ok(`刷新时不会把下拉框回写成上一题的模块（当前题=${previewModule}，选择保持=${sel.value}）`);
} else {
  fail(`刷新把下拉框回写成了 ${sel.value}（当前题=${previewModule}），说明又按 preview 重置了选择`);
}

// 模拟自动刷新若干次（点标签会走 refreshAll() → renderAll()，和自动刷新同一条路径）
// 原来这里会把选择改回"线缆"
const before = sel.value;
const beforeChildren = sel.children.length;
for (let i = 0; i < 4; i++) {
  await refreshOnce();
}
if (sel.value === before) ok(`完整刷新 ${4} 次后仍保持选中「${sel.value}」`);
else fail(`刷新把选择改回了 ${sel.value}（应为 ${before}）`);
if (sel.children.length === beforeChildren) ok('刷新不会重建下拉框 DOM（选中项不会被重置）');
else fail('刷新重建了下拉框');

// 再换一个模块，确认还能继续切换
sel.value = 'decoder';
sel.dispatch('change');
await new Promise((r) => setTimeout(r, 60));
if (lastPreviewRequest?.module === 'decoder') ok('还能继续切换到别的模块（十进制解码）');
else fail(`再次切换失败：${JSON.stringify(lastPreviewRequest)}`);
if (sel.value === 'decoder') ok('切换后下拉框显示的就是刚选的模块');
else fail(`切换后下拉框被改成了 ${sel.value}`);

// 等级下拉框同样要能自由选择
const tierSel = node('bench-tier');
tierSel.value = '2';
tierSel.dispatch('change');
await new Promise((r) => setTimeout(r, 60));
if (lastPreviewRequest?.tier === 2) ok('等级下拉框可以自由切换（等级 2）');
else fail(`等级切换失败：${JSON.stringify(lastPreviewRequest)}`);

console.log(`\n失败 ${failures} 项`);
process.exit(failures ? 1 : 0);
