// Zero-dependency HTTP + SSE server.
//
//   GET  /                         -> client app
//   GET  /static/*                 -> client assets
//   POST /api/create               -> create a room            -> { roomCode }
//   POST /api/join                 -> join / reconnect        -> { playerId, token }
//   GET  /api/state?room=&player=  -> polling fallback (full view)
//   GET  /api/events?room=&player= -> SSE stream of role views
//   POST /api/action               -> player command
//   GET  /api/rooms                -> lobby browser

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Game } from './room.js';
import { playerState, roomSummary, buildManual, moduleStateForBomb } from '../lib/view.js';
import { MODULES } from '../lib/modules.js';
import { makeBomb } from '../lib/bomb.js';
import { DIFFICULTIES, DIFFICULTY_ORDER, ROLE_INFO, EXTRA_EXPERT_ROLES, ROLES, PORTS, ROLE_PRESETS } from '../lib/vocab.js';

// 单文件 exe 是被 esbuild 打成 CJS 的，那里没有 import.meta.url，所以退回 __dirname；
// 两者都没有（极端情况）就用 cwd。打包版的 client/ 是内联进 JS 的（见 serveStatic），
// 这里只要有一个稳定的字符串前缀就够了。
const SELF_DIR = import.meta.url
  ? path.dirname(fileURLToPath(import.meta.url))
  : typeof __dirname === 'string'
    ? __dirname
    : process.cwd();
const ROOT = path.resolve(SELF_DIR, '..');
const CLIENT_DIR = path.join(ROOT, 'client');

const game = new Game();
const streams = new Map(); // playerId -> { res, roomCode }
const previews = new Map(); // playerId -> { bomb } 房主测试台的临时题目
const TEST_MODE = process.argv.includes('--test') || process.env.BOMB_TEST === '1';
const SERVER_STARTED_AT = Date.now();
/** 管理入口的测试台用这个虚拟座位 id，和真实玩家互不干扰 */
const ADMIN_SEAT = '__admin__';

// 管理入口令牌：每次启动随机生成，打印在终端里（也可以自己指定）
const ADMIN_TOKEN = String(process.env.BOMB_ADMIN_TOKEN || process.argv.find((a) => a.startsWith('--admin-token='))?.slice('--admin-token='.length) || crypto.randomBytes(9).toString('base64url'));

function adminTokenFrom(req, url) {
  const h = req.headers['x-admin-token'];
  if (h) return String(h);
  if (url) return url.searchParams.get('token') || '';
  return '';
}

function isAdmin(req, url) {
  const provided = adminTokenFrom(req, url);
  return provided.length > 0 && provided === ADMIN_TOKEN;
}

function requireAdmin(req, url) {
  if (!isAdmin(req, url)) {
    const err = new Error('管理令牌无效');
    err.statusCode = 401;
    throw err;
  }
}

