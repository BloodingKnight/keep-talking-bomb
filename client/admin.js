// 管理入口前端：模块验题台 + 房间监控 + 服务器状态。
// 和玩家端共用 renderPreviewModule / renderManual，保证"看到的就是玩家看到的"。

import { el, clear, fmtClock, toast } from './dom.js';
import { renderPreviewModule } from './bomb.js';
import { renderManual } from './manual.js';

const state = {
  token: '',
  data: null,
  preview: null,
  report: null,
  timer: null,
  moduleOptionsSignature: '',
  rolePreview: null,
  teammateCursor: null,
  // 出题与视角
  questionKind: 'module',        // 'module' | 'bomb'
  viewPick: ['operator', 'expert'],
};

// ------------------------------------------------------------------ token
function readTokenFromUrl() {
  const url = new URL(location.href);
  return url.searchParams.get('token') || '';
}

function saveToken(token) {
  state.token = token;
  try { sessionStorage.setItem('bomb:admin-token', token); } catch { /* ignore */ }
  const url = new URL(location.href);
  url.searchParams.set('token', token);
  history.replaceState(null, '', url);
}

function forgetToken() {
  state.token = '';
  try { sessionStorage.removeItem('bomb:admin-token'); } catch { /* ignore */ }
}

// -------------------------------------------------------------------- api
async function adminApi(path, body, method = 'POST') {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', 'x-admin-token': state.token },
    body: method === 'POST' ? JSON.stringify(body || {}) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    const err = new Error('管理令牌无效');
    err.unauthorized = true;
    throw err;
  }
  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
  return data;
}

// -------------------------------------------------------------------- boot
async function boot() {
  $('#stage-token').classList.add('hidden');
  $('#stage-admin').classList.add('hidden');
  bindAll();

  const urlToken = readTokenFromUrl();
  let saved = '';
  try { saved = sessionStorage.getItem('bomb:admin-token') || ''; } catch { /* ignore */ }
  const token = urlToken || saved;
  if (!token) return showToken('');

  state.token = token;
  try {
    await refreshAll();
    saveToken(token);
    showPanel();
  } catch (e) {
    if (e.unauthorized) {
      forgetToken();
      showToken('令牌不对或已过期，请重新粘贴。');
    } else {
      showToken(`无法连接服务器：${e.message}`);
    }
  }
}

function showToken(message) {
  $('#stage-token').classList.remove('hidden');
  $('#stage-admin').classList.add('hidden');
  $('#token-error').textContent = message || '';
  stopAutoRefresh();
}

function showPanel() {
  $('#stage-token').classList.add('hidden');
  $('#stage-admin').classList.remove('hidden');
  renderAll();
  syncQuestionControls();
  renderQuestion();
  startAutoRefresh();
}

async function refreshAll() {
  state.data = await adminApi('/api/admin/state', null, 'GET');
  const cursor = state.data.teammateCursor || null;
  const changed = JSON.stringify(cursor) !== JSON.stringify(state.teammateCursor);
  state.teammateCursor = cursor;
  // 有人（盲操猴）在操作时，把他的手标位置实时画到当前视角上
  if (changed && state.rolePreview) renderQuestion();
}

function bindAll() {
  $('#btn-token').addEventListener('click', async () => {
    const token = $('#token-input').value.trim();
    if (!token) return;
    state.token = token;
    try {
      await refreshAll();
      saveToken(token);
      showPanel();
      toast('已进入管理入口', 1500);
    } catch (e) {
      state.token = '';
      $('#token-error').textContent = e.unauthorized ? '令牌不对，再看看终端里打印的那串。' : e.message;
    }
  });
  $('#token-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-token').click(); });

  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t === tab);
      for (const name of ['question', 'rooms', 'server']) {
        const panel = $(`#tab-${name}`);
        if (panel) panel.classList.toggle('hidden', name !== tab.dataset.tab);
      }
      if (tab.dataset.tab === 'rooms' || tab.dataset.tab === 'server') refreshAll().then(renderAll).catch(() => {});
      if (tab.dataset.tab === 'question' && !state.preview && !state.rolePreview) newQuestion();
    });
  }

  $('#btn-generate').addEventListener('click', () => newQuestion());
  // 换模块/等级/难度/数量、切题目来源 → 直接出新题
  $('#bench-module').addEventListener('change', () => newQuestion());
  $('#bench-tier').addEventListener('change', () => newQuestion());
  $('#role-difficulty').addEventListener('change', () => newQuestion());
  $('#role-count').addEventListener('change', () => newQuestion());
  $('#q-source').addEventListener('change', () => {
    state.questionKind = $('#q-source').value;
    newQuestion();
  });
  $('#btn-check-all').addEventListener('click', () => runSelfCheck());
  $('#btn-refresh-rooms').addEventListener('click', () => refreshAll().then(renderAll));
  $('#auto-refresh').addEventListener('change', () => {
    if ($('#auto-refresh').checked) startAutoRefresh(); else stopAutoRefresh();
  });
}

