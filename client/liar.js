// 骗子酒馆客户端：加入 / 准备区 / 牌桌 / 结算。
//
// 服务端才是权威：手牌、弹巢、目标牌、谁该出牌都由服务端决定；
// 这个文件只负责把"你能看到的那一份视图"画出来，并把操作发回去。

import { el, clear, $, fmtClock, toast } from './dom.js';
import { inviteUrl, inviteQrSvg } from './invite.js';

const RANK = {
  Q: { rank: 'Q', name: '皇后', icon: '👑' },
  K: { rank: 'K', name: '国王', icon: '🤴' },
  A: { rank: 'A', name: '尖刀', icon: '⚔️' },
  J: { rank: 'J', name: '赖子', icon: '🃏', wild: true },
};
const SEAT_COLORS = ['#ffd479', '#93c5fd', '#fca5a5', '#c4b5fd'];
const SEAT_BG = [
  'linear-gradient(140deg, #ffd479, #f59e0b)',
  'linear-gradient(140deg, #93c5fd, #3b82f6)',
  'linear-gradient(140deg, #fca5a5, #ef4444)',
  'linear-gradient(140deg, #c4b5fd, #8b5cf6)',
];

const SERVER_KEY = 'bomb:server';
const SESSION_KEY = 'liar:session';

const app = {
  playerId: null,
  roomCode: null,
  state: null,
  rev: -1,
  selected: new Set(),
  selectedPlayer: null,
  catalog: { rooms: [], rules: null, turnSeconds: [], network: null },
  es: null,
  reconnects: 0,
  renderKey: '',
  receivedAt: 0,
  inviteFor: '',
  ticker: null,
};

// --------------------------------------------------------------- 连接地址
// 静态托管（Pages / EdgeOne）时用 ?server= 指向房主，和拆弹页面共用同样的设置。
function normalizeServer(raw) {
  const v = String(raw || '').trim();
  if (!v) return '';
  const withScheme = /^https?:\/\//i.test(v) ? v : `http://${v}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.origin;
  } catch { return ''; }
}

function resolveServer() {
  const url = new URL(location.href);
  const fromQuery = normalizeServer(url.searchParams.get('server'));
  if (fromQuery) {
    try { localStorage.setItem(SERVER_KEY, fromQuery); } catch { /* private mode */ }
    return fromQuery;
  }
  try { return normalizeServer(localStorage.getItem(SERVER_KEY)); } catch { return ''; }
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

// --------------------------------------------------------------- 会话
function storeSession(code, id, name) {
  app.roomCode = code;
  app.playerId = id;
  try { sessionStorage.setItem(SESSION_KEY, JSON.stringify({ code, id, name })); } catch { /* ignore */ }
  const url = new URL(location.href);
  url.searchParams.set('room', code);
  history.replaceState(null, '', url);
}

function restoreSession() {
  let saved = null;
  try { saved = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); } catch { saved = null; }
  const url = new URL(location.href);
  const room = url.searchParams.get('room');
  const player = url.searchParams.get('player');
  if (room && player) return { code: room, id: player, name: saved?.name || '' };
  if (saved && (!room || room === saved.code)) return saved;
  if (room) return { code: room, id: null, name: saved?.name || '' };
  return null;
}

