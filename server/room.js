// Session management: rooms, players, join codes, role assignment, phases.
// Zero dependencies. One process can host many rooms.

import crypto from 'node:crypto';
import { Rng, fmtTime } from '../lib/rng.js';
import { makeBomb, scoreRun } from '../lib/bomb.js';
import { MODULES } from '../lib/modules.js';
import {
  ROLES, ROLE_INFO, EXTRA_EXPERT_ROLES, MAX_PLAYERS, DIFFICULTIES, DIFFICULTY_ORDER, ROLE_PRESETS,
} from '../lib/vocab.js';
import { roomSummary, playerState, isExpertRole, roleInfo } from '../lib/view.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PLAYER_TIMEOUT_MS = 45000;
/** 占同一个"动手座位"的角色：拆弹者 / 静默操作员 / 盲操猴 */
export const HANDS_ROLES = [ROLES.DEFUSER, ROLES.MUTE, ROLES.BLIND_OP];
/** 当专家的角色（能拿手册的都在这里） */
const EXPERT_ROLE_IDS = [ROLES.EXPERT, ROLES.BLIND, ROLES.DEAF_SEE, ROLES.MUTE_EXP, ...EXTRA_EXPERT_ROLES.map((r) => r.id)];

export function makeCode(len = 4) {
  let out = '';
  const bytes = crypto.randomBytes(len);
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

export function uid() {
  return crypto.randomBytes(9).toString('base64url');
}

export class Game {
  constructor() {
    this.rooms = new Map(); // code -> room
    this.listeners = new Set(); // {roomCode, fn}
  }

  // ---------------------------------------------------------------- rooms
  createRoom({ difficulty = 'normal', hostName = '房主', seed } = {}) {
    let code;
    do { code = makeCode(4); } while (this.rooms.has(code));
    const room = {
      code,
      createdAt: Date.now(),
      hostId: null,
      players: {},
      phase: 'lobby',
      difficulty: DIFFICULTIES[difficulty] ? difficulty : 'normal',
      diffTable: null,
      moduleCount: null,
      manualRows: null,
      expertSeats: 1,
      bomb: null,
      strikes: 0,
      status: 'running',
      deadline: 0,
      result: null,
      startedAt: 0,
      log: [],
      chat: [],
      seed: seed || crypto.randomBytes(8).toString('hex'),
      seq: 0,
      rev: 0,
    };
    this.rooms.set(code, room);
    this.log(room, `${hostName} 创建了房间 ${code}`);
    return room;
  }

  getRoom(code) { return this.rooms.get(String(code || '').toUpperCase()); }

  // ---------------------------------------------------------------- players
  joinRoom(room, { name, role, playerId }) {
    let player = playerId ? room.players[playerId] : null;
    if (player) {
      player.name = sanitizeName(name) || player.name;
      player.lastSeen = Date.now();
      player.connected = true;
      return player;
    }
    const id = playerId && !room.players[playerId] ? playerId : uid();
    const count = Object.keys(room.players).length;
    if (count >= MAX_PLAYERS) throw new Error('房间已满（最多 6 人）');
    player = {
      id,
      name: sanitizeName(name) || `玩家${count + 1}`,
      role: null,
      seat: 0,
      connected: true,
      lastSeen: Date.now(),
      ready: false,
    };
    // 加入时指定的角色：空着就直接给他；已经有人了就只作为"建议角色"，
    // 让这位玩家在准备区自己挑一个（不会悄悄顶掉别人的座位）。
    if (role && isKnownRole(role)) {
      if (this.validRole(room, role)) player.role = role;
      else player.suggestedRole = this.assignRole(room, role);
    } else {
      player.suggestedRole = this.assignRole(room, null);
    }
    room.players[id] = player;
    if (!room.hostId) room.hostId = id;
    this.log(room, `${player.name} 加入了房间`);
    this.recomputeSeats(room);
    return player;
  }

  /** 一个座位只有一个"动手"角色（拆弹者 / 静默操作员 / 盲操猴），专家座位有 1 + N 个。 */
  validRole(room, role, exceptId) {
    const others = Object.values(room.players).filter((p) => p.id !== exceptId);
    if (HANDS_ROLES.includes(role)) {
      return !others.some((p) => HANDS_ROLES.includes(p.role));
    }
    const experts = others.filter((p) => isExpertRole(p.role));
    const seatCap = 1 + EXTRA_EXPERT_ROLES.length; // expert, expert2, expert3
    return experts.length < seatCap;
  }

  /** 给新玩家挑一个还没被占的角色。指定的角色被占了就退而求其次。 */
  assignRole(room, preferred) {
    if (preferred && isKnownRole(preferred) && this.validRole(room, preferred)) return preferred;
    const wantHands = preferred ? HANDS_ROLES.includes(preferred) : false;
    const wantExpert = preferred ? isExpertRole(preferred) : false;
    const order = wantHands
      ? [...HANDS_ROLES]
      : wantExpert
        ? EXPERT_ROLE_IDS
        : [...HANDS_ROLES, ...EXPERT_ROLE_IDS];
    for (const role of order) if (this.validRole(room, role)) return role;
    return null;
  }

  /** 一键套用推荐的角色组合（按当前玩家顺序分配）。 */
  applyPreset(room, presetId) {
    const preset = ROLE_PRESETS.find((p) => p.id === presetId);
    if (!preset) throw new Error('没有这个角色预设');
    const players = Object.values(room.players);
    if (players.length < preset.roles.length) {
      throw new Error(`这个预设需要 ${preset.roles.length} 名玩家（现在是 ${players.length} 名）`);
    }
    // 先清空，再按顺序占位
    for (const p of players) p.role = null;
    preset.roles.forEach((role, i) => {
      const p = players[i];
      if (p && isKnownRole(role)) p.role = role;
    });
    this.recomputeSeats(room);
    this.log(room, `套用了角色预设：${preset.name}`);
    return preset;
  }

  setRole(room, playerId, role) {
    const player = room.players[playerId];
    if (!player) throw new Error('玩家不存在');
    if (!isKnownRole(role)) throw new Error('角色不存在');
    if (player.role === role) return player;                       // 本来就是
    // 同家族内换座位（expert <-> expert2、defuser <-> mute）不占新座位；
    // 换到另一个家族时要把自己算进去，避免超员。
    const family = (r) => (HANDS_ROLES.includes(r) ? 'hands' : 'expert');
    const sameFamily = player.role && family(player.role) === family(role);
    if (!this.validRole(room, role, sameFamily ? undefined : playerId)) {
      const capacity = family(role) === 'hands' ? '动手角色（拆弹者 / 静默操作员 / 盲操猴）' : '专家座位';
      throw new Error(`${capacity}已经满了，请换一个角色`);
    }
    player.role = role;
    this.recomputeSeats(room);
    this.log(room, `${player.name} 选择了角色：${roleInfo(role).name}`);
    return player;
  }

  /** Defuser first, then expert seats 0..n. */
  recomputeSeats(room) {
    const list = Object.values(room.players);
    list.sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
    let seat = 0;
    let count = 0;
    for (const p of list) {
      if (isExpertRole(p.role)) {
        p.seat = seat++;
        count++;
      } else {
        p.seat = 0;
      }
    }
    room.expertSeats = Math.max(1, count);
  }

  autoAssign(room) {
    const list = Object.values(room.players);
    if (!list.length) throw new Error('房间里没有人');
    // 只补"还没选角色"的人；已经选好的（尤其是套用了三人经典预设的）绝不动
    const handsRole = () => list.find((p) => HANDS_ROLES.includes(p.role));
    const unassigned = () => list.filter((p) => !p.role);
    // 缺动手角色就补一个
    if (!handsRole()) {
      const p = unassigned()[0] || null;
      if (p) p.role = ROLES.DEFUSER;
    }
    // 缺专家就按空座位补
    let expertSeat = list.filter((p) => isExpertRole(p.role)).length;
    let extraIdx = Math.max(0, expertSeat - 1);
    for (const p of unassigned()) {
      if (expertSeat === 0) p.role = ROLES.EXPERT;
      else p.role = (EXTRA_EXPERT_ROLES[Math.min(extraIdx++, EXTRA_EXPERT_ROLES.length - 1)] || {}).id || ROLES.EXPERT;
      expertSeat++;
    }
    // 兜底：确认两边都有人
    if (!handsRole()) {
      const first = list[0];
      if (first) first.role = ROLES.DEFUSER;
    }
    if (!list.some((p) => isExpertRole(p.role))) {
      const other = list.find((p) => !HANDS_ROLES.includes(p.role));
      if (other) other.role = ROLES.EXPERT;
    }
    this.recomputeSeats(room);
    this.log(room, '系统自动分配了角色');
  }

  // ---------------------------------------------------------------- game flow
  configure(room, { difficulty, moduleCount, manualRows, timeSec }) {
    if (difficulty && DIFFICULTIES[difficulty]) room.difficulty = difficulty;
    room.moduleCount = moduleCount ? Math.max(1, Math.min(10, Number(moduleCount) | 0)) : null;
    room.manualRows = manualRows || null;
    // 可选的倒计时覆盖（自动化测试 / 房主自定义时长）
    room.timeSecOverride = timeSec ? Math.max(10, Math.min(3600, Number(timeSec) | 0)) : null;
    this.log(room, `设置：难度 ${DIFFICULTIES[room.difficulty].name}${room.moduleCount ? `，模块数 ${room.moduleCount}` : ''}${room.timeSecOverride ? `，倒计时 ${room.timeSecOverride}s` : ''}`);
  }

  start(room) {
    if (room.phase !== 'lobby' && room.phase !== 'ended') throw new Error('游戏已经开始');
    const players = Object.values(room.players);
    if (players.length < 1) throw new Error('至少需要 1 名玩家');

    // 「动手」的三个角色都算操作者：拆弹者 / 静默操作员 / 盲操猴（三人经典里就是盲操猴）
    const OPERATOR_ROLES = [ROLES.DEFUSER, ROLES.MUTE, 'blindop'];
    const hasOperator = players.some((p) => OPERATOR_ROLES.includes(p.role));
    if (!hasOperator) this.autoAssign(room);

    // 「能看手册」的判断直接看角色元数据，而不是只认 expert/expert2/expert3 ——
    // 否则三人经典（盲操猴 + 聋桥猴 + 哑手册猴）会因为"没有专家"而开不了局。
    const hasReader = Object.values(room.players).some((p) => {
      const info = roleInfo(p.role);
      return !!(info && info.canManual);
    });
    if (!hasReader) {
      throw new Error('至少需要 1 名能看手册的玩家：专家 / 盲眼观察员 / 聋桥猴 / 哑手册猴');
    }

    const diff = DIFFICULTIES[room.difficulty];
    const manualRows = room.manualRows || diff.manualRows;
    room.manualRows = manualRows;
    room.bomb = makeBomb({ seed: room.seed, difficulty: room.difficulty, moduleCount: room.moduleCount });
    if (room.timeSecOverride) room.bomb.durationMs = room.timeSecOverride * 1000;
    room.strikes = 0;
    room.status = 'running';
    room.phase = 'playing';
    room.startedAt = Date.now();
    room.deadline = Date.now() + room.bomb.durationMs;
    room.result = null;
    room.actions = 0;
    this.log(room, `炸弹已激活：${room.bomb.modules.length} 个模块、${fmtTime(room.bomb.durationMs)}、${room.bomb.maxStrikes} 次失误上限`);
    return room;
  }

  restart(room, opts = {}) {
    room.seed = opts.seed || crypto.randomBytes(8).toString('hex');
    room.phase = 'lobby';
    room.bomb = null;
    room.result = null;
    room.strikes = 0;
    room.status = 'running';
    this.log(room, '回到准备阶段，可以再来一局');
  }

  /** Apply a player action to a module. Returns a note for the log. */
  act(room, player, { uid: modUid, action }) {
    if (room.phase !== 'playing') throw new Error('游戏还没开始或已经结束');
    const info = roleInfo(player.role);
    if (!info.canInteract) throw new Error(`${info.name} 不能操作炸弹`);
    const mod = room.bomb.modules.find((m) => m.uid === modUid);
    if (!mod) throw new Error('模块不存在');
    if (mod.status === 'solved') return { note: '模块已经拆除了' };
    const def = MODULES[mod.id];
    const ctx = { strikes: room.strikes, remainingMs: Math.max(0, room.deadline - Date.now()), player, room };
    let res;
    const kind = action.type;
    if (def.extraActions && kind === 'transmit') res = def.submit(mod, action, ctx);
    else res = def.apply(mod, action, ctx);
    if (!res) res = {};
    if (res.error) return { error: res.error };
    room.actions++;

    if (res.reset || res.strike) {
      if (def.resetState) def.resetState(mod);
    }
    if (res.solved) {
      mod.status = 'solved';
      mod.note = res.note || '';
      if (mod.defusedNow) mod.defusedNow = 0;
      this.log(room, `✅ ${mod.title}（${mod.uid}）已拆除：${res.note || ''}`);
      this.checkWin(room);
    } else if (res.strike) {
      room.strikes++;
      mod.note = res.note || '';
      this.log(room, `❌ 失误 ${room.strikes}/${room.bomb.maxStrikes}：${mod.title} —— ${res.note || ''}`);
      room.deadline -= room.bomb.timePenaltyMs;
      if (room.strikes >= room.bomb.maxStrikes) this.endGame(room, 'exploded');
    } else if (res.note) {
      mod.note = res.note;
      this.log(room, `· ${mod.title}：${res.note}`);
    }
    return res;
  }

  checkWin(room) {
    if (room.bomb.modules.every((m) => m.status === 'solved')) this.endGame(room, 'defused');
  }

  tick(room) {
    if (room.phase !== 'playing') return false;
    if (Date.now() >= room.deadline) {
      this.endGame(room, 'timeout');
      return true;
    }
    return false;
  }

  endGame(room, status) {
    if (room.phase === 'ended') return;
    room.phase = 'ended';
    room.status = status;
    const remainingMs = Math.max(0, room.deadline - Date.now());
    const score = scoreRun(room.bomb, { remainingMs, strikes: room.strikes, status });
    room.result = {
      status,
      statusText: { defused: '拆弹成功', exploded: '失误过多 —— 爆炸', timeout: '时间耗尽 —— 爆炸' }[status],
      strikes: room.strikes,
      remainingMs,
      score,
      durationMs: Date.now() - room.startedAt,
      solvedModules: score.solved,
      totalModules: score.total,
    };
    this.log(room, status === 'defused'
      ? `🎉 拆弹成功！得分 ${score.score}`
      : `💥 ${room.result.statusText}。得分 ${score.score}`);
  }

  // ---------------------------------------------------------------- chat / presence
  chat(room, player, text) {
    const clean = String(text || '').slice(0, 400).trim();
    if (!clean) return;
    const msg = { id: uid(), from: player.id, name: player.name, role: player.role, text: clean, at: Date.now(), channel: 'all' };
    room.chat.push(msg);
    if (room.chat.length > 200) room.chat.splice(0, room.chat.length - 200);
    return msg;
  }

  /**
   * 盲操猴的光标广播：让"看得见"的队友知道他在点哪里。
   * 只记最近一次位置，随视图广播；不改变任何游戏状态。
   */
  cursor(room, player, { uid, x, y }) {
    const clamp = (v) => Math.max(0, Math.min(1, Number(v) || 0));
    room.cursor = {
      by: player.id,
      name: player.name,
      role: player.role,
      uid: String(uid || '').slice(0, 40),
      x: clamp(x),
      y: clamp(y),
      at: Date.now(),
    };
    return room.cursor;
  }

  /**
   * 手势 / 信号：给"聋桥猴"这类角色一个不用声音的表达方式。
   * 只记录最近 12 条，随视图广播，不改变任何游戏状态。
   */
  signal(room, player, kind, text) {
    if (!room.signals) room.signals = [];
    room.signals.push({
      id: uid(),
      from: player.id,
      name: player.name,
      role: player.role,
      kind: String(kind).slice(0, 24),
      text: text ? String(text).slice(0, 60) : '',
      at: Date.now(),
    });
    if (room.signals.length > 12) room.signals.splice(0, room.signals.length - 12);
    return room.signals[room.signals.length - 1];
  }

  log(room, text) {
    room.log.push({ at: Date.now(), text });
    if (room.log.length > 400) room.log.splice(0, room.log.length - 400);
  }

  /** 掉线（还留在房间里，靠 sessionStorage 可以重连回来）。 */
  leave(room, playerId) {
    const p = room.players[playerId];
    if (!p) return;
    p.connected = false;
    p.lastSeen = Date.now();
    this.log(room, `${p.name} 断线了`);
    this.transferHost(room, playerId);
  }

  /**
   * 主动退出房间：准备阶段直接把人移出去；游戏进行中只标记离线，
   * 这样刷新/掉线还能回到原来的座位。退到没人了就顺手删掉房间。
   */
  removePlayer(room, playerId) {
    const p = room.players[playerId];
    if (!p) return { removed: false };
    if (room.phase === 'lobby') {
      delete room.players[playerId];
      this.log(room, `${p.name} 离开了房间`);
    } else {
      p.connected = false;
      p.lastSeen = Date.now();
      this.log(room, `${p.name} 退出了游戏（座位保留，可重连）`);
    }
    this.transferHost(room, playerId);
    this.recomputeSeats(room);
    if (!Object.keys(room.players).length) {
      this.deleteRoom(room.code);
      return { removed: true, roomDeleted: true };
    }
    return { removed: true };
  }

  transferHost(room, goneId) {
    if (room.hostId !== goneId) return;
    const next = Object.values(room.players).find((x) => x.id !== goneId && x.connected);
    room.hostId = next ? next.id : null;
    if (next) this.log(room, `房主转给了 ${next.name}`);
  }

  /** 房主关掉整个房间：所有人回主界面。 */
  closeRoom(room, byPlayer) {
    for (const p of Object.values(room.players)) p.connected = false;
    this.log(room, `${byPlayer ? byPlayer.name : '房主'} 关闭了房间`);
    for (const [code, r] of this.rooms) if (r === room) this.rooms.delete(code);
  }

  deleteRoom(code) {
    const room = this.getRoom(code);
    if (room) this.log(room, '房间已空，自动关闭');
    this.rooms.delete(String(code || '').toUpperCase());
  }

  /** 房间列表：只列出还能进去的（准备中/进行中）且有人在线的房间。 */
  listRooms() {
    const now = Date.now();
    return [...this.rooms.values()]
      .filter((r) => r.phase !== 'ended')
      .filter((r) => Object.values(r.players).some((p) => p.connected))
      .map((r) => ({
        code: r.code,
        phase: r.phase,
        difficulty: r.difficulty,
        players: Object.values(r.players).filter((p) => p.connected).length,
        maxPlayers: MAX_PLAYERS,
        manualRows: r.manualRows || null,
        createdAt: r.createdAt,
        joined: Object.values(r.players).filter((p) => p.connected).map((p) => ({ name: p.name, role: p.role })),
        ageMs: now - r.createdAt,
      }))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 30);
  }

  sweep() {
    const now = Date.now();
    for (const room of this.rooms.values()) {
      for (const p of Object.values(room.players)) {
        if (p.connected && now - p.lastSeen > PLAYER_TIMEOUT_MS) {
          p.connected = false;
          this.log(room, `${p.name} 掉线了（心跳超时）`);
        }
      }
      // 空房间：准备阶段立刻回收，进行中的给一段时间等重连
      const anyone = Object.values(room.players).some((p) => p.connected);
      if (!anyone) {
        const grace = room.phase === 'lobby' ? 30 * 1000 : 30 * 60 * 1000;
        if (now - (room.lastActivity || room.createdAt) > grace) this.rooms.delete(room.code);
      }
    }
  }

  /** Per-player view, used by the SSE stream. */
  viewsFor(room) {
    const out = [];
    for (const p of Object.values(room.players)) {
      out.push([p.id, playerState(room, p)]);
    }
    return out;
  }

  summary(room) { return roomSummary(room); }
}

function sanitizeName(name) {
  return String(name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16);
}

const KNOWN_ROLES = new Set([...Object.keys(ROLE_INFO), ...EXTRA_EXPERT_ROLES.map((r) => r.id)]);

function isKnownRole(role) {
  return KNOWN_ROLES.has(role);
}

export { DIFFICULTY_ORDER, ROLES, ROLE_INFO, MAX_PLAYERS, isKnownRole };