function startAutoRefresh() {
  stopAutoRefresh();
  state.timer = setInterval(() => {
    if (document.hidden) return;
    refreshAll().then(renderAll).catch(() => {});
  }, 2000);
}
function stopAutoRefresh() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}

// ------------------------------------------------------------------ render
//
// 注意：这里会被 2 秒一次的自动刷新调用。**绝不能在刷新时重建下拉框并回写
// 选中的值**，否则玩家刚选的模块会被立刻改回上一题用的那个（"选不了别的模块"）。
// 只有在模块目录真的变了的时候才重建，而且重建后保留用户当前选中的项。
function renderAll() {
  if (!state.data) return;
  // 注意：题目/角色预览里有动画（闪光序列等），不能被 2 秒刷新重建，
  // 所以这里只更新服务器信息、房间列表和下拉框，不动预览区。
  renderModuleOptions();
  renderServer();
  renderRooms();
  renderReport();
}

function renderModuleOptions() {
  const sel = $('#bench-module');
  const signature = state.data.modules.map((m) => `${m.id}:${m.title}`).join('|');
  if (state.moduleOptionsSignature === signature) return;   // 目录没变就别碰 DOM
  state.moduleOptionsSignature = signature;
  const keep = sel.value;                                   // 保留用户当前的选择
  clear(sel);
  for (const m of state.data.modules) {
    sel.append(el('option', { value: m.id, text: `${m.icon} ${m.title}` }));
  }
  if (keep && state.data.modules.some((m) => m.id === keep)) sel.value = keep;
}

function renderServer() {
  const s = state.data.server;
  const box = $('#server-info');
  clear(box);
  const chip = (k, v) => el('div', { class: 'c' }, [el('span', { class: 'muted', text: `${k}：` }), el('b', { text: String(v) })]);
  const uptime = Math.floor(s.uptimeMs / 1000);
  box.append(
    chip('运行时长', `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${uptime % 60}s`),
    chip('Node', s.node),
    chip('房间数', s.rooms),
    chip('玩家数', `${s.players}（在线 ${s.connected}）`),
    chip('测试模式', s.testMode ? '是（--test）' : '否'),
    chip('临时题目缓存', s.previews),
  );
  const table = $('#diff-table');
  clear(table);
  table.append(el('tr', {}, ['难度', '模块数', '倒计时', '失误上限', '每次罚时', '手册'].map((h) => el('th', { text: h }))));
  for (const d of state.data.difficulties) {
    table.append(el('tr', {}, [
      el('td', { text: d.name }),
      el('td', { text: `${d.modules[0]}~${d.modules[1]}` }),
      el('td', { text: `${d.timeSec}s` }),
      el('td', { text: String(d.maxStrikes) }),
      el('td', { text: `-${d.timePenaltySec}s` }),
      el('td', { text: d.manualRows === 'partial' ? '拆成两半' : '完整' }),
    ]));
  }
  $('#admin-badge').classList.remove('hidden');
  $('#admin-badge').textContent = `已登录 · ${state.data.server.rooms} 个房间`;
}

