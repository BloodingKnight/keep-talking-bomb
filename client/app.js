// Client application: session wiring, lobby, in-game HUD, chat, end screen.

import { el, clear, $, fmtClock, toast } from './dom.js';
import { renderBomb, renderPreviewModule } from './bomb.js';
import { renderManual } from './manual.js';
import { inviteUrl, inviteQrSvg } from './invite.js';

const ROLE_FALLBACK = {
  defuser: { name: '拆弹者', icon: '🧰', tagline: '看着炸弹，动手操作', hint: '把看到的一切念出来，按专家的指令动手。' },
  expert: { name: '专家', icon: '📖', tagline: '拥有手册，看不到炸弹', hint: '负责查表、算答案、告诉拆弹者做什么。' },
  blind: { name: '盲眼观察员', icon: '🙈', tagline: '只有半本手册', hint: '和其他专家拼信息，一起补全规则。' },
  mute: { name: '静默操作员', icon: '🤐', tagline: '能操作，不能说话', hint: '只能打字交流，用文字频道告诉队友你看到了什么。' },
  expert2: { name: '专家 II', icon: '📗', tagline: '手册的另外半本', hint: '和其他专家拼信息。' },
  expert3: { name: '专家 III', icon: '📘', tagline: '手册的另外半本', hint: '和其他专家拼信息。' },
};

const app = {
  playerId: null,
  roomCode: null,
  state: null,
  rev: -1,
  selectedPlayer: null,
  catalog: { difficulties: [], roles: [] },
  es: null,
  reconnects: 0,
  lastModuleUids: new Set(),
  renderKey: '',
  preview: null,
  previewTouched: false,
};

// ------------------------------------------------------------------ helpers

// 静态托管（EdgeOne Pages / GitHub Pages）时，页面和 API 不同源：
//   用  index.html?server=https://xxx.trycloudflare.com  打开一次，地址会记住
// 同源部署（直接跑 server.js / 单文件 exe）时 API_BASE 为空，行为和以前完全一样。
const SERVER_KEY = 'bomb:server';

function normalizeServer(raw) {
  const v = String(raw || '').trim();
  if (!v) return '';
  const withScheme = /^https?:\/\//i.test(v) ? v : `http://${v}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.origin;
  } catch {
    return '';
  }
}

function resolveServer() {
  const url = new URL(location.href);
  const fromQuery = normalizeServer(url.searchParams.get('server'));
  if (fromQuery) {
    try { localStorage.setItem(SERVER_KEY, fromQuery); } catch { /* private mode */ }
    return fromQuery;
  }
  try {
    return normalizeServer(localStorage.getItem(SERVER_KEY));
  } catch {
    return '';
  }
}

const API_BASE = resolveServer();
const apiUrl = (p) => `${API_BASE}${p}`;