function clearSession() {
  app.state = null;
  app.rev = -1;
  app.roomCode = null;
  app.playerId = null;
  app.selected.clear();
  app.selectedPlayer = null;
  app.renderKey = '';
  app.inviteFor = '';
  try { sessionStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
  if (app.es) { try { app.es.close(); } catch { /* ignore */ } app.es = null; }
  const url = new URL(location.href);
  url.searchParams.delete('room');
  url.searchParams.delete('player');
  history.replaceState(null, '', url.pathname + (url.search ? url.search : ''));
  $('#room-badge').classList.add('hidden');
  $('#btn-leave-top').classList.add('hidden');
  $('#btn-close-top').classList.add('hidden');
  setLinkStatus(true);
}

// --------------------------------------------------------------- SSE
function subscribe() {
  if (app.es) { try { app.es.close(); } catch { /* ignore */ } }
  const url = `${apiUrl('/api/liar/events')}?room=${encodeURIComponent(app.roomCode)}&player=${encodeURIComponent(app.playerId)}`;
  const es = new EventSource(url);
  app.es = es;
  es.onopen = () => { app.reconnects = 0; setLinkStatus(true); };
  es.onmessage = (ev) => {
    try {
      const payload = JSON.parse(ev.data);
      applyState(payload.state, payload.rev);
    } catch (e) { console.warn('bad liar event', e); }
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
  if (!state) return;
  if (rev !== undefined && rev < app.rev) return;
  app.rev = rev ?? app.rev;
  app.state = state;
  app.receivedAt = Date.now();
  const hand = new Set(state.you?.hand || []);
  for (const id of [...app.selected]) if (!hand.has(id)) app.selected.delete(id);
  if (!state.canPlay) app.selected.clear();
  render();
}

// --------------------------------------------------------------- 启动
async function boot() {
  bindJoin();
  bindLobby();
  bindTable();
  bindEnd();
  bindRules();
  await loadCatalog();
  const saved = restoreSession();
  if (saved && saved.code) {
    if (saved.id) {
      try {
        const res = await api('/api/liar/join', { room: saved.code, name: saved.name || '玩家', playerId: saved.id });
        storeSession(res.roomCode, res.playerId, saved.name || '');
        subscribe();
        startTicker();
        return;
      } catch (e) {
        $('#join-error').textContent = `没能回到上次的牌桌（${e.message}），重新加入吧。`;
        $('#join-room').value = saved.code;
        $('#join-name').value = saved.name || '';
      }
    } else {
      $('#join-room').value = saved.code;
      $('#join-name').value = saved.name || '';
    }
  }
  showStage('join');
  startTicker();
}

async function loadCatalog() {
  try {
    const res = await fetch(apiUrl('/api/liar/rooms')).then((r) => r.json());
    if (!res || !Array.isArray(res.rooms)) throw new Error('服务器返回的内容不认识');
    app.catalog = { ...app.catalog, ...res };
    renderRoomList(res.rooms || []);
  } catch (e) {
    const box = $('#room-list');
    if (box) {
      clear(box);
      box.append(el('div', { class: 'muted', text: `连不上服务器（${API_BASE || '当前地址'}）：${e.message}` }));
    }
  }
}

function renderRoomList(rooms) {
  const box = $('#room-list');
  if (!box) return;
  clear(box);
  if (!rooms || !rooms.length) {
    box.append(el('div', { class: 'muted', text: '现在还没有开着的酒馆。填个昵称点「进入酒馆 / 新建」就开一间。' }));
    return;
  }
  for (const r of rooms) {
    const phase = r.phase === 'lobby' ? '准备中' : r.phase === 'playing' || r.phase === 'reveal' ? `第 ${r.round} 轮` : '已结束';
    box.append(el('div', {
      class: 'room-item',
      onClick: () => {
        $('#join-room').value = r.code;
        toast(`已填入房间号 ${r.code}`);
      },
    }, [
      el('span', { text: `🍺 ${r.code}` }),
      el('span', { class: 'muted', text: `${phase} · ${r.players}/${r.maxPlayers} 人${r.host ? ` · 房主 ${r.host}` : ''}` }),
    ]));
  }
}

// --------------------------------------------------------------- 加入
function bindJoin() {
  $('#btn-join').addEventListener('click', doJoin);
  $('#join-room').addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });
  $('#join-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });
  $('#btn-rules-join').addEventListener('click', openRules);
}

async function doJoin() {
  const name = $('#join-name').value.trim() || '酒客';
  const room = $('#join-room').value.trim().toUpperCase();
  const err = $('#join-error');
  err.textContent = '';
  $('#btn-join').disabled = true;
  try {
    const res = room
      ? await api('/api/liar/join', { room, name })
      : await api('/api/liar/create', { name });
    storeSession(res.roomCode, res.playerId, name);
    subscribe();
    startTicker();
  } catch (e) {
    err.textContent = e.message;
  } finally {
    $('#btn-join').disabled = false;
  }
}

function showStage(which) {
  for (const id of ['stage-join', 'stage-lobby', 'stage-table', 'stage-end']) {
    const node = $(`#${id}`);
    if (node) node.classList.toggle('hidden', id !== `stage-${which}`);
  }
  if (which === 'join') {
    $('#room-badge').classList.add('hidden');
    $('#btn-leave-top').classList.add('hidden');
    $('#btn-close-top').classList.add('hidden');
    loadCatalog();
  }
}

// --------------------------------------------------------------- 准备区
function bindLobby() {
  $('#btn-start').addEventListener('click', () => send({ type: 'start' }));
  $('#btn-copy-link').addEventListener('click', copyInvite);
  $('#btn-kick').addEventListener('click', () => {
    if (!app.selectedPlayer) return toast('先点一下要请出去的玩家');
    if (!confirm('把这位玩家请出房间？')) return;
    send({ type: 'kick', targetId: app.selectedPlayer });
    app.selectedPlayer = null;
  });
  $('#set-turn').addEventListener('change', () => {
    if (!app.state || app.state.room.hostId !== app.playerId) return;
    send({ type: 'configure', turnSeconds: Number($('#set-turn').value) });
  });
  $('#btn-leave').addEventListener('click', leaveRoom);
  $('#btn-leave-top').addEventListener('click', leaveRoom);
  $('#btn-leave-end').addEventListener('click', leaveRoom);
  $('#btn-close-room').addEventListener('click', closeRoom);
  $('#btn-close-top').addEventListener('click', closeRoom);
  $('#lobby-chat-form').addEventListener('submit', (e) => { e.preventDefault(); sendChat('#lobby-chat-input'); });
}

function renderLobby() {
  const st = app.state;
  const room = st.room;
  const isHost = room.hostId === app.playerId;
  $('#room-badge').classList.remove('hidden');
  $('#room-badge').textContent = `房间 ${room.code}`;
  $('#btn-leave-top').classList.remove('hidden');
  $('#btn-close-top').classList.toggle('hidden', !isHost);
  $('#btn-close-room').classList.toggle('hidden', !isHost);
  $('#btn-kick').classList.toggle('hidden', !isHost || !app.selectedPlayer);
  $('#lobby-count').textContent = `${room.players.length}/4 人`;

  const box = $('#lobby-players');
  clear(box);
  const seating = [...room.players].sort((a, b) => a.seat - b.seat);
  for (const p of seating) {
    const row = el('div', {
      class: 'player-row' + (app.selectedPlayer === p.id ? ' selected' : ''),
      onClick: () => {
        if (!isHost || p.id === app.playerId) return;
        app.selectedPlayer = app.selectedPlayer === p.id ? null : p.id;
        renderLobby();
      },
    }, [
      el('span', { class: 'seat-no', text: String(p.seat + 1) }),
      el('span', { class: 'dot' + (p.connected ? '' : ' off') }),
      el('span', { class: 'pname', text: `${p.name}${p.isHost ? '（房主）' : ''}${p.isYou ? '（你）' : ''}` }),
      el('span', { class: 'prole' + (p.connected ? '' : ' off'), text: p.connected ? '已坐下' : '离线' }),
    ]);
    box.append(row);
  }

  const turnSel = $('#set-turn');
  turnSel.disabled = !isHost;
  if (document.activeElement !== turnSel) turnSel.value = String(room.config.turnSeconds || 0);

  const connected = room.players.filter((p) => p.connected).length;
  const canStart = isHost && connected >= 2;
  $('#btn-start').disabled = !canStart;
  $('#btn-start').textContent = isHost ? '开始游戏' : '等待房主开始';
  $('#lobby-hint').textContent = connected < 2
    ? `还差 ${2 - connected} 名在线玩家才能开局（2~4 人）。`
    : `${connected} 名玩家在线，最多 4 人。把邀请链接发给朋友。`;
  $('#lobby-error').textContent = !isHost ? '房主还没有开始；你可以先在聊天里放点狠话。' : '';

  if (isHost) {
    // 房间号 / 邀请二维码
    renderInvite();
  }

  renderChat($('#lobby-chat'));
}

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
    path: '/liar',
  });
  card.classList.remove('hidden');
  link.textContent = url;
  if (app.inviteFor === url) return;
  app.inviteFor = url;
  box.innerHTML = svg;
}