function renderRooms() {
  const box = $('#rooms-list');
  const rooms = state.data.rooms || [];
  clear(box);
  if (!rooms.length) {
    box.append(el('div', { class: 'muted', text: '现在没有房间。' }));
    return;
  }
  for (const r of rooms) {
    const phaseText = { lobby: '准备中', playing: '进行中', ended: '已结束' }[r.phase] || r.phase;
    const card = el('div', { class: 'room-admin' });
    card.append(el('div', { class: 'ra-head' }, [
      el('span', { class: 'ra-code', text: r.code }),
      el('span', { class: `ra-phase ${r.phase}`, text: phaseText }),
      el('span', { class: 'muted small', text: `难度 ${r.difficulty}${r.moduleCount ? ` · ${r.solved}/${r.moduleCount} 模块` : ''}${r.phase === 'playing' ? ` · 剩余 ${fmtClock(r.remainingMs)}` : ''}` }),
      el('span', { class: 'muted small', text: `失误 ${r.strikes}${r.maxStrikes ? `/${r.maxStrikes}` : ''}` }),
      el('div', { class: 'ra-actions' }, [
        el('button', {
          class: 'small',
          text: '倒计时压到 10 秒',
          disabled: r.phase !== 'playing',
          onClick: () => adminAction({ type: 'setTime', room: r.code, ms: 10000 }, '已把倒计时改成 10 秒'),
        }),
        el('button', { class: 'small ghost', text: '关闭房间', onClick: () => closeRoom(r.code) }),
      ]),
    ]));
    const players = el('div', { class: 'ra-players' });
    for (const p of r.players) {
      players.append(el('span', { class: 'ra-player' + (p.connected ? '' : ' off') }, [
        el('span', { text: `${p.name}` }),
        el('span', { class: 'muted', text: p.role ? `（${p.role}）` : '（未选角色）' }),
        el('button', {
          class: 'tiny',
          text: '移出',
          onClick: () => adminAction({ type: 'kickPlayer', room: r.code, playerId: p.id }, `${p.name} 已被移出`),
        }),
      ]));
    }
    card.append(players);
    if (r.modules.length) {
      card.append(el('div', { class: 'ra-modules' }, r.modules.map((m) => el('span', {
        class: 'ra-module' + (m.status === 'solved' ? ' solved' : ''),
        text: `${m.status === 'solved' ? '✅' : '▫️'} ${m.title} L${m.tier}`,
      }))));
    }
    card.append(el('div', { class: 'ra-log muted small', text: (r.logTail || []).slice(-3).join(' ｜ ') }));
    box.append(card);
  }
}

async function adminAction(payload, okMessage) {
  try {
    await adminApi('/api/admin/action', payload);
    if (okMessage) toast(okMessage);
    await refreshAll();
    renderAll();
  } catch (e) {
    toast(e.message, 3000);
  }
}

async function closeRoom(code) {
  if (!confirm(`关闭房间 ${code}？里面的人会全部回到主界面。`)) return;
  await adminAction({ type: 'closeRoom', room: code }, `房间 ${code} 已关闭`);
}

// ------------------------------------------------------------------- bench
// ------------------------------------------------------- 出题与视角（合并页）

/** 每个视角的"该怎么玩"说明（角色面板上会显示）。 */
const ROLE_HELP = {
  defuser: '只能看到炸弹、能操作、看得到倒计时。把看到的一切念出来。',
  expert: '看不到炸弹，只有手册 + 外壳信息。查表、把指令说清楚。',
  blind: '和专家一样有手册，但只有一部分条目。把关键几行念出来，并问其他专家缺的部分。',
  mute: '能看炸弹、能操作，但不能说话。用文字频道打字告诉队友。',
  blindop: '🙈 只有模块的白色轮廓：颜色/数字/文字都看不见。但他能操作 —— 屏幕上的白色圆点就是他的光标。',
  deafsee: '🙉 看得见整颗炸弹（和拆弹者一样），也看得见他屏幕上的光标和信号 —— 但他听不见。他是转述的桥梁。',
  muteexp: '🙊 手册在他手上，但他不能说话，只能发信号/打字让聋桥猴看懂。',
  expert2: '第二个专家座位，拿的是手册的另一半。',
  truth: '整颗炸弹 + 每个模块的答案表。玩家看不到这一页，只用来核对"谁该看到什么"。',
};