async function api(path, body) {
  const res = await fetch(apiUrl(path), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
  return data;
}

function setLinkStatus(ok) {
  $('#link-badge').classList.toggle('hidden', ok);
}

function storeSession(code, id, name) {
  app.roomCode = code;
  app.playerId = id;
  try {
    sessionStorage.setItem('bomb:session', JSON.stringify({ code, id, name }));
  } catch { /* private mode */ }
  const url = new URL(location.href);
  url.searchParams.set('room', code);
  history.replaceState(null, '', url);
}

function restoreSession() {
  let saved = null;
  try { saved = JSON.parse(sessionStorage.getItem('bomb:session') || 'null'); } catch { saved = null; }
  const url = new URL(location.href);
  const room = url.searchParams.get('room');
  const player = url.searchParams.get('player');
  if (room && player) return { code: room, id: player, name: saved?.name || '' };
  if (saved && (!room || room === saved.code)) return saved;
  if (room) return { code: room, id: null, name: saved?.name || '' };
  return null;
}

// -------------------------------------------------------------------- stream
function subscribe() {
  if (app.es) { try { app.es.close(); } catch { /* ignore */ } }
  const url = `${apiUrl('/api/events')}?room=${encodeURIComponent(app.roomCode)}&player=${encodeURIComponent(app.playerId)}`;
  const es = new EventSource(url);
  app.es = es;
  es.onopen = () => { app.reconnects = 0; setLinkStatus(true); };
  es.onmessage = (ev) => {
    try {
      const payload = JSON.parse(ev.data);
      applyState(payload.state, payload.rev);
    } catch (e) { console.warn('bad event', e); }
  };
  es.addEventListener('closed', (ev) => {
    let reason = 'closed';
    try { reason = JSON.parse(ev.data).reason || reason; } catch { /* ignore */ }
    onRoomClosed(reason);
  });
  es.onerror = () => {
    setLinkStatus(false);
    app.reconnects++;
    if (app.reconnects > 12) { try { es.close(); } catch { /* ignore */ } setTimeout(subscribe, 2500); }
  };
}

function applyState(state, rev) {
  if (rev !== undefined && rev < app.rev) return;
  app.rev = rev ?? app.rev;
  app.state = state;
  render();
}

// --------------------------------------------------------------------- exit
function clearSession() {
  app.state = null;
  app.rev = -1;
  app.roomCode = null;
  app.playerId = null;
  app.lastModuleUids = new Set();
  app.selectedPlayer = null;
  app.renderKey = '';
  try { sessionStorage.removeItem('bomb:session'); } catch { /* ignore */ }
  if (app.es) { try { app.es.close(); } catch { /* ignore */ } app.es = null; }
  const url = new URL(location.href);
  url.searchParams.delete('room');
  url.searchParams.delete('player');
  history.replaceState(null, '', url.pathname + (url.search ? url.search : ''));
  $('#room-badge').classList.add('hidden');
  $('#role-badge').classList.add('hidden');
  $('#btn-leave-top').classList.add('hidden');
  $('#btn-close-top').classList.add('hidden');
  setLinkStatus(true);
}

function leaveRoom() {
  if (!app.roomCode) { clearSession(); showStage('join'); return; }
  if (app.state && app.state.room.phase === 'playing') {
    if (!confirm('游戏还在进行中。退出后这个座位会保留一小段时间，你可以刷新页面重连回来。现在退出吗？')) return;
  }
  // 服务端会回一条 closed 事件，由 onRoomClosed 统一收尾
  send({ type: 'leave' }).then(() => {
    setTimeout(() => { if (app.roomCode) onRoomClosed('left'); }, 400);
  });
}

async function closeRoom() {
  if (!app.state || app.state.room.hostId !== app.playerId) return;
  if (!confirm('关闭房间会把所有人请回主界面，确定吗？')) return;
  const res = await send({ type: 'closeRoom' });
  if (res && res.closed) {
    clearSession();
    showStage('join');
    toast('房间已关闭');
  }
}

function onRoomClosed(reason) {
  clearSession();
  showStage('join');
  toast({ closed: '房主关闭了房间', kicked: '你被移出了房间', left: '已退出房间' }[reason] || '房间已关闭', 3000);
}

// --------------------------------------------------------------------- boot
async function boot() {
  bindJoin();
  bindLobby();
  bindGame();
  bindEnd();
  loadCatalog();
  const saved = restoreSession();
  if (saved && saved.code) {
    try {
      const res = await api('/api/join', { room: saved.code, name: saved.name || '玩家', playerId: saved.id });
      storeSession(res.roomCode, res.playerId, saved.name || '');
      subscribe();
      startTicker();
      return;
    } catch (e) {
      $('#join-error').textContent = `无法恢复上次的房间（${e.message}），请重新加入。`;
      $('#join-room').value = saved.code;
    }
  }
  showStage('join');
  startTicker();
}

async function loadCatalog() {
  try {
    const res = await fetch(apiUrl('/api/rooms')).then((r) => r.json());
    if (!res || !Array.isArray(res.rooms)) throw new Error('服务器返回的内容不认识');
    app.catalog = res;
    const sel = $('#set-difficulty');
    clear(sel);
    for (const d of res.difficulties) sel.append(el('option', { value: d.id, text: `${d.name} · ${d.timeSec}s · ${d.maxStrikes} 次失误` }));
    sel.value = 'normal';
    updateDiffDesc();
    renderRoomList(res.rooms);
  } catch (e) {
    // 静态托管但没配置服务端地址（或服务端没开）：给一个填地址的界面，而不是白屏
    showServerGate(e);
  }
}

async function showServerGate(err) {
  const gate = $('#server-gate');
  if (!gate) return;
  gate.classList.remove('hidden');
  for (const id of ['stage-join', 'stage-lobby', 'stage-game', 'stage-end']) {
    document.getElementById(id)?.classList.add('hidden');
  }
  const hint = $('#gate-hint');
  if (hint) {
    hint.textContent = API_BASE
      ? `连不上 ${API_BASE}（${err && err.message ? err.message : '网络错误'}）。检查房主那边的游戏是不是在跑、地址对不对。`
      : '这个页面是静态托管版，需要告诉它房主的游戏地址。';
  }
  const input = $('#gate-server');
  if (input && !input.value) input.value = API_BASE || '';
  const go = $('#gate-go');
  if (go && !go.dataset.bound) {
    go.dataset.bound = '1';
    go.addEventListener('click', () => {
      const server = normalizeServer(input.value);
      if (!server) {
        $('#gate-hint').textContent = '地址看起来不对，应该像 http://192.168.1.7:3210 或 https://xxx.trycloudflare.com';
        return;
      }
      try { localStorage.setItem(SERVER_KEY, server); } catch { /* ignore */ }
      const url = new URL(location.href);
      url.searchParams.set('server', server);
      location.replace(url.toString());
    });
    input?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') go.click();
    });
  }
}