function copyInvite() {
  const url = inviteUrl({
    network: app.catalog.network,
    roomCode: app.roomCode,
    origin: location.origin,
    server: API_BASE,
    path: '/liar',
  });
  navigator.clipboard?.writeText(url).then(
    () => toast('邀请链接已复制，发给朋友就能入座'),
    () => toast(`邀请链接：${url}`, 5000),
  );
}

// --------------------------------------------------------------- 牌桌
function bindTable() {
  $('#game-chat-form').addEventListener('submit', (e) => { e.preventDefault(); sendChat('#game-chat-input'); });
  document.addEventListener('keydown', (e) => {
    const tag = e.target && e.target.tagName ? e.target.tagName.toLowerCase() : '';
    if (/input|textarea|select/.test(tag)) return;
    if (!app.state || app.state.room.phase !== 'playing' || !app.state.canPlay) return;
    const n = Number(e.key);
    if (n >= 1 && n <= app.state.you.hand.length) {
      toggleCard(app.state.you.hand[n - 1]);
    } else if (e.key === 'Escape') {
      app.selected.clear();
      renderHand();
      renderActions();
    }
  });
}

function renderTable() {
  const st = app.state;
  const room = st.room;
  const isHost = room.hostId === app.playerId;
  $('#room-badge').classList.remove('hidden');
  $('#room-badge').textContent = `房间 ${room.code}`;
  $('#btn-leave-top').classList.remove('hidden');
  $('#btn-close-top').classList.toggle('hidden', !isHost);

  $('#round-no').textContent = String(room.round || 1);
  renderTarget();
  renderTurnBanner();
  renderOpponents();
  renderMe();
  renderHand();
  renderLastPlayOrReveal();
  renderActions();
  renderLog();
  renderChat($('#game-chat'));
  updateClocks();
}