/** 操作者 / 专家 / 其他视角的候选列表。 */
function viewChoices() {
  return [
    { key: 'operator', label: '🧰 操作者（拆弹者 / 盲操猴）', hint: '看炸弹、能动手的那一位' },
    { key: 'expert', label: '📖 专家（完整手册）', hint: '看不到炸弹，只有手册 + 外壳信息' },
    { key: 'blind', label: '🙈 盲眼观察员（半本手册）', hint: '手册只有一部分条目' },
    { key: 'mute', label: '🤐 静默操作员（能动手、不能说话）', hint: '只能用文字频道' },
    { key: 'blindop', label: '🙈 盲操猴（界面只有轮廓）', hint: '看不见颜色/数字/文字，但能操作' },
    { key: 'deafsee', label: '🙉 聋桥猴（看得见、听不见）', hint: '负责转述的桥梁' },
    { key: 'muteexp', label: '🙊 哑手册猴（有手册、不能说话）', hint: '只能发信号/打字' },
    { key: 'expert2', label: '📗 专家 II（另一半手册）', hint: '手册的另一半' },
    { key: 'truth', label: '🛠️ 真相（整颗炸弹 + 答案）', hint: '只给你自己核对用' },
  ];
}

function toggleView(key) {
  const cur = state.viewPick || [];
  state.viewPick = cur.includes(key) ? cur.filter((k) => k !== key) : cur.concat(key);
  renderQuestion();
}

function renderViewPicker() {
  const box = $('#view-picker');
  if (!box) return;
  clear(box);
  const cur = state.viewPick || [];
  for (const c of viewChoices()) {
    box.append(el('button', {
      class: 'role-tab' + (cur.includes(c.key) ? ' active' : ''),
      text: c.label,
      title: c.hint,
      onClick: () => toggleView(c.key),
    }));
  }
  box.append(el('button', {
    class: 'role-tab',
    text: '全选',
    onClick: () => { state.viewPick = viewChoices().map((c) => c.key); renderQuestion(); },
  }));
  box.append(el('button', {
    class: 'role-tab',
    text: '只留操作者+专家',
    onClick: () => { state.viewPick = ['operator', 'expert']; renderQuestion(); },
  }));
  box.append(el('a', { class: 'role-tab link', href: '/tutorial', target: '_blank', rel: 'noopener', text: '📖 打开教程' }));
}

/** 下拉框按题目来源切换显示。 */
function syncQuestionControls() {
  const kind = state.questionKind || 'module';
  const moduleLabel = $('#q-module-label');
  const tierLabel = $('#bench-tier')?.closest('label');
  const diffLabel = $('#q-diff-label');
  const countLabel = $('#q-count-label');
  if (moduleLabel) moduleLabel.style.display = kind === 'module' ? '' : 'none';
  if (tierLabel) tierLabel.style.display = kind === 'module' ? '' : 'none';
  if (diffLabel) diffLabel.style.display = kind === 'bomb' ? '' : 'none';
  if (countLabel) countLabel.style.display = kind === 'bomb' ? '' : 'none';
}

/** 重新出题（按当前来源）。 */
async function newQuestion() {
  const kind = state.questionKind || 'module';
  const status = $('#bench-status');
  if (status) status.textContent = kind === 'module' ? '正在生成题目…' : '正在生成整颗炸弹…';
  try {
    if (kind === 'module') {
      const res = await adminApi('/api/admin/action', {
        type: 'preview',
        module: $('#bench-module')?.value || 'wires',
        tier: Number($('#bench-tier')?.value || 3),
      });
      state.preview = res.preview;
    } else {
      const res = await adminApi('/api/admin/action', {
        type: 'rolePreview',
        difficulty: $('#role-difficulty')?.value || 'normal',
        moduleCount: Number($('#role-count')?.value || 4),
      });
      state.rolePreview = res.rolePreview;
    }
    if (status) status.textContent = '';
    renderQuestion();
  } catch (e) {
    if (status) status.textContent = '';
    toast(e.message, 3000);
  }
}

/** 题目里的交互（单模块出题时用）。 */
async function previewAct(uid, action) {
  try {
    const res = await adminApi('/api/admin/action', { type: 'previewAction', uid, action });
    if (res.preview) state.preview = res.preview;
    renderQuestion();
    const r = res.previewResult || {};
    if (r.solved) toast('这道题做对了 ✅');
    else if (r.strike) toast(`这道题会记一次失误：${r.note || ''}`, 3200);
    else if (r.benchNote) toast(r.benchNote, 4200);
    else if (r.note) toast(r.note, 2200);
  } catch (e) {
    toast(e.message, 3000);
  }
}