function renderRoomList(rooms) {
  const box = $('#room-list');
  clear(box);
  if (!rooms || !rooms.length) {
    box.append(el('div', { class: 'muted', text: '暂无房间，直接点「加入 / 新建」就会开一个。' }));
    return;
  }
  for (const r of rooms) {
    box.append(el('div', {
      class: 'room-item',
      onClick: () => { $('#join-room').value = r.code; toast(`已填入房间号 ${r.code}`); },
    }, [
      el('span', { text: `房间 ${r.code}` }),
      el('span', { class: 'muted', text: `${r.difficulty} · ${r.players} 人 · ${r.phase === 'lobby' ? '准备中' : r.phase === 'playing' ? '进行中' : '已结束'}` }),
    ]));
  }
}

// --------------------------------------------------------------------- join
function bindJoin() {
  $('#btn-join').addEventListener('click', doJoin);
  $('#join-room').addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });
  $('#join-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });
}

async function doJoin() {
  const name = $('#join-name').value.trim() || '玩家';
  const room = $('#join-room').value.trim().toUpperCase();
  const err = $('#join-error');
  err.textContent = '';
  try {
    let res;
    if (room) res = await api('/api/join', { room, name });
    else res = await api('/api/create', { name, difficulty: $('#set-difficulty').value || 'normal' });
    storeSession(res.roomCode, res.playerId, name);
    subscribe();
    startTicker();
  } catch (e) {
    err.textContent = e.message;
  }
}

function showStage(which) {
  for (const id of ['stage-join', 'stage-lobby', 'stage-game', 'stage-end', 'stage-bench']) {
    const node = $(`#${id}`);
    if (node) node.classList.toggle('hidden', id !== `stage-${which}`);
  }
  if (which === 'join') {
    $('#room-badge').classList.add('hidden');
    $('#role-badge').classList.add('hidden');
    loadCatalog();
  }
}

// --------------------------------------------------- host module test bench
const MODULE_TITLES = {
  wires: '线缆', button: '按钮', keypad: '符号键盘', simon: '闪光序列', memory: '记忆',
  morse: '摩斯电码', maze: '迷宫', password: '密码', quiz: '逻辑问答',
  gears: '齿轮传动', balance: '天平配重', decoder: '十进制解码', signal: '三色信号灯',
  wires2: '复杂线路', capacitor: '电容放电', safeknob: '保险柜旋钮', letterpad: '字母键盘', simon2: '双序列闪光',
};

function openBench() {
  if (!app.state || app.state.room.hostId !== app.playerId) return toast('只有房主可以测试模块');
  showStage('bench');
  renderBench();
  if (!app.preview || !app.preview.state) generatePreview();
}

function closeBench() {
  if (app.state) {
    showStage(app.state.room.phase === 'ended' ? 'end' : 'lobby');
    render(true);
  } else {
    showStage('join');
  }
}

async function generatePreview() {
  const modId = $('#bench-module').value || 'wires';
  const tier = Number($('#bench-tier').value || 3);
  const box = $('#bench-body');
  if (box) { clear(box); box.append(el('div', { class: 'muted', text: '正在生成题目…' })); }
  try {
    const res = await send({ type: 'preview', module: modId, tier });
    if (res && res.preview) {
      app.preview = res.preview;
      app.previewTouched = false;
      renderBench();
    }
  } catch { /* send already toasts */ }
}

/** 测试台里的交互：走服务端，但不影响真正的炸弹。 */
async function previewAct(uid, action) {
  try {
    const res = await send({ type: 'previewAction', uid, action });
    if (res && res.preview) {
      app.preview = res.preview;
      app.previewTouched = true;
      renderBench();
    }
    if (res && res.previewResult && res.previewResult.solved) toast('这道题做对了 ✅');
    else if (res && res.previewResult && res.previewResult.strike) toast(`这道题会记一次失误：${res.previewResult.note || ''}`, 3000);
    else if (res && res.previewResult && res.previewResult.note) toast(res.previewResult.note, 2200);
  } catch { /* send already toasts */ }
}