function renderTarget() {
  const box = $('#target-card');
  clear(box);
  const rank = app.state?.room?.tableCard;
  if (!rank || !RANK[rank]) return;
  const info = RANK[rank];
  box.append(el('div', { class: 'target-card' }, [
    el('span', { class: 'tc-rank', text: rank }),
    el('span', { class: 'tc-icon', text: info.icon }),
  ]));
  box.append(el('div', { class: 'tc-copy' }, [
    el('b', { text: `目标牌：${rank} · ${info.name}` }),
    el('span', { text: '出牌只能声称这张 · J 可当它' }),
  ]));
}

function renderTurnBanner() {
  const st = app.state;
  const box = $('#turn-banner');
  clear(box);
  if (st.room.phase === 'reveal') {
    box.append(el('span', { text: '🔍 亮牌中…' }));
    return;
  }
  if (st.room.stage === 'finalcall') {
    box.append(el('span', { text: `👀 等 ${st.room.turnName} 决定：质疑，还是放过` }));
    return;
  }
  if (st.room.turnId === app.playerId) {
    box.append(el('b', { text: '轮到你出牌' }));
  } else {
    box.append(el('span', {}, [el('span', { text: '等待 ' }), el('b', { text: st.room.turnName }), el('span', { text: ' 出牌' })]));
  }
}

function revolverNode(shots, bulletAt, { dead = false, fired = false } = {}) {
  const chambers = [];
  for (let i = 0; i < 6; i++) {
    let cls = 'chamber';
    if (i < shots) cls += ' spent';
    if (bulletAt && i === bulletAt - 1 && (dead || bulletAt <= shots)) cls += ' bullet';
    else if (!dead && i === shots) cls += ' next';
    chambers.push(el('span', { class: cls, title: `${i + 1} 号弹巢` }));
  }
  return el('div', { class: 'revolver' + (fired ? ' fired' : '') }, [
    el('div', { class: 'rev-chambers' }, chambers),
    el('span', { class: 'rev-shots', text: `${shots}/6` }),
  ]);
}

function cardBacks(count, max = 5, small = true) {
  const nodes = [];
  for (let i = 0; i < max; i++) nodes.push(el('span', { class: 'card-back' + (i >= count ? ' empty' : '') }));
  return el('div', { class: 'liar-cards-mini' }, nodes);
}

function renderOpponents() {
  const st = app.state;
  const box = $('#opponents');
  clear(box);
  const reveal = st.reveal;
  const others = st.room.players.filter((p) => p.id !== app.playerId);
  for (const p of others) {
    const fired = !!(reveal && reveal.kind === 'challenge' && reveal.shot.playerId === p.id);
    const subBits = [];
    if (!p.connected) subBits.push(el('span', { text: '离线·托管' }));
    else if (!p.alive) subBits.push(el('span', { text: '已出局' }));
    else if (st.room.stage === 'finalcall' && st.finalPlayerId === p.id) subBits.push(el('span', { text: '手牌出完了' }));
    else if (st.lastPlay && st.lastPlay.playerId === p.id) subBits.push(el('span', { text: `刚出了 ${st.lastPlay.count} 张` }));
    else subBits.push(el('span', { text: '在桌上' }));

    box.append(el('div', {
      class: 'liar-opponent' + (p.isTurn ? ' turn' : '') + (p.alive ? '' : ' dead'),
      dataset: { seat: String(p.seat) },
    }, [
      el('div', { class: 'liar-opp-head' }, [
        el('div', { class: 'liar-avatar', style: { background: SEAT_BG[p.seat % SEAT_BG.length] }, text: p.name.slice(0, 1) }),
        el('div', { style: { minWidth: '0' } }, [
          el('div', { class: 'liar-opp-name' }, [
            el('span', { text: p.name }),
            p.isHost ? el('span', { class: 'crown', text: ' 👑' }) : null,
          ]),
          el('div', { class: 'liar-opp-sub' }, subBits),
        ]),
      ]),
      el('div', { class: 'liar-opp-row' }, [
        cardBacks(p.cardCount, 5),
        el('span', { class: 'liar-opp-count', text: `${p.cardCount} 张` }),
      ]),
      el('div', { class: 'liar-opp-row' }, [revolverNode(p.shots, p.bulletAt, { dead: !p.alive, fired })]),
      p.alive ? null : el('span', { class: 'liar-opp-dead-tag', text: '出局' }),
    ]));
  }
}