/** 主渲染：出题 + 选中的视角。 */
function renderQuestion() {
  syncQuestionControls();
  renderViewPicker();
  const body = $('#bench-body');
  if (!body) return;
  clear(body);

  const kind = state.questionKind || 'module';
  const picks = state.viewPick || [];

  if (kind === 'module') {
    const pv = state.preview;
    if (!pv) {
      body.append(el('div', { class: 'panel muted', text: '点「换一道题」生成一个模块题目。' }));
      return;
    }
    const grid = el('div', { class: 'bench-grid' });
    if (picks.includes('operator') || !picks.length) {
      grid.append(moduleViewPanel(pv, '🧰 操作者看到的题目（可以直接点着玩）', (uid, action) => previewAct(uid, action)));
    }
    if (picks.includes('expert')) grid.append(moduleManualPanel(pv, '📖 专家看到的手册（同一道题）'));
    if (picks.includes('blindop')) grid.append(blindViewPanel(pv));
    if (picks.includes('truth')) grid.append(truthForModule(pv));
    for (const k of ['blind', 'mute', 'deafsee', 'muteexp', 'expert2']) {
      if (picks.includes(k)) grid.append(roleNotice(k));
    }
    body.append(grid);
    return;
  }

  // 整颗炸弹：每个选中的角色一栏
  const rp = state.rolePreview;
  if (!rp) {
    body.append(el('div', { class: 'panel muted', text: '点「换一道题」生成一颗炸弹。' }));
    return;
  }
  body.append(el('div', { class: 'panel' }, [
    el('div', { class: 'bench-heading', text: `炸弹外壳（${rp.difficulty} · ${rp.modules.length} 个模块）` }),
    el('div', { class: 'casing' }, [
      el('div', { class: 'c' }, [el('span', { class: 'muted', text: '序列号：' }), el('b', { text: rp.casing.serial })]),
      el('div', { class: 'c' }, [el('span', { class: 'muted', text: '电池：' }), el('b', { text: String(rp.casing.batteries) })]),
      el('div', { class: 'c' }, [el('span', { class: 'muted', text: '指示灯：' }), el('b', { text: rp.casing.indicators.join(' ') || '无' })]),
      el('div', { class: 'c' }, [el('span', { class: 'muted', text: '端口：' }), el('b', { text: rp.casing.ports.join(' / ') || '无' })]),
    ]),
    el('div', { class: 'ra-modules' }, rp.modules.map((m) => el('span', { class: 'ra-module', text: `${m.icon} ${m.title} L${m.tier}` }))),
  ]));

  const grid = el('div', { class: 'bench-grid' });
  const byKey = Object.fromEntries(rp.views.map((v) => [v.key, v]));
  for (const key of picks) {
    if (key === 'operator') {
      grid.append(roleViewPanel(byKey.defuser, rp));
      // 操作者那一栏 + 盲操猴那一栏，方便对照"他摸到的"和"实际是什么"
      grid.append(roleViewPanel(byKey.blindop, rp));
    } else if (key === 'truth') {
      grid.append(renderTruthPanel(byKey.truth));
    } else if (byKey[key]) {
      grid.append(roleViewPanel(byKey[key], rp));
    }
  }
  if (!picks.length) grid.append(el('div', { class: 'panel muted', text: '上面至少选一个视角。' }));
  body.append(grid);
}

/** 单模块：操作者视角（可交互）。 */
function moduleViewPanel(pv, title, onAction) {
  const col = el('div', { class: 'panel bench-col' }, [
    el('div', { class: 'bench-heading' }, [
      el('span', { text: title }),
      el('span', { class: 'mc-tag', text: `${pv.icon} ${pv.module} L${pv.tier}` }),
      pv.state.status === 'solved' ? el('span', { class: 'mc-tag', style: { color: '#7dffa8', borderColor: '#2b6b42' }, text: '已做对' }) : null,
    ]),
  ]);
  const wrap = el('div', { class: 'modules' });
  wrap.append(renderPreviewModule(pv.state, onAction, {}));
  col.append(wrap);
  if (pv.state.note) col.append(el('div', { class: 'mod-note', text: `最近操作：${pv.state.note}` }));
  if (pv.asks?.length) {
    col.append(el('div', { class: 'asks' }, [el('span', { text: '这题玩家必须问到：' })].concat(pv.asks.map((a) => el('span', { text: a })))));
  }
  return col;
}