function renderBench() {
  const pv = app.preview;
  const head = $('#bench-head');
  const body = $('#bench-body');
  if (!head || !body) return;
  clear(head);
  clear(body);

  head.append(el('div', { class: 'row wrap' }, [
    el('div', {}, [
      el('div', { class: 'bench-title' }, [
        el('span', { text: pv ? `${pv.icon} ${pv.module}` : '还没有题目' }),
        pv ? el('span', { class: 'mc-tag', text: `等级 ${pv.tier}` }) : null,
        pv && pv.state.status === 'solved' ? el('span', { class: 'mc-tag', style: { color: '#7dffa8', borderColor: '#2b6b42' }, text: '已做对' }) : null,
      ]),
      el('div', { class: 'muted small', text: '这里是"看得见的真相"：左边是拆弹者看到的题目，右边是专家看到的手册。玩家本来只能看到其中一半。' }),
    ]),
    el('div', { class: 'row wrap', style: { marginTop: '0' } }, [
      el('select', {
        id: 'bench-module',
        style: { width: 'auto', margin: '0' },
        onChange: () => generatePreview(),
      }, Object.entries(MODULE_TITLES).map(([id, name]) => {
        const opt = el('option', { value: id, text: name });
        if (pv && pv.moduleId === id) opt.selected = true;
        return opt;
      })),
      el('select', {
        id: 'bench-tier',
        style: { width: 'auto', margin: '0' },
        onChange: () => generatePreview(),
      }, [1, 2, 3, 4, 5].map((t) => {
        const opt = el('option', { value: String(t), text: `等级 ${t}` });
        if (pv && pv.tier === t) opt.selected = true;
        return opt;
      })),
      el('button', { class: 'primary', text: '换一道题', onClick: () => generatePreview() }),
      el('button', { text: '返回准备区', onClick: () => closeBench() }),
    ]),
  ]));

  if (!pv || !pv.state) {
    body.append(el('div', { class: 'panel muted', text: '点「换一道题」生成一个模块。' }));
    return;
  }

  // 左：拆弹者视角
  const left = el('div', { class: 'panel bench-col' }, [
    el('div', { class: 'bench-heading', text: '🧰 拆弹者看到的题目' }),
    el('div', { class: 'muted small', text: '这里可以真的点着玩：拆对了会给"已做对"，做错了会给"会记一次失误"。' }),
  ]);
  const wrap = el('div', { class: 'modules' });
  wrap.append(renderPreviewModule(pv.state, (uid, action) => previewAct(uid, action)));
  left.append(wrap);
  if (pv.state.note) left.append(el('div', { class: 'mod-note', text: `最近操作：${pv.state.note}` }));
  if (pv.asks && pv.asks.length) {
    left.append(el('div', { class: 'asks' }, [el('span', { text: '这题需要问到的信息：' })].concat(pv.asks.map((a) => el('span', { text: a })))));
  }

  // 右：专家视角（同一道题对应的手册）
  const state = {
    bomb: { moduleStates: [{ ...pv.state, status: pv.state.status }], moduleCount: 1, difficulty: 'normal' },
    manual: pv.manual,
    strikes: 0,
    maxStrikes: 3,
    room: { phase: 'playing', difficulty: 'normal' },
  };
  const right = el('div', { class: 'panel bench-col' }, [
    el('div', { class: 'bench-heading', text: '📖 专家看到的手册（同一道题）' }),
  ]);
  const manualHost = el('div');
  right.append(manualHost);
  renderManual(manualHost, { state });
  body.append(el('div', { class: 'bench-grid' }, [left, right]));
}

// -------------------------------------------------------------------- lobby
function bindLobby() {
  $('#btn-autoassign').addEventListener('click', () => send({ type: 'autoAssign' }));
  $('#btn-start').addEventListener('click', () => send({ type: 'start' }));
  $('#btn-copy-link').addEventListener('click', copyInvite);
  $('#btn-leave').addEventListener('click', leaveRoom);
  $('#btn-close-room').addEventListener('click', closeRoom);
  $('#btn-leave-top').addEventListener('click', leaveRoom);
  $('#btn-close-top').addEventListener('click', closeRoom);
  $('#btn-kick').addEventListener('click', () => {
    if (!app.selectedPlayer) return toast('先点一下要移除的玩家');
    send({ type: 'kick', targetId: app.selectedPlayer });
    app.selectedPlayer = null;
  });
  $('#set-difficulty').addEventListener('change', () => { updateDiffDesc(); hostConfigure(); });
  $('#btn-bench').addEventListener('click', openBench);
  $('#set-modules').addEventListener('change', hostConfigure);
  $('#set-manual').addEventListener('change', hostConfigure);
  $('#lobby-chat-form').addEventListener('submit', (e) => { e.preventDefault(); sendChat('#lobby-chat-input'); });
}

function updateDiffDesc() {
  const id = $('#set-difficulty').value;
  const d = (app.catalog.difficulties || []).find((x) => x.id === id);
  $('#diff-desc').textContent = d ? `${d.desc} · 模块 ${d.modules[0]}~${d.modules[1]} 个 · 倒计时 ${d.timeSec} 秒 · 失误上限 ${d.maxStrikes} · 每次失误 −${d.timePenaltySec} 秒` : '';
}