function renderMe() {
  const st = app.state;
  const me = st.you;
  const box = $('#me-panel');
  clear(box);
  const tags = [el('span', { class: 'me-tag', text: '你' })];
  if (!me.alive) tags.push(el('span', { class: 'me-tag dead', text: '出局' }));
  else if (st.room.turnId === me.id && st.room.phase === 'playing') tags.push(el('span', { class: 'me-tag turn', text: '你的回合' }));
  box.append(el('div', { class: 'me-left' }, [
    el('div', { class: 'liar-avatar', style: { background: SEAT_BG[me.seat % SEAT_BG.length] }, text: me.name.slice(0, 1) }),
    el('div', {}, [
      el('div', { class: 'me-name' }, [el('span', { text: me.name }), ...tags]),
      el('div', { class: 'muted small', text: me.alive ? '活着 · 别让质疑变成真的' : '已经出局 · 安静看戏' }),
    ]),
  ]));
  box.append(el('div', { class: 'me-right' }, [
    revolverNode(me.shots, me.bulletAt, { dead: !me.alive }),
    el('span', { class: 'me-cards', text: `手牌 ${me.hand.length} 张` }),
  ]));
}

function cardNode(cardId, { selectable = false, selected = false, small = false, revealed = false, match = null, dim = true } = {}) {
  const rank = String(cardId)[0];
  const info = RANK[rank] || { name: '?', icon: '?', rank };
  const cls = ['lcard'];
  if (rank === 'J') cls.push('joker');
  if (small) cls.push('small');
  if (revealed) cls.push('revealed');
  if (selectable) cls.push('selectable');
  if (selected) cls.push('selected');
  if (!selectable && dim && !revealed && !small) cls.push('disabled');
  if (match === true) cls.push('match');
  if (match === false) cls.push('mismatch');
  const node = el('div', {
    class: cls.join(' '),
    dataset: { card: cardId },
    title: rank === 'J' ? 'J · 赖子（可当目标牌）' : `${rank} · ${info.name}`,
    onClick: selectable ? () => toggleCard(cardId) : null,
  }, [
    el('span', { class: 'lc-rank', text: rank }),
    el('span', { class: 'lc-icon', text: info.icon }),
    el('span', { class: 'lc-name', text: info.name }),
  ]);
  if (match === true) node.append(el('span', { class: 'lc-badge', text: '✓' }));
  if (match === false) node.append(el('span', { class: 'lc-badge', text: '✗' }));
  return node;
}

function renderHand() {
  const st = app.state;
  const box = $('#my-hand');
  if (!box) return;
  clear(box);
  const me = st.you;
  if (!me.alive) {
    box.append(el('div', { class: 'liar-empty-hint', text: '💀 你已经被抬出去了。剩下的牌局可以看完，也可以继续在聊天里拱火。' }));
  } else if (!me.hand.length) {
    box.append(el('div', { class: 'liar-empty-hint', text: '手牌已经出完了，等这一轮结算。' }));
  } else {
    for (const id of me.hand) {
      box.append(cardNode(id, {
        selectable: !!st.canPlay,
        selected: app.selected.has(id),
        dim: false,
      }));
    }
  }
  const hint = $('#selection-hint');
  if (hint) {
    hint.textContent = st.canPlay
      ? `已选 ${app.selected.size}/3 张 · 数字键 1~${me.hand.length} 也能选`
      : me.alive ? '轮到别人出牌，先观察' : '';
  }
}