/** 单模块：专家视角（同一道题的手册）。 */
function moduleManualPanel(pv, title) {
  const col = el('div', { class: 'panel bench-col' }, [el('div', { class: 'bench-heading', text: title })]);
  const host = el('div');
  col.append(host);
  renderManual(host, {
    state: {
      bomb: { moduleStates: [pv.state], moduleCount: 1, difficulty: 'normal' },
      manual: pv.manual,
      strikes: 0,
      maxStrikes: 3,
      room: { phase: 'playing', difficulty: 'normal' },
    },
  });
  return col;
}

/** 单模块：盲操猴视角（只有轮廓）。 */
function blindViewPanel(pv) {
  const col = el('div', { class: 'panel bench-col' }, [
    el('div', { class: 'bench-heading' }, [
      el('span', { text: '🙈 盲操猴看到的（只有轮廓）' }),
    ]),
    el('div', { class: 'muted small', text: '颜色/数字/文字都不存在；只有形状和倒计时。点形状就能操作。' }),
  ]);
  const wrap = el('div', { class: 'modules' });
  // 用同一个模块状态，但按"盲操"的渲染路径画剪影
  const stub = {
    uid: pv.state.uid, id: pv.state.id, tier: pv.state.tier, title: pv.state.title,
    icon: pv.state.icon, status: 'active', state: pv.state.state, note: '',
  };
  wrap.append(renderPreviewModule(stub, (uid, action) => previewAct(uid, action), { blind: true }));
  col.append(wrap);
  return col;
}

/** 单模块：题目 + 答案（真相）。 */
function truthForModule(pv) {
  const col = el('div', { class: 'panel bench-col' }, [
    el('div', { class: 'bench-heading' }, [el('span', { text: '🛠️ 真相（题目 + 答案）' })]),
    el('div', { class: 'muted small', text: '玩家看不到这一页。用来核对上面的视角有没有漏给或多给信息。' }),
  ]);
  const pre = el('pre', { class: 'truth-json' });
  pre.textContent = JSON.stringify({ 题目: pv.state.state, 答案: pv.manual?.sections?.[0]?.groups?.filter((g) => g.kind === 'table').flatMap((g) => g.rows || []).slice(0, 12) }, null, 2);
  col.append(pre);
  return col;
}

/** 其他角色的说明卡（单模块出题时，这些角色没有独立题面）。 */
function roleNotice(key) {
  const c = viewChoices().find((x) => x.key === key) || { label: key, hint: '' };
  return el('div', { class: 'panel bench-col' }, [
    el('div', { class: 'bench-heading', text: c.label }),
    el('div', { class: 'muted small', text: `${c.hint}。单模块出题时这个角色没有独立题面 —— 换成「整颗炸弹」就能看到他的完整视角。` }),
  ]);
}

// ------------------------------------------------------- 角色视角（整颗炸弹）

/** 单个角色的视角面板。 */
function roleViewPanel(v, rp, solo = false) {
  if (!v) return el('div');
  // 聋桥猴要看"整颗炸弹"（他是转述的人，得跟拆弹者看到同一画面）
  const wholeBomb = v.key === 'deafsee';
  const col = el('div', { class: 'panel bench-col' + (solo ? ' role-solo' : '') + (wholeBomb ? ' role-wide' : '') }, [
    el('div', { class: 'bench-heading' }, [
      el('span', { text: `${v.roleIcon || ''} ${v.roleName}` }),
      v.canInteract !== undefined ? el('span', { class: 'mc-tag', text: v.canInteract ? '能操作' : '不能操作' }) : null,
      v.canSeeTime !== undefined ? el('span', { class: 'mc-tag', text: v.canSeeTime ? '看得到倒计时' : '没有倒计时' }) : null,
      v.canManual ? el('span', { class: 'mc-tag', text: v.manualRows === 'partial' ? '半本手册' : '完整手册' }) : null,
      v.vision === 'blind' ? el('span', { class: 'mc-tag', text: '画面只有轮廓' }) : null,
      wholeBomb ? el('span', { class: 'mc-tag', text: `整颗炸弹 · ${v.moduleStates.length} 个模块` }) : null,
    ]),
    el('div', { class: 'muted small', text: ROLE_HELP[v.key] || '' }),
  ]);
  if (v.seesBomb) {
    const wrap = el('div', { class: 'modules' });
    const list = wholeBomb ? v.moduleStates : v.moduleStates.slice(0, 1);
    for (const m of list) {
      const card = renderPreviewModule({ ...m, status: 'active' }, () => {}, { blind: v.vision === 'blind' });
      // 盲操者的光标：叠在他正在操作的那个模块上
      const ghost = state.teammateCursor;
      if (ghost && ghost.uid === m.uid) card.append(cursorDot(ghost));
      wrap.append(card);
    }
    col.append(wrap);
    if (!wholeBomb && v.moduleStates.length > 1) {
      col.append(el('div', { class: 'muted small', text: `（这颗炸弹共 ${v.moduleStates.length} 个模块，这里演示第一个）` }));
    }
  } else if (v.canManual) {
    const host = el('div');
    col.append(host);
    renderManual(host, {
      state: {
        bomb: { moduleStates: v.moduleStates, moduleCount: v.moduleStates.length, difficulty: rp.difficulty },
        manual: v.manual,
        strikes: 0,
        maxStrikes: 3,
        room: { phase: 'playing', difficulty: rp.difficulty },
      },
    });
  } else {
    col.append(el('div', { class: 'muted', text: '这个角色没有手册。' }));
  }
  return col;
}