function hostConfigure() {
  if (!app.state || app.state.room.hostId !== app.playerId) return;
  send({
    type: 'configure',
    difficulty: $('#set-difficulty').value,
    moduleCount: $('#set-modules').value ? Number($('#set-modules').value) : null,
    manualRows: $('#set-manual').value || null,
  });
}

function renderLobby() {
  const st = app.state;
  const room = st.room;
  $('#room-badge').classList.remove('hidden');
  $('#room-badge').textContent = `房间 ${room.code}`;
  $('#role-badge').classList.remove('hidden');
  $('#role-badge').textContent = st.you.role ? `${st.you.roleInfo.icon} ${st.you.roleInfo.name}` : '未选角色';
  $('#lobby-count').textContent = `${room.players.length} 人`;

  // players
  const box = $('#lobby-players');
  clear(box);
  for (const p of room.players) {
    const info = ROLE_FALLBACK[p.role] || {};
    const row = el('div', {
      class: 'player-row' + (app.selectedPlayer === p.id ? ' selected' : ''),
      onClick: () => { app.selectedPlayer = app.selectedPlayer === p.id ? null : p.id; renderLobby(); },
    }, [
      el('span', { class: 'dot' + (p.connected ? '' : ' off') }),
      el('span', { class: 'pname', text: p.name + (p.id === room.hostId ? '（房主）' : '') + (p.id === app.playerId ? '（你）' : '') }),
      el('span', { class: 'prole', text: p.role ? `${info.icon || ''} ${info.name || p.role}` : '未选角色' }),
    ]);
    box.append(row);
  }
  $('#btn-kick').classList.toggle('hidden', room.hostId !== app.playerId);
  $('#btn-close-room').classList.toggle('hidden', room.hostId !== app.playerId);
  $('#btn-leave-top').classList.remove('hidden');
  $('#btn-close-top').classList.toggle('hidden', room.hostId !== app.playerId);

  renderInvite();

  // role cards
  const cards = $('#role-cards');
  clear(cards);
  const takenBy = {};
  for (const p of room.players) if (p.role && p.id !== app.playerId) takenBy[p.role] = p;
  const roles = (app.catalog.roles && app.catalog.roles.length ? app.catalog.roles : Object.keys(ROLE_FALLBACK).slice(0, 4).map((id) => ({ id, ...ROLE_FALLBACK[id] })));
  for (const r of roles) {
    const info = { ...ROLE_FALLBACK[r.id], ...r };
    const mine = st.you.role === r.id;
    const taken = takenBy[r.id];
    const card = el('div', {
      class: 'role-card' + (mine ? ' active' : '') + (taken ? ' taken' : ''),
      onClick: () => {
        if (taken) return toast(`${info.name} 已被 ${taken.name} 选了`);
        send({ type: 'role', role: r.id });
      },
    }, [
      el('div', { class: 'rc-name' }, [el('span', { text: info.icon }), el('span', { text: info.name })]),
      el('div', { class: 'rc-tag', text: taken ? `${taken.name} 已选` : info.tagline }),
      el('div', { class: 'rc-hint', text: info.hint || '' }),
    ]);
    cards.append(card);
  }

  // 角色预设：三人经典配置一键套用
  const presetBox = $('#role-presets');
  if (presetBox) {
    clear(presetBox);
    const isHost = room.hostId === app.playerId;
    for (const preset of app.catalog.presets || []) {
      presetBox.append(el('button', {
        class: 'small',
        text: preset.name,
        title: preset.desc,
        disabled: !isHost || room.players.length < preset.roles.length,
        onClick: () => send({ type: 'preset', preset: preset.id }),
      }));
    }
  }

  // settings
  const isHost = room.hostId === app.playerId;
  const diffSel = $('#set-difficulty');
  if (!isHost) diffSel.disabled = true; else diffSel.disabled = false;
  if (document.activeElement !== diffSel) diffSel.value = room.difficulty;
  const modInput = $('#set-modules');
  modInput.disabled = !isHost;
  if (document.activeElement !== modInput) modInput.value = room.moduleCount || '';
  const manualSel = $('#set-manual');
  manualSel.disabled = !isHost;
  if (document.activeElement !== manualSel) manualSel.value = room.manualRows || '';
  updateDiffDesc();

  const diff = (app.catalog.difficulties || []).find((d) => d.id === room.difficulty);
  $('#lobby-modules').textContent = st.bomb ? '' : (diff ? `这一局将生成 ${room.moduleCount || `${diff.modules[0]}~${diff.modules[1]}`} 个模块，倒计时 ${diff.timeSec} 秒。` : '');

  const hasDefuser = room.players.some((p) => p.role === 'defuser' || p.role === 'mute');
  const hasExpert = room.players.some((p) => p.role && p.role !== 'defuser' && p.role !== 'mute');
  $('#btn-start').disabled = !(isHost && hasDefuser && hasExpert);
  $('#lobby-error').textContent = !hasDefuser ? '至少需要一名拆弹者或静默操作员。' : !hasExpert ? '至少需要一名专家来读手册。' : !isHost ? '等待房主开始游戏。' : '';

  renderChat($('#lobby-chat'));
}