function renderLastPlayOrReveal() {
  const st = app.state;
  const lp = $('#lastplay');
  const rvBox = $('#reveal');
  const hint = $('#table-hint');
  clear(lp);
  clear(rvBox);
  rvBox.classList.add('hidden');
  if (hint) hint.textContent = '';

  if (st.reveal) {
    lp.classList.add('hidden');
    rvBox.classList.remove('hidden');
    renderReveal(rvBox, st.reveal);
    return;
  }
  lp.classList.remove('hidden');

  if (st.room.phase !== 'playing' && st.room.phase !== 'reveal') return;
  if (!st.lastPlay) {
    lp.append(el('div', { class: 'liar-empty-hint' }, [
      el('div', { text: st.room.round ? `第 ${st.room.round} 轮开始。` : '等开牌…' }),
      el('div', { text: st.room.turnId === app.playerId ? '你是先手：选 1~3 张牌，声称是目标牌。' : `${st.room.turnName} 先出牌。` }),
    ]));
    return;
  }
  const who = st.lastPlay.playerId === app.playerId ? '你' : st.lastPlay.name;
  lp.append(el('div', { class: 'lp-title' }, [
    el('b', { text: who }),
    el('span', { text: ` 出了 ${st.lastPlay.count} 张，声称是 ` }),
    el('b', { text: st.lastPlay.claimedRank || st.room.tableCard }),
  ]));
  lp.append(el('div', { class: 'lp-cards' }, Array.from({ length: st.lastPlay.count }, () => el('span', { class: 'card-back' }))));
  if (st.room.stage === 'finalcall') {
    lp.append(el('div', { class: 'lp-sub', text: `⚠️ ${who} 的手牌已经出完，只有下家能质疑；放过就算他赢下本轮。` }));
  } else {
    lp.append(el('div', { class: 'lp-sub', text: '这些牌只有他自己知道真假；下家可以选择质疑（Liar!）。' }));
  }
}

function renderReveal(box, rv) {
  if (rv.kind === 'passed') {
    box.append(el('div', { class: 'reveal-title', text: '😌 不质疑' }));
    box.append(el('div', { class: 'reveal-passed' }, [
      el('div', {}, [el('b', { text: rv.challengerName }), el('span', { text: ' 放过（没有开牌）。' })]),
      el('div', {}, [el('b', { text: rv.winnerName }), el('span', { text: ` 赢下第 ${app.state.room.round} 轮。` })]),
    ]));
  } else {
    box.append(el('div', { class: 'reveal-title' + (rv.honest ? '' : ' bad'), text: rv.honest ? '🔍 亮牌：质疑失败！' : '🔍 亮牌：抓到骗子！' }));
    box.append(el('div', { class: 'reveal-duel', text: `${rv.challengerName} 质疑 ${rv.targetName}` }));
    box.append(el('div', { class: 'reveal-cards' }, (rv.cards || []).map((c) => cardNode(c.id, { small: true, revealed: true, match: c.match }))));
    box.append(el('div', { class: 'reveal-result' }, [
      el('b', { text: rv.targetName }),
      el('span', { text: rv.honest
        ? ` 出的全是 ${rv.tableCard}（或赖子），质疑错了。`
        : ` 的牌里混进了不是 ${rv.tableCard} 的牌。` }),
    ]));
    const shot = rv.shot || {};
    box.append(el('div', { class: 'shot-line' + (shot.died ? ' died' : ' safe') }, [
      el('span', { text: `🔫 ${rv.shooterName} 对自己扣下第 ${shot.chamber}/6 枪 —— ` }),
      el('b', { text: shot.died ? '💥 实弹！出局' : '空响，活下来了' }),
    ]));
  }
  box.append(el('div', { class: 'next-round', dataset: { role: 'reveal-clock' }, text: '下一轮准备中…' }));
}

function renderActions() {
  const st = app.state;
  const box = $('#actions');
  if (!box) return;
  clear(box);
  const me = st.you;

  if (st.room.phase === 'reveal') {
    box.append(el('div', { class: 'waiting', text: '亮牌中…等这一轮结算。' }));
    return;
  }
  if (!me.alive) {
    box.append(el('div', { class: 'waiting', text: '💀 你已出局，安静看戏。聊天窗口还开着。' }));
    return;
  }

  if (st.canPlay) {
    const play = el('button', {
      class: 'primary big',
      text: `出牌（声称 ${st.room.tableCard}）`,
      disabled: app.selected.size < 1 || app.selected.size > 3,
      onClick: playSelected,
    });
    box.append(el('span', { class: 'selection-count' }, [
      el('span', { text: '已选 ' }),
      el('b', { text: String(app.selected.size) }),
      el('span', { text: ' 张（1~3）' }),
    ]));
    box.append(play);
    box.append(el('button', {
      class: 'ghost small',
      text: '清空选择',
      disabled: app.selected.size === 0,
      onClick: () => { app.selected.clear(); renderHand(); renderActions(); },
    }));
    if (st.canChallenge) {
      box.append(el('button', {
        class: 'danger',
        text: `🔍 质疑 ${st.lastPlay.name}（Liar!）`,
        onClick: challenge,
      }));
    }
    return;
  }

  if (st.canChallenge) {
    box.append(el('button', {
      class: 'danger big',
      text: `🔍 质疑 ${st.lastPlay.name}（Liar!）`,
      onClick: challenge,
    }));
    if (st.canPassFinal) {
      box.append(el('button', {
        class: 'calm',
        text: `😌 放过（算 ${st.finalPlayerName} 赢本轮）`,
        onClick: () => send({ type: 'passFinal' }),
      }));
    }
    return;
  }

  if (st.room.stage === 'finalcall') {
    box.append(el('div', { class: 'waiting', text: `⏳ 等 ${st.room.turnName} 决定：质疑，还是放过 ${st.finalPlayerName || ''}。` }));
  } else {
    box.append(el('div', { class: 'waiting' }, [
      el('span', { text: '等待 ' }),
      el('b', { text: st.room.turnName || '下一位' }),
      el('span', { text: ' 出牌…' }),
    ]));
  }
}