// --------------------------------------------------------------------- utils
function send(res, code, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, {
    'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

// 打成单文件 exe 时，client/ 的内容会被内联进同一个 JS（见 tools/build-single.mjs），
// 这样 exe 不需要往磁盘释放任何文件，行为也不会被当成"释放器"。
const EMBEDDED_CLIENT = globalThis.__BOMB_EMBEDDED_CLIENT__ || null;

function serveStatic(res, filePath) {
  const abs = path.resolve(filePath);
  if (EMBEDDED_CLIENT) {
    const rel = path.relative(CLIENT_DIR, abs).split(path.sep).join('/');
    if (Object.prototype.hasOwnProperty.call(EMBEDDED_CLIENT, rel)) {
      res.writeHead(200, {
        'content-type': MIME[path.extname(abs)] || 'application/octet-stream',
        'cache-control': 'no-cache',
      });
      res.end(EMBEDDED_CLIENT[rel]);
      return;
    }
  }
  if (!abs.startsWith(CLIENT_DIR)) return send(res, 403, 'forbidden');
  fs.readFile(abs, (err, data) => {
    if (err) return send(res, 404, 'not found');
    res.writeHead(200, { 'content-type': MIME[path.extname(abs)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  });
}

// ------------------------------------------------------- module test bench
//
// 给"房主在游戏里"和"/admin 管理入口"共用的一份生成逻辑。
const STRIP_NAMES = { blue: '蓝色光条', white: '白色光条', yellow: '黄色光条', other: '其他颜色光条' };
const stripNameOf = (key) => STRIP_NAMES[key] || STRIP_NAMES.other;

function buildPreview(playerId, modIdRaw, tierRaw) {
  const modId = MODULES[modIdRaw] ? modIdRaw : 'wires';
  const tier = Math.max(1, Math.min(5, Number(tierRaw) | 0 || 3));
  const seed = `preview:${modId}:${tier}:${crypto.randomBytes(4).toString('hex')}`;
  const bomb = makeBomb({ seed, difficulty: 'normal', modulePick: modId, tier });
  const mod = bomb.modules[0];
  previews.set(playerId, { bomb, modId, tier, at: Date.now() });
  if (previews.size > 200) previews.delete(previews.keys().next().value);
  return {
    module: MODULES[modId].title,
    moduleId: modId,
    tier,
    icon: MODULES[modId].icon,
    state: { uid: mod.uid, id: mod.id, tier: mod.tier, title: mod.title, icon: mod.icon, status: mod.status, state: mod.state, note: mod.note },
    manual: buildManual(bomb, 0, 1, 'full'),
    asks: mod.asks,
    casing: { serial: bomb.serial, batteries: bomb.batteries, batteryTypes: bomb.batteryTypes, indicators: Object.keys(bomb.indicatorMap), ports: bomb.ports },
  };
}

/** 角色视角预览：一整颗炸弹 + 四种角色各自能看到的东西。 */
function buildRolePreview(seatId, difficulty, moduleCount) {
  const seed = `rolepreview:${crypto.randomBytes(6).toString('hex')}`;
  const diff = DIFFICULTY_ORDER.includes(difficulty) ? difficulty : 'normal';
  const bomb = makeBomb({ seed, difficulty: diff, moduleCount: Number(moduleCount) || 4 });
  const info = (id) => ROLE_INFO[id] || EXTRA_EXPERT_ROLES.find((r) => r.id === id) || ROLE_INFO.expert;
  const view = (role, seat) => {
    const meta = info(role);
    const base = {
      role,
      roleName: meta.name,
      roleIcon: meta.icon,
      tagline: meta.tagline,
      canInteract: !!meta.canInteract,
      canManual: !!meta.canManual,
      canSeeTime: !!meta.canSeeTime,
      canSpeak: !!meta.canSpeak,
      seesBomb: !!meta.seesBomb,
      vision: meta.vision || 'full',
      manualRows: meta.manualRows || 'full',
    };
    if (meta.seesBomb) {
      base.moduleStates = bomb.modules.map(moduleStateForBomb);
    } else {
      base.moduleStates = bomb.modules.map((m) => ({ uid: m.uid, id: m.id, tier: m.tier, title: m.title, icon: m.icon, status: m.status }));
    }
    if (meta.canManual) {
      base.manual = buildManual(bomb, seat, 2, meta.manualRows || 'full');
      base.seat = seat;
    }
    return base;
  };
  previews.set(seatId, { bomb, rolePreview: true, at: Date.now() });  if (previews.size > 200) previews.delete(previews.keys().next().value);
  return {
    kind: 'roles',
    seed,
    difficulty: diff,
    casing: {
      serial: bomb.serial,
      batteries: bomb.batteries,
      batteryTypes: bomb.batteryTypes,
      indicators: Object.keys(bomb.indicatorMap),
      ports: bomb.ports.map((p) => (PORTS.find((x) => x.id === p) || { name: p }).name),
      rawPorts: bomb.ports,
    },
    modules: bomb.modules.map((m) => ({ uid: m.uid, id: m.id, title: m.title, icon: m.icon, tier: m.tier })),
    views: [
      { key: 'truth', name: '整颗炸弹（只有你看得到）', icon: '🛠️', note: '左边题目 + 右边答案，用来核对每个角色该看到什么', moduleStates: bomb.modules.map(moduleStateForBomb) },
      { key: 'defuser', ...view(ROLES.DEFUSER, 0) },
      { key: 'expert', ...view(ROLES.EXPERT, 0) },
      { key: 'blind', ...view(ROLES.BLIND, 0) },
      { key: 'mute', ...view(ROLES.MUTE, 0) },
      // 三人经典：盲操 / 聋桥 / 哑手册
      { key: 'blindop', ...view(ROLES.BLIND_OP, 0) },
      { key: 'deafsee', ...view(ROLES.DEAF_SEE, 0) },
      { key: 'muteexp', ...view(ROLES.MUTE_EXP, 0) },
      { key: 'expert2', ...view('expert2', 1) },
    ],
  };
}

function runPreviewAction(playerId, action) {
  const pv = previews.get(playerId);
  if (!pv) throw new Error('请先生成一道题目');
  const mod = pv.bomb.modules[0];
  const def = MODULES[mod.id];
  if (action && action.type === 'oracle') {
    if (!TEST_MODE) throw new Error('未知操作');
    return { oracle: mod.solution, moduleId: mod.id, moduleState: mod.state };
  }
  if (mod.status === 'solved') return { previewResult: { note: '这道题已经做对了', solved: true } };
  const ctx = { strikes: 0, remainingMs: pv.bomb.durationMs };
  // 测试台自己的"假计时器"：客户端把剩下的毫秒一起送来，就能真的判定松手时机
  if (action && typeof action.benchMs === 'number') ctx.remainingMs = Math.max(0, action.benchMs);
  const res = (def.extraActions && action && action.type === 'transmit')
    ? def.submit(mod, action, ctx)
    : def.apply(mod, action, ctx);
  if (res && res.error) throw new Error(res.error);
  if (res && (res.reset || res.strike)) { if (def.resetState) def.resetState(mod); }
  let out = res ? { ...res } : {};
  // 测试台没有真实炸弹：如果客户端没带自己的假计时器，就不判"松手时机"，
  // 只把正确时机告诉房主，方便他核对题目和手册。
  if (out.strike && mod.id === 'button' && mod.solution.mode === 'hold' && action?.type === 'release'
    && typeof action.benchMs !== 'number') {
    out = {
      strike: false,
      benchNote: `测试台没有真实倒计时，所以不判失误；正式游戏里应该在计时器显示 ${mod.solution.digit} 时松手（${stripNameOf(mod.solution.strip)}）`,
      note: out.note,
    };
  }
  if (out.solved) mod.status = 'solved';
  return {
    previewResult: out,
    preview: {
      module: MODULES[mod.id].title,
      moduleId: mod.id,
      tier: mod.tier,
      icon: MODULES[mod.id].icon,
      state: { uid: mod.uid, id: mod.id, tier: mod.tier, title: mod.title, icon: mod.icon, status: mod.status, state: mod.state, note: mod.note },
      manual: buildManual(pv.bomb, 0, 1, 'full'),
      asks: mod.asks,
      casing: { serial: pv.bomb.serial, batteries: pv.bomb.batteries, batteryTypes: pv.bomb.batteryTypes, indicators: Object.keys(pv.bomb.indicatorMap), ports: pv.bomb.ports },
    },
  };
}

/** 逐个模块 × 等级生成一道题，检查题目和手册是否都正常。 */
function runSelfCheck() {
  const problems = [];
  let checked = 0;
  for (const [modId, def] of Object.entries(MODULES)) {
    for (const tier of [1, 2, 3, 4, 5]) {
      checked++;
      try {
        const bomb = makeBomb({ seed: `check:${modId}:${tier}`, difficulty: 'normal', modulePick: modId, tier });
        const mod = bomb.modules[0];
        const manual = buildManual(bomb, 0, 1, 'full');
        const issues = [];
        if (!mod || !mod.state) issues.push('没有题目状态');
        if (mod && mod.tier !== tier) issues.push(`等级不符（${mod.tier}）`);
        if (!manual.sections?.length) issues.push('没有手册章节');
        const groups = manual.sections?.[0]?.groups || [];
        if (!groups.length) issues.push('手册没有规则块');
        if (groups.some((g) => g.kind === 'table' && (!g.rows || !g.rows.length))) issues.push('手册有空表格');
        if (!mod?.asks?.length) issues.push('没有列出要问的信息');
        // 手册里的迷宫墙必须和引擎一致
        const mazeGroup = groups.find((g) => g.kind === 'maze');
        if (mazeGroup && mod.solution?.walls && JSON.stringify(mazeGroup.walls) !== JSON.stringify(mod.solution.walls)) issues.push('迷宫手册与引擎不一致');
        // 键盘：必须恰好有一列完整包含键盘上的符号
        if (modId === 'keypad') {
          const rows = groups.filter((g) => g.kind === 'table').flatMap((g) => g.rows || []);
          const cols = rows.map((r) => r.action.split(/\s+/));
          const matches = cols.filter((parts) => mod.state.slots.every((s) => parts.includes(s)));
          if (matches.length !== 1) issues.push(`键盘手册匹配列数=${matches.length}（应为 1）`);
        }
        if (issues.length) problems.push({ module: def.title, moduleId: modId, tier, issues });
      } catch (e) {
        problems.push({ module: def.title, moduleId: modId, tier, issues: [`生成异常：${e.message}`] });
      }
    }
  }
  return { checked, problems, ok: checked - problems.length };
}

/** 管理面板用的房间快照（比玩家列表多给一些诊断信息）。 */
function adminRooms() {
  const now = Date.now();
  return [...game.rooms.values()]
    .map((r) => ({
      code: r.code,
      phase: r.phase,
      status: r.status,
      difficulty: r.difficulty,
      moduleCount: r.bomb ? r.bomb.modules.length : null,
      solved: r.bomb ? r.bomb.modules.filter((m) => m.status === 'solved').length : 0,
      strikes: r.strikes,
      maxStrikes: r.bomb ? r.bomb.maxStrikes : null,
      remainingMs: r.phase === 'playing' ? Math.max(0, r.deadline - now) : null,
      manualRows: r.manualRows,
      expertSeats: r.expertSeats,
      createdAt: r.createdAt,
      startedAt: r.startedAt || null,
      lastActivity: r.lastActivity || r.createdAt,
      players: Object.values(r.players).map((p) => ({ id: p.id, name: p.name, role: p.role, connected: p.connected, seat: p.seat })),
      modules: r.bomb ? r.bomb.modules.map((m) => ({ uid: m.uid, title: m.title, icon: m.icon, tier: m.tier, status: m.status })) : [],
      logTail: r.log.slice(-8).map((l) => l.text),
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

// ------------------------------------------------------------------ broadcast
function broadcast(room) {
  room.rev = (room.rev || 0) + 1;
  room.lastActivity = Date.now();
  for (const p of Object.values(room.players)) {
    const stream = streams.get(p.id);
    if (!stream || stream.roomCode !== room.code) continue;
    writeEvent(stream.res, p.id, room);
  }
}

/** 告诉某个玩家的浏览器"这个房间没了"，然后挂断他的 SSE。 */
function notifyClosed(playerId, roomCode, reason) {
  const stream = streams.get(playerId);
  if (!stream || stream.roomCode !== roomCode) return;
  try {
    stream.res.write(`event: closed\ndata: ${JSON.stringify({ reason })}\n\n`);
    stream.res.end();
  } catch { /* already gone */ }
  streams.delete(playerId);
}

function writeEvent(res, playerId, room) {
  const player = room.players[playerId];
  if (!player) return;
  try {
    const payload = { rev: room.rev || 0, state: playerState(room, player) };
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  } catch { /* stream closed */ }
}

function pushTo(playerId, room) {
  const stream = streams.get(playerId);
  if (stream && stream.roomCode === room.code) writeEvent(stream.res, playerId, room);
}

// ---------------------------------------------------------------------- API
const routes = {
  // ------------------------------------------------------------ 管理入口 API
  async 'GET /api/admin/state'(req, res, url) {
    requireAdmin(req, url);
    const rooms = [...game.rooms.values()];
    send(res, 200, {
      ok: true,
      server: {
        startedAt: SERVER_STARTED_AT,
        now: Date.now(),
        uptimeMs: Date.now() - SERVER_STARTED_AT,
        node: process.version,
        testMode: TEST_MODE,
        rooms: game.rooms.size,
        players: rooms.reduce((n, r) => n + Object.keys(r.players).length, 0),
        connected: rooms.reduce((n, r) => n + Object.values(r.players).filter((p) => p.connected).length, 0),
        previews: previews.size,
      },
      modules: Object.entries(MODULES).map(([id, def]) => ({ id, title: def.title, icon: def.icon })),
      difficulties: DIFFICULTY_ORDER.map((d) => ({ id: d, ...DIFFICULTIES[d] })),
      rooms: adminRooms(),
    });
  },

  async 'POST /api/admin/action'(req, res, body, url) {
    requireAdmin(req, url);
    const type = body.type;
    if (type === 'preview') return send(res, 200, { preview: buildPreview(ADMIN_SEAT, body.module, body.tier) });
    if (type === 'previewAction') return send(res, 200, runPreviewAction(ADMIN_SEAT, body.action));
    if (type === 'rolePreview') return send(res, 200, { rolePreview: buildRolePreview(ADMIN_SEAT, body.difficulty, body.moduleCount) });
    if (type === 'selfCheck') return send(res, 200, { report: runSelfCheck() });
    if (type === 'setTime') {
      // 管理/测试用：把某个房间的倒计时压短
      const room = game.getRoom(body.room);
      if (!room) throw new Error('房间不存在');
      if (room.phase !== 'playing') throw new Error('这个房间不在进行中');
      room.deadline = Date.now() + Math.max(0, Number(body.ms) | 0);
      broadcast(room);
      return send(res, 200, { ok: true });
    }
    if (type === 'closeRoom') {
      const room = game.getRoom(body.room);
      if (!room) throw new Error('房间不存在');
      for (const p of Object.values(room.players)) notifyClosed(p.id, room.code, 'closed');
      game.closeRoom(room, { name: '管理员' });
      return send(res, 200, { ok: true, closed: room.code });
    }
    if (type === 'kickPlayer') {
      const room = game.getRoom(body.room);
      if (!room) throw new Error('房间不存在');
      const target = room.players[body.playerId];
      if (!target) throw new Error('玩家不存在');
      notifyClosed(target.id, room.code, 'kicked');
      delete room.players[target.id];
      game.recomputeSeats(room);
      game.log(room, `${target.name} 被管理员移出房间`);
      broadcast(room);
      return send(res, 200, { ok: true });
    }
    throw new Error('未知操作');
  },

  async 'GET /api/rooms'(req, res) {
    send(res, 200, {
      rooms: game.listRooms(),
      difficulties: DIFFICULTY_ORDER.map((d) => ({ id: d, ...DIFFICULTIES[d] })),
      roles: Object.values(ROLE_INFO).concat(EXTRA_EXPERT_ROLES),
      presets: ROLE_PRESETS,
      // 客户端拿这个拼"邀请链接 / 二维码"，手机扫了就能进房间
      network: { port: PORT, urls: LAN_IPS },
    });
  },

  async 'POST /api/create'(req, res, body) {
    const room = game.createRoom({ difficulty: body.difficulty || 'normal', hostName: body.name || '房主' });
    const player = game.joinRoom(room, { name: body.name, role: body.role || null, playerId: body.playerId });
    if (!player.role) player.role = 'expert';
    game.recomputeSeats(room);
    send(res, 200, { roomCode: room.code, playerId: player.id });
  },

  async 'POST /api/join'(req, res, body) {
    const room = game.getRoom(body.room);
    if (!room) return send(res, 404, { error: '房间不存在' });
    let player;
    try {
      player = game.joinRoom(room, { name: body.name, role: body.role || null, playerId: body.playerId });
    } catch (e) {
      return send(res, 400, { error: e.message });
    }
    broadcast(room);
    send(res, 200, { roomCode: room.code, playerId: player.id, role: player.role });
  },

  async 'GET /api/state'(req, res, url) {
    const room = game.getRoom(url.searchParams.get('room'));
    if (!room) return send(res, 404, { error: '房间不存在' });
    const player = room.players[url.searchParams.get('player')];
    if (!player) return send(res, 404, { error: '玩家不在这个房间里' });
    send(res, 200, { rev: room.rev || 0, state: playerState(room, player) });
  },

  async 'GET /api/events'(req, res, url) {
    const room = game.getRoom(url.searchParams.get('room'));
    const playerId = url.searchParams.get('player');
    if (!room) return send(res, 404, { error: '房间不存在' });
    const player = room.players[playerId];
    if (!player) return send(res, 404, { error: '玩家不在这个房间里' });

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(': connected\n\n');
    const prev = streams.get(playerId);
    if (prev) { try { prev.res.end(); } catch { /* ignore */ } }
    streams.set(playerId, { res, roomCode: room.code });
    player.connected = true;
    player.lastSeen = Date.now();
    writeEvent(res, playerId, room);
    broadcast(room);

    const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch { /* closed */ } }, 15000);
    req.on('close', () => {
      clearInterval(ka);
      const cur = streams.get(playerId);
      if (cur && cur.res === res) streams.delete(playerId);
    });
  },

  async 'POST /api/action'(req, res, body) {
    const room = game.getRoom(body.room);
    if (!room) return send(res, 404, { error: '房间不存在' });
    const player = room.players[body.playerId];
    if (!player) return send(res, 404, { error: '玩家不在这个房间里' });
    player.lastSeen = Date.now();
    player.connected = true;
    const type = body.type;
    let result = {};
    try {
      // 测试专用后门：只有以 --test 启动时才存在，用来跑自动化端到端测试
      if (body.type === 'module' && body.action && body.action.type === 'oracle') {
        if (!TEST_MODE) throw new Error('未知操作');
        const mod = room.bomb && room.bomb.modules.find((m) => m.uid === body.uid);
        if (!mod) throw new Error('模块不存在');
        result = { oracle: mod.solution, moduleId: mod.id, moduleState: mod.state };
      } else if (type === 'debugSetTime') {
        // 测试专用：把倒计时压短，用来验证超时爆炸的路径
        if (!TEST_MODE) throw new Error('未知操作');
        if (room.phase !== 'playing') throw new Error('游戏不在进行中');
        room.deadline = Date.now() + Math.max(0, Number(body.ms) | 0);
      } else if (type === 'preview') {
        if (room.hostId !== player.id) throw new Error('只有房主可以测试模块');
        result = { preview: buildPreview(player.id, body.module, body.tier) };
      } else if (type === 'previewAction') {
        if (room.hostId !== player.id) throw new Error('只有房主可以测试模块');
        result = runPreviewAction(player.id, body.action);
      } else if (type === 'role') {
        game.setRole(room, player.id, body.role);
      } else if (type === 'autoAssign') {
        game.autoAssign(room);
      } else if (type === 'preset') {
        if (room.hostId !== player.id) throw new Error('只有房主可以套用角色预设');
        if (room.phase !== 'lobby') throw new Error('只能在准备阶段改角色');
        result = { preset: game.applyPreset(room, body.preset) };
      } else if (type === 'signal') {
        // 手势/信号：给"聋桥猴"看队友在说什么（不改变游戏状态）
        const kind = String(body.signal || '').slice(0, 24);
        if (!kind) throw new Error('信号不能为空');
        game.signal(room, player, kind);
      } else if (type === 'cursor') {
        // 盲操猴的光标：让看得见的队友知道他在操作哪个位置
        game.cursor(room, player, { uid: body.uid, x: body.x, y: body.y });
      } else if (type === 'note') {
        // 信号面板上留一句话，给看得见的人看
        game.signal(room, player, 'note', String(body.text || '').slice(0, 60));
      } else if (type === 'configure') {
        if (room.phase !== 'lobby') throw new Error('只能在准备阶段修改设置');
        game.configure(room, body);
      } else if (type === 'start') {
        game.start(room);
      } else if (type === 'restart') {
        game.restart(room, { seed: body.seed });
      } else if (type === 'module') {
        result = game.act(room, player, { uid: body.uid, action: body.action });
      } else if (type === 'chat') {
        game.chat(room, player, body.text);
      } else if (type === 'ping') {
        // presence only
      } else if (type === 'leave') {
        // 主动退出：先把"人走了"广播给remain的人，再挂断自己的 SSE
        const info = game.removePlayer(room, player.id);
        if (info.roomDeleted) return send(res, 200, { ok: true, left: true, roomDeleted: true });
        broadcast(room);
        notifyClosed(player.id, room.code, 'left');
        return send(res, 200, { ok: true, left: true });
      } else if (type === 'closeRoom') {
        if (room.hostId !== player.id) throw new Error('只有房主可以关闭房间');
        for (const p of Object.values(room.players)) notifyClosed(p.id, room.code, 'closed');
        game.closeRoom(room, player);
        return send(res, 200, { ok: true, closed: true });
      } else if (type === 'kick') {
        if (room.hostId !== player.id) throw new Error('只有房主可以踢人');
        const target = room.players[body.targetId];
        if (target && target.id !== player.id) {
          notifyClosed(target.id, room.code, 'kicked');
          delete room.players[target.id];
          game.recomputeSeats(room);
          game.log(room, `${target.name} 被移出房间`);
        }
      } else {
        throw new Error('未知操作');
      }
    } catch (e) {
      return send(res, 400, { error: e.message });
    }
    broadcast(room);
    send(res, 200, { ok: true, ...result });
  },
};

// ------------------------------------------------------------------- server
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // 允许客户端被放到别的域（EdgeOne Pages / GitHub Pages 静态托管，API 指回这里）。
  // 我们不用 cookie 做身份（房间号+玩家 id 都走 query/body），所以放开 * 是安全的。
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'origin');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type');
    res.setHeader('access-control-max-age', '86400');
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const key = `${req.method} ${url.pathname}`;

  if (routes[key]) {
    let body = {};
    if (req.method === 'POST') {
      try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
    }
    try {
      // GET 处理器签名是 (req, res, url)，POST 处理器是 (req, res, body)
      return req.method === 'GET'
        ? await routes[key](req, res, url)
        : await routes[key](req, res, body);
    } catch (e) {
      return send(res, e.statusCode || 500, { error: e.message });
    }
  }

  if (req.method === 'GET') {
    if (url.pathname === '/admin' || url.pathname === '/admin/' || url.pathname === '/admin.html') {
      return serveStatic(res, path.join(CLIENT_DIR, 'admin.html'));
    }
    if (url.pathname === '/tutorial' || url.pathname === '/tutorial/' || url.pathname === '/tutorial.html') {
      return serveStatic(res, path.join(CLIENT_DIR, 'tutorial.html'));
    }
    if (url.pathname === '/' || url.pathname === '/index.html') return serveStatic(res, path.join(CLIENT_DIR, 'index.html'));
    if (url.pathname.startsWith('/static/')) return serveStatic(res, path.join(CLIENT_DIR, url.pathname.slice('/static/'.length)));
    return serveStatic(res, path.join(CLIENT_DIR, url.pathname.replace(/^\//, '')));
  }
  send(res, 404, 'not found');
});

// game loop: timer expiry + strike state, broadcast on change
setInterval(() => {
  for (const room of game.rooms.values()) {
    const changed = game.tick(room);
    if (changed) broadcast(room);
  }
  game.sweep();
}, 250);

// heartbeat so clients' countdown stays in sync and disconnects are noticed
setInterval(() => {
  for (const room of game.rooms.values()) {
    if (room.phase === 'playing') {
      const remaining = room.deadline - Date.now();
      if (remaining <= 0) continue;
      room.rev = (room.rev || 0) + 1;
      for (const p of Object.values(room.players)) pushTo(p.id, room);
    } else if (room.phase === 'lobby') {
      broadcast(room);
    }
  }
}, 1000);

const PORT = Number(process.env.PORT || process.argv[2] || 3210);
const HOST = process.env.HOST || '0.0.0.0';
// 局域网地址：既给启动日志用，也给客户端的"邀请二维码"用（手机扫的就是它）
const LAN_IPS = Object.values(os.networkInterfaces())
  .flat()
  .filter((n) => n && n.family === 'IPv4' && !n.internal)
  .map((n) => n.address);
server.listen(PORT, HOST, () => {
  const lan = LAN_IPS;
  console.log(`[bomb] 服务已启动，端口 ${PORT}`);
  console.log(`[bomb] 本机打开:   http://localhost:${PORT}`);
  for (const ip of lan) console.log(`[bomb] 同一局域网: http://${ip}:${PORT}`);
  if (!lan.length) console.log('[bomb] （没检测到局域网地址，其他设备请用本机 IP 访问）');
  console.log('');
  console.log('[bomb] 管理入口（只有你知道，别外传）:');
  console.log(`[bomb]   http://localhost:${PORT}/admin?token=${ADMIN_TOKEN}`);
  for (const ip of lan) console.log(`[bomb]   http://${ip}:${PORT}/admin?token=${ADMIN_TOKEN}`);
  console.log(`[bomb] 也可以用环境变量 BOMB_ADMIN_TOKEN 指定固定令牌`);
  console.log('');
  console.log(`[bomb] 想分享给外面的朋友（家里没有公网 IP）：node tools/share.mjs ${PORT}`);
});