function copyInvite() {
  const url = inviteUrl({ network: app.catalog.network, roomCode: app.roomCode, origin: location.origin, server: API_BASE });
  navigator.clipboard?.writeText(url).then(
    () => toast('邀请链接已复制，发给队友即可'),
    () => toast(`邀请链接：${url}`, 5000),
  );
}

let inviteRenderedFor = '';

function renderInvite() {
  const card = $('#invite-card');
  const box = $('#invite-qr');
  const link = $('#invite-link');
  if (!card || !box || !link) return;
  const { url, svg } = inviteQrSvg({
    network: app.catalog.network,
    roomCode: app.roomCode,
    origin: location.origin,
    server: API_BASE,
  });
  card.classList.remove('hidden');
  link.textContent = url;
  // 心跳每秒都会重渲染一次，二维码内容没变就别重建，否则会一直闪
  if (inviteRenderedFor === url) return;
  inviteRenderedFor = url;
  box.innerHTML = svg;
}

// --------------------------------------------------------------------- game
function bindGame() {
  $('#game-chat-form').addEventListener('submit', (e) => { e.preventDefault(); sendChat('#game-chat-input'); });
  $('#btn-help').addEventListener('click', () => {
    const info = app.state?.you?.roleInfo;
    const blind = app.state?.you?.vision === 'blind';
    alert(`${info?.icon || ''} ${info?.name || ''}\n${info?.tagline || ''}\n\n${info?.hint || ''}${blind ? '\n\n（你的画面只有白色轮廓：颜色/数字/文字都看不见，但可以操作）' : ''}\n\n规则提醒：拆弹者只能看到炸弹，专家只有手册和外壳信息。所有沟通由你们自己完成（当面说话或用文字频道/手势信号）。\n\n想看完整教程：页面右上角「📖 教程」`);
  });
}

function sendChat(inputSel) {
  const input = $(inputSel);
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  send({ type: 'chat', text });
}

function renderGame() {
  const st = app.state;
  const info = st.you.roleInfo;
  $('#room-badge').classList.remove('hidden');
  $('#room-badge').textContent = `房间 ${st.room.code}`;
  $('#role-badge').classList.remove('hidden');
  $('#role-badge').textContent = `${info.icon} ${info.name}`;
  $('#btn-leave-top').classList.remove('hidden');
  $('#btn-close-top').classList.toggle('hidden', st.room.hostId !== app.playerId);

  renderHud();
  renderFeed();
  renderSignals();

  if (st.canManual && st.manual) renderManual($('#main-area'), { state: st });
  else renderBomb($('#main-area'), { state: st, act: act });

  renderChat($('#game-chat'));
  detectStrikeFlash();
}

function renderHud() {
  const st = app.state;
  const hud = $('#hud');
  clear(hud);
  const visible = !!st.you.roleInfo.canSeeTime;
  if (visible) {
    const remain = Math.max(0, st.remainingMs ?? 0);
    const timer = el('div', { class: 'hud-timer' + (remain < 30000 ? ' danger' : ''), dataset: { role: 'timer' }, text: fmtClock(remain) });
    hud.append(timer);
  } else {
    hud.append(el('div', { class: 'hud-timer', style: { fontSize: '18px', color: '#8b98a9', letterSpacing: '0' }, text: '（你的屏幕没有倒计时）' }));
  }
  const solved = (st.bomb?.moduleStates || []).filter((m) => m.status === 'solved').length;
  hud.append(el('div', { class: 'hud-row' }, [
    el('span', { text: `模块 ${solved}/${st.bomb?.moduleCount ?? '?'}` }),
    el('span', { text: `失误 ${st.strikes}/${st.maxStrikes}` }),
  ]));
  const leds = el('div', { class: 'strikes' });
  for (let i = 0; i < st.maxStrikes; i++) leds.append(el('span', { class: 'strike-led' + (i < st.strikes ? ' on' : '') }));
  hud.append(leds);
  const diffMeta = (app.catalog.difficulties || []).find((d) => d.id === st.room.difficulty);
  hud.append(el('div', { class: 'hud-row' }, [
    el('span', { text: `难度 ${diffMeta ? diffMeta.name : st.room.difficulty}` }),
    el('span', { text: st.manual ? `手册 ${st.manual.mode === 'partial' ? '拆分' : '完整'}` : '' }),
  ]));
  if (st.manual && st.manual.sections) {
    const list = el('div', { class: 'muted small', style: { marginTop: '10px' } });
    for (const s of st.manual.sections) {
      list.append(el('div', { text: `${s.status === 'solved' ? '✅' : '▫️'} ${s.title}（等级 ${s.tier}）` }));
    }
    hud.append(list);
  }
}