function toggleCard(cardId) {
  if (!app.state?.canPlay) return;
  if (app.selected.has(cardId)) app.selected.delete(cardId);
  else if (app.selected.size >= 3) return toast('一次最多出 3 张牌');
  else app.selected.add(cardId);
  renderHand();
  renderActions();
}

async function playSelected() {
  const cards = [...app.selected];
  if (!cards.length) return;
  const res = await send({ type: 'play', cards });
  if (res && res.ok) {
    app.selected.clear();
    renderHand();
    renderActions();
  }
}

async function challenge() {
  const name = app.state?.lastPlay?.name || '上家';
  if (!confirm(`质疑 ${name}？\n如果对方出的全是目标牌，挨枪的是你。`)) return;
  await send({ type: 'challenge' });
}

function renderLog() {
  const box = $('#game-log');
  if (!box) return;
  clear(box);
  const logs = (app.state.log || []).slice(-40).reverse();
  for (const l of logs) {
    const hot = /💥|🔫|❌|抓到骗子|出局/.test(l.text);
    const good = /🏆|✅|赢下|空响/.test(l.text);
    const round = /^第 \d+ 轮/.test(l.text);
    box.append(el('div', { class: 'feed-item' + (hot ? ' hot' : good ? ' good' : round ? ' round' : ''), text: l.text }));
  }
}

// --------------------------------------------------------------- 结算
function bindEnd() {
  $('#btn-again').addEventListener('click', () => send({ type: 'restart' }));
}

function renderEnd() {
  const st = app.state;
  const r = st.result || {};
  const isHost = st.room.hostId === app.playerId;
  const iWon = r.winnerId === app.playerId;
  $('#room-badge').classList.remove('hidden');
  $('#room-badge').textContent = `房间 ${st.room.code}`;
  $('#btn-leave-top').classList.remove('hidden');
  $('#btn-close-top').classList.toggle('hidden', !isHost);

  const banner = $('#end-banner');
  clear(banner);
  banner.append(el('div', { class: 'win-mark', text: iWon ? '🏆' : '💀' }));
  $('#end-title').textContent = iWon ? '你活着走出了酒馆' : `${r.winnerName || '有人'} 活着走出了酒馆`;
  const body = $('#end-body');
  clear(body);
  body.append(el('div', { class: 'end-sub', text: `一共 ${r.rounds || 0} 轮 · ${fmtClock(r.durationMs || 0)} · 所有人的手牌和弹巢都公开了` }));

  const grid = el('div', { class: 'result-grid' });
  for (const p of r.players || []) {
    grid.append(el('div', { class: 'result-card' + (p.id === r.winnerId ? ' winner' : '') + (p.alive ? '' : ' dead') }, [
      el('div', { class: 'rc-head' }, [
        el('span', { text: p.id === r.winnerId ? '🏆' : p.alive ? '🙂' : '💀' }),
        el('span', { text: p.name }),
        p.id === app.playerId ? el('span', { class: 'muted small', text: '（你）' }) : null,
      ]),
      el('div', { class: 'rc-meta' }, [
        el('div', { text: p.alive ? '活着' : `第 ${p.eliminatedRound || '?'} 轮出局` }),
        el('div', { text: `扣了 ${p.shots}/6 枪 · 实弹在第 ${p.bulletAt} 号弹巢` }),
        el('div', { text: p.alive ? `剩 ${p.remaining.length} 张牌` : '牌局结束' }),
      ]),
      el('div', { class: 'rc-cards' }, (p.remaining || []).map((c) => el('span', { class: 'card-back' }))),
    ]));
  }
  body.append(grid);

  $('#btn-again').textContent = isHost ? '再来一局（回到准备区）' : '等待房主开下一局';
  $('#btn-again').disabled = !isHost;
}

// --------------------------------------------------------------- 聊天
function sendChat(sel) {
  const input = $(sel);
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  send({ type: 'chat', text });
}