/** 队友（盲操猴）的光标小圆点，按归一化坐标落在模块卡片上。 */
function cursorDot(cursor) {
  const dot = el('span', {
    class: 'ghost-cursor',
    style: { left: `${Math.round((cursor.x || 0) * 100)}%`, top: `${Math.round((cursor.y || 0) * 100)}%` },
    title: `${cursor.name || '队友'} 的光标`,
  });
  dot.append(el('span', { class: 'ghost-cursor-label', text: `${cursor.name || '队友'} 的手` }));
  return dot;
}

/** 真相页：整颗炸弹的题目 + 答案。 */
function renderTruthPanel(v) {
  const left = el('div', { class: 'panel bench-col' }, [
    el('div', { class: 'bench-heading' }, [el('span', { text: `${v.icon} ${v.name}` })]),
    el('div', { class: 'muted small', text: v.note }),
  ]);
  for (const m of v.moduleStates) {
    const wrap = el('div', { class: 'modules' });
    wrap.append(renderTruthModule(m));
    left.append(wrap);
  }
  return left;
}

/** 真相页的一个模块：题目 + 答案。 */
function renderTruthModule(m) {
  const wrap = el('div', { class: 'module' });
  wrap.append(el('div', { class: 'mod-head' }, [
    el('span', { class: 'mh-icon', text: m.icon }),
    el('span', { class: 'mh-title', text: m.title }),
    el('span', { class: 'tier', text: `等级 ${m.tier}` }),
  ]));
  const body = el('div', { class: 'mod-body' });
  wrap.append(body);
  body.append(renderPreviewModule({ ...m, status: 'active' }, () => {}, {}));
  return wrap;
}

async function runSelfCheck() {
  const status = $('#bench-status');
  status.textContent = '正在逐个模块检查（13 个模块 × 5 个等级）…';
  try {
    const res = await adminApi('/api/admin/action', { type: 'selfCheck' });
    state.report = res.report;
    status.textContent = '';
    renderReport();
    const { ok, checked } = res.report;
    toast(ok === checked ? `全部通过：${checked} 道题都正常 ✅` : `发现 ${checked - ok} 个问题`, 4000);
  } catch (e) {
    status.textContent = '';
    toast(e.message, 3000);
  }
}

function renderReport() {
  const box = $('#check-report');
  const rep = state.report;
  clear(box);
  if (!rep) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  const allOk = rep.problems.length === 0;
  box.append(el('div', { class: 'check-title' + (allOk ? ' ok' : ' bad') }, [
    el('span', { text: allOk ? '✅ 全量自检通过' : `⚠️ 全量自检发现 ${rep.problems.length} 个问题` }),
    el('span', { class: 'muted small', text: `共检查 ${rep.checked} 道题（每个模块 × 5 个等级）：题目状态、手册规则块、空表格、迷宫墙一致性、键盘唯一解` }),
  ]));
  if (!allOk) {
    const list = el('div', { class: 'check-list' });
    for (const p of rep.problems) {
      list.append(el('div', { class: 'check-item' }, [
        el('span', { text: `${p.module}（等级 ${p.tier}）：` }),
        el('span', { class: 'muted', text: p.issues.join('；') }),
      ]));
    }
    box.append(list);
  }
}

function $(sel) { return document.querySelector(sel); }

boot();