function renderFeed() {
  const feed = $('#status-feed');
  clear(feed);
  const logs = (app.state.log || []).slice(-25).reverse();
  for (const l of logs) {
    const cls = l.text.startsWith('❌') ? 'strike' : l.text.startsWith('✅') || l.text.startsWith('🎉') ? 'solved' : '';
    feed.append(el('div', { class: 'feed-item ' + cls, text: l.text }));
  }
}

// ------------------------------------------------------- 手势 / 信号面板
//
// 三人经典配置里，"哑手册猴"不能说话，只能发信号；"聋桥猴"看得见信号，
// 由他口头转述给"盲操猴"。这就是参考 BOMBANANA 的中间商式沟通。
const SIGNALS = [
  { kind: '✋ 停', hint: '先别动' },
  { kind: '👉 听我说', hint: '看我这边的信号' },
  { kind: '1', hint: '1' },
  { kind: '2', hint: '2' },
  { kind: '3', hint: '3' },
  { kind: '4', hint: '4' },
  { kind: '✅ 对', hint: '就是这样' },
  { kind: '❌ 错', hint: '不对，重来' },
  { kind: '🔴 红', hint: '红' },
  { kind: '🔵 蓝', hint: '蓝' },
  { kind: '🟡 黄', hint: '黄' },
  { kind: '🟢 绿', hint: '绿' },
  { kind: '⬆️ 上', hint: '上' },
  { kind: '⬇️ 下', hint: '下' },
  { kind: '⬅️ 左', hint: '左' },
  { kind: '➡️ 右', hint: '右' },
];

function renderSignals() {
  const box = $('#signal-panel');
  if (!box) return;
  clear(box);
  const st = app.state;
  const blind = st.you.vision === 'blind';
  const info = st.you.roleInfo;
  box.append(el('div', { class: 'bench-heading', style: { fontSize: '14px' }, text: '✋ 手势 / 信号' }));

  if (blind) {
    box.append(el('div', { class: 'muted small', text: '你是盲操猴：看不见信号，只能听队友喊。' }));
    return;
  }

  // 发信号
  const btns = el('div', { class: 'signal-btns' });
  for (const s of SIGNALS) {
    btns.append(el('button', {
      class: 'small',
      text: s.kind,
      title: s.hint,
      onClick: () => send({ type: 'signal', signal: s.kind }),
    }));
  }
  box.append(btns);
  if (info.canSpeak === false) {
    box.append(el('div', { class: 'muted small', text: '你不能说话：用上面的信号 + 文字频道表达。' }));
  } else {
    box.append(el('div', { class: 'muted small', text: '看得见炸弹的人多发信号，帮"看不见/听不见"的队友对齐信息。' }));
  }

  // 信号记录
  const log = el('div', { class: 'signal-log' });
  const list = (st.signals || []).slice().reverse();
  if (!list.length) log.append(el('div', { class: 'muted small', text: '还没有信号。' }));
  for (const s of list) {
    const t = new Date(s.at);
    log.append(el('div', { class: 'signal-item' }, [
      el('span', { class: 'sig-from', text: s.name }),
      el('span', { class: 'sig-kind', text: s.kind }),
      s.text ? el('span', { text: s.text }) : null,
      el('span', { class: 'sig-time', text: `${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}` }),
    ]));
  }
  box.append(el('div', { class: 'signals' }, [log]));
}

function detectStrikeFlash() {
  const uids = new Set();
  for (const m of app.state.bomb?.moduleStates || []) if (m.state) uids.add(m.uid);
  if (app.lastModuleUids.size) {
    for (const uid of uids) if (!app.lastModuleUids.has(uid)) flashModule(uid);
  }
  app.lastModuleUids = uids;
}

function flashModule(uid) {
  const node = document.querySelector(`.module[data-uid="${uid}"]`);
  if (!node) return;
  node.classList.add('flash-strike');
  setTimeout(() => node.classList.remove('flash-strike'), 500);
}

function renderChat(box) {
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  clear(box);
  for (const m of app.state.chat || []) {
    box.append(el('div', { class: 'chat-msg' }, [
      el('span', { class: 'who ' + m.role, text: `${m.name}：` }),
      el('span', { text: m.text }),
    ]));
  }
  if (nearBottom) box.scrollTop = box.scrollHeight;
}

// ---------------------------------------------------------------------- end
function bindEnd() {
  $('#btn-again').addEventListener('click', () => send({ type: 'restart' }));
}