function renderChat(box) {
  if (!box) return;
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  clear(box);
  for (const m of app.state.chat || []) {
    box.append(el('div', { class: 'chat-msg' }, [
      el('span', { class: 'who', style: { color: SEAT_COLORS[(m.seat || 0) % SEAT_COLORS.length] }, text: `${m.name}：` }),
      el('span', { text: m.text }),
    ]));
  }
  if (nearBottom) box.scrollTop = box.scrollHeight;
}

// --------------------------------------------------------------- 规则弹层
function bindRules() {
  $('#btn-rules').addEventListener('click', openRules);
  $('#btn-rules-close').addEventListener('click', closeRules);
  $('#rules-modal').addEventListener('click', (e) => { if (e.target.id === 'rules-modal') closeRules(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeRules(); });
}

function openRules() { $('#rules-modal').classList.remove('hidden'); }
function closeRules() { $('#rules-modal').classList.add('hidden'); }

// --------------------------------------------------------------- 时钟
function updateClocks() {
  const st = app.state;
  if (!st) return;
  const now = (st.serverTime || Date.now()) + (Date.now() - app.receivedAt);

  const turnEl = document.querySelector('[data-role="turn-clock"]');
  if (turnEl) {
    if (st.room.phase === 'playing' && st.room.turnDeadline) {
      const rem = Math.max(0, st.room.turnDeadline - now);
      turnEl.textContent = `⏳ ${Math.ceil(rem / 1000)} 秒后自动出牌`;
      turnEl.classList.toggle('danger', rem < 5000);
    } else if (st.room.phase === 'playing') {
      turnEl.textContent = st.room.turnId === app.playerId ? '轮到你了' : '不限时';
      turnEl.classList.remove('danger');
    } else {
      turnEl.textContent = '';
      turnEl.classList.remove('danger');
    }
  }

  const revealEl = document.querySelector('[data-role="reveal-clock"]');
  if (revealEl && st.room.revealUntil) {
    const rem = Math.max(0, st.room.revealUntil - now);
    revealEl.textContent = rem > 0 ? `下一轮 ${Math.ceil(rem / 1000)} 秒后开始…` : '正在结算…';
  }
}

function startTicker() {
  if (app.ticker) return;
  app.ticker = setInterval(updateClocks, 250);
}

// --------------------------------------------------------------- 渲染入口
function renderKey(state) {
  const room = state.room || {};
  return JSON.stringify([
    room.phase, room.stage, room.round, room.tableCard, room.turnId, room.hostId, room.config?.turnSeconds,
    (room.players || []).map((p) => `${p.id}:${p.name}:${p.alive}:${p.shots}:${p.cardCount}:${p.connected}:${p.isTurn}`).join('|'),
    state.you?.hand?.join(','), state.you?.alive, state.you?.shots, state.you?.bulletAt,
    state.canPlay, state.canChallenge, state.canPassFinal, state.finalPlayerName,
    state.lastPlay ? `${state.lastPlay.playerId}:${state.lastPlay.count}:${state.lastPlay.at}:${state.lastPlay.cards?.join(',')}` : '',
    state.reveal ? `${state.reveal.kind}:${state.reveal.at}` : '',
    (state.chat || []).map((c) => c.id).join(','),
    (state.log || []).slice(-1).map((l) => `${l.at}:${l.text}`).join('|'),
    state.result ? `${state.result.winnerId}:${state.result.rounds}` : '',
  ]);
}

function render(force = false) {
  const st = app.state;
  if (!st) { showStage('join'); return; }
  const key = renderKey(st);
  if (!force && key === app.renderKey) {
    updateClocks();
    return;
  }
  app.renderKey = key;
  if (st.room.phase === 'lobby') { showStage('lobby'); renderLobby(); return; }
  if (st.room.phase === 'playing' || st.room.phase === 'reveal') { showStage('table'); renderTable(); return; }
  if (st.room.phase === 'ended') { showStage('end'); renderEnd(); }
}

// --------------------------------------------------------------- 动作
async function send(payload) {
  try {
    const res = await api('/api/liar/action', { ...payload, room: app.roomCode, playerId: app.playerId });
    if (res && res.error) toast(res.error);
    return res;
  } catch (e) {
    toast(e.message);
    return null;
  }
}

function leaveRoom() {
  if (!app.roomCode) { clearSession(); showStage('join'); return; }
  if (app.state && (app.state.room.phase === 'playing' || app.state.room.phase === 'reveal')) {
    if (!confirm('牌局还在进行。退出后座位会保留，你可以刷新页面重连回来。现在退出吗？')) return;
  }
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
  toast({ closed: '房主关闭了房间', kicked: '你被请出了房间', left: '已退出房间' }[reason] || '房间已关闭', 3000);
}

boot();