function renderEnd() {
  const st = app.state;
  const r = st.result || {};
  const score = r.score || {};
  $('#btn-leave-top').classList.remove('hidden');
  $('#btn-close-top').classList.toggle('hidden', st.room.hostId !== app.playerId);
  $('#end-title').textContent = r.status === 'defused' ? '🎉 拆弹成功' : '💥 炸弹爆炸';
  const body = $('#end-body');
  clear(body);
  body.append(el('div', { class: 'score-big', text: String(score.score ?? 0) }));
  body.append(el('div', { class: 'muted', text: `${r.statusText || ''} · 用时 ${fmtClock(r.durationMs || 0)} · 剩余 ${fmtClock(r.remainingMs || 0)}` }));
  body.append(el('div', { class: 'score-grid' }, [
    sg('拆除模块', `${score.solved}/${score.total}`),
    sg('时间奖励', `+${score.timeBonus || 0}`),
    sg('失误扣分', `-${score.strikePenalty || 0}`),
    sg('完美奖励', `+${score.perfect || 0}`),
  ]));
  const reveal = el('div', { class: 'reveal' });
  for (const m of r.moduleReveal || []) {
    reveal.append(el('div', { class: 'rv' + (m.status === 'solved' ? ' solved' : ''), text: `${m.status === 'solved' ? '✅' : '❌'} ${m.title}（等级 ${m.tier}）` }));
  }
  body.append(el('h3', { text: '各模块情况' }));
  body.append(reveal);
  $('#btn-again').textContent = st.room.hostId === app.playerId ? '再来一局（回到准备区）' : '等待房主开始下一局';
  $('#btn-again').disabled = st.room.hostId !== app.playerId;
}

function sg(k, v) {
  return el('div', { class: 'sg' }, [el('div', { class: 'k', text: k }), el('div', { class: 'v', text: String(v) })]);
}

// ------------------------------------------------------------------- render
//
// 服务端每秒会推一次心跳（倒计时同步），如果每次推送都整页重绘，模块里的
// 动画（闪光序列、摩斯电码）就会被反复打断、看起来"根本不闪"。
// 所以这里算一个"渲染指纹"：只有真正影响画面的内容变了才重建 DOM。
function renderKey(state) {
  if (!state) return '';
  const room = state.room || {};
  const mods = (state.bomb?.moduleStates || []).map((m) => `${m.uid}:${m.status}:${m.note || ''}:${JSON.stringify(m.state ?? '')}`);
  const chatAll = (state.chat || []).map((c) => `${c.id}`);
  const logTail = (state.log || []).slice(-1).map((l) => `${l.at}:${l.text}`);  return JSON.stringify([
    room.phase, room.hostId, room.difficulty, room.moduleCount, room.manualRows,
    (room.players || []).map((p) => `${p.id}:${p.role}:${p.connected}:${p.name}`).join('|'),
    state.you?.role, state.status, state.strikes, state.maxStrikes,
    mods.join('|'), chatAll.join(','), logTail.join('|'),
    (state.signals || []).map((s) => `${s.id}:${s.kind}`).join(','),
    state.manual ? `${state.manual.mode}:${state.manual.seat}:${state.manual.sections.map((s) => `${s.uid}${s.status}`).join('')}` : '',
    state.result ? JSON.stringify(state.result.score) : '',
  ]);
}

function render(force = false) {
  const st = app.state;
  if (!st) return;
  const key = renderKey(st);
  if (!force && key === app.renderKey) {
    // 状态没变：只刷新那些随时钟变化的小东西
    updateCountdown();
    return;
  }
  app.renderKey = key;
  // 测试台开着的时候不要被服务端推送抢走画面
  if ($('#stage-bench') && !$('#stage-bench').classList.contains('hidden')) return;
  if (st.room.phase === 'lobby') { showStage('lobby'); renderLobby(); return; }
  if (st.room.phase === 'playing') { showStage('game'); renderGame(); return; }
  if (st.room.phase === 'ended') { showStage('end'); renderEnd(); }
}

function updateCountdown() {
  if (!app.state || app.state.room.phase !== 'playing') return;
  if (!app.state.you.roleInfo.canSeeTime) return;
  const t = document.querySelector('[data-role="timer"]');
  if (!t) return;
  const remain = Math.max(0, (app.state.remainingMs || 0) - (Date.now() - (app.state.serverTime || Date.now())));
  t.textContent = fmtClock(remain);
  t.classList.toggle('danger', remain < 30000);
}

function startTicker() {
  setInterval(updateCountdown, 200);
}

async function send(payload) {
  try {
    const res = await api('/api/action', { ...payload, room: app.roomCode, playerId: app.playerId });
    if (res && res.error) toast(res.error);
    return res;
  } catch (e) {
    toast(e.message);
    return null;
  }
}

/** Defuser action on a module. */
async function act(uid, action) {
  const res = await send({ type: 'module', uid, action });
  if (res && res.strike) toast('失误！');
  return res;
}

boot();
