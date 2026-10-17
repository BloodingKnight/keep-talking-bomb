// Role-filtered projections of the authoritative game state.
//
// This is the single place that decides what each seat is allowed to see:
//   defuser -> the bomb modules, the timer, strikes; never the manual
//   expert  -> the manual (rule tables) + bomb casing facts; never the bomb state
//   partial expert seats get a deterministic slice of the answer-bearing rows, so
//   specialists must pool their half of the manual over voice or the text channel.

import { hashStr } from './rng.js';
import { ROLES, ROLE_INFO, EXTRA_EXPERT_ROLES, PORTS, BATTERY_TYPES, COLORS } from './vocab.js';

/** 会拿到手册（专家座位）的角色：expert / expert2 / expert3。 */
export function isExpertRole(role) {
  return role === ROLES.EXPERT || role === 'expert2' || role === 'expert3';
}

export function roleInfo(role) {
  return ROLE_INFO[role]
    || EXTRA_EXPERT_ROLES.find((r) => r.id === role)
    || ROLE_INFO[ROLES.EXPERT];
}

/** Deterministically hand row `i` of a partial group to expert seat `seat`. */
function seatFor(uid, i, total) {
  return (hashStr(`${uid}#${i}`) + i * 7) % total;
}

function splitRows(uid, rows, seat, ecount) {
  if (ecount <= 1) return rows.map((r, i) => ({ ...r, seat: 0 }));
  return rows
    .map((r, i) => ({ ...r, seat: seatFor(uid, i, ecount) }))
    .filter((r) => r.seat === seat);
}

function bombCasing(bomb) {
  return {
    serial: bomb.serial,
    batteries: bomb.batteries,
    batteryTypes: bomb.batteryTypes.map((t) => (BATTERY_TYPES.find((b) => b.id === t) || { name: t }).name),
    indicators: Object.keys(bomb.indicatorMap),
    ports: bomb.ports.map((p) => (PORTS.find((x) => x.id === p) || { name: p }).name),
  };
}

/**
 * Build the manual for one expert seat.
 * `mode` is 'full' (every seat gets everything) or 'partial' (rows are split).
 */
export function buildManual(bomb, seat, ecount, mode) {
  const sections = bomb.modules.map((mod) => {
    const groups = [];
    for (const g of mod.rules.groups) {
      const vis = g.visibility || 'full';
      if (g.kind === 'table') {
        const rows = vis === 'partial' && mode === 'partial'
          ? splitRows(mod.uid, g.rows, seat, ecount)
          : g.rows.map((r) => ({ ...r, seat: 0 }));
        groups.push({ kind: 'table', title: g.title, head: g.head, rows, split: vis === 'partial' && mode === 'partial' });
      } else if (g.kind === 'maze') {
        groups.push({ kind: 'maze', title: g.title, walls: g.walls, n: g.n });
      } else {
        groups.push({ kind: 'note', title: g.title });
      }
    }
    return {
      uid: mod.uid,
      title: mod.title,
      icon: mod.icon,
      tier: mod.tier,
      status: mod.status,
      asks: mod.asks,
      groups,
      partial: mode === 'partial' && mod.rules.groups.some((g) => g.visibility === 'partial'),
    };
  });

  return {
    mode,
    ecount,
    seat,
    colorLegend: ['red', 'blue', 'yellow', 'green', 'white', 'black'].map((c) => ({ name: COLORS[c].name, css: COLORS[c].css })),
    casing: bombCasing(bomb),
    sections,
  };
}

export function moduleStateForBomb(mod) {
  return { uid: mod.uid, id: mod.id, tier: mod.tier, title: mod.title, icon: mod.icon, status: mod.status, state: mod.state, note: mod.note };
}

export function publicPlayers(room) {
  return Object.values(room.players).map((p) => ({
    id: p.id,
    name: p.name,
    role: p.role,
    seat: p.seat,
    connected: p.connected,
    ready: !!p.ready,
  }));
}

export function roomSummary(room) {
  return {
    code: room.code,
    phase: room.phase,
    hostId: room.hostId,
    difficulty: room.difficulty,
    diffTable: room.diffTable || null,
    moduleCount: room.moduleCount || null,
    manualRows: room.manualRows || null,
    players: publicPlayers(room),
    expertSeats: room.expertSeats,
    createdAt: room.createdAt,
  };
}

export function playerState(room, player) {
  const info = roleInfo(player.role);
  const s = {
    serverTime: Date.now(),
    you: {
      id: player.id,
      role: player.role,
      name: player.name,
      seat: player.seat,
      roleInfo: info,
      // 'full' = 正常画面；'blind' = 只有白色轮廓（盲操猴）
      vision: info.vision || 'full',
    },
    room: roomSummary(room),
    log: room.log.slice(-60),
    chat: room.chat.slice(-120),
    // 手势/信号：给看得见队友的角色用（盲操猴看不见，所以不给他）
    signals: (info.vision === 'blind' ? [] : (room.signals || []).slice(-12)),
    // 盲操猴的光标：同样只给"看得见"的角色（他看不见屏幕，给他也没用）
    teammateCursor: (info.vision === 'blind' || !room.cursor) ? null : room.cursor,
  };

  if (room.phase === 'lobby') return s;

  s.bomb = {
    difficulty: room.bomb.difficulty,
    moduleCount: room.bomb.modules.length,
  };
  s.status = room.status;
  s.strikes = room.strikes;
  s.maxStrikes = room.bomb.maxStrikes;
  s.remainingMs = Math.max(0, room.deadline - Date.now());
  s.totalMs = room.bomb.durationMs;

  if (info.canSeeTime) s.remainingMsExact = s.remainingMs;

  s.canInteract = !!info.canInteract;
  s.canChat = !!info.canChat;

  if (info.seesBomb) {
    // 盲操猴的画面由客户端做"轮廓化"处理：服务端照常下发数据（他仍然要能点、能操作）
    s.bomb.moduleStates = room.bomb.modules.map(moduleStateForBomb);
  } else {
    s.bomb.moduleStates = room.bomb.modules.map((m) => ({
      uid: m.uid, id: m.id, tier: m.tier, title: m.title, icon: m.icon, status: m.status,
    }));
  }

  if (info.canManual) {
    // 角色要求的拆分方式优先于难度默认值（静默/盲眼这类角色固定拿半本）
    const mode = info.manualRows || room.manualRows || 'full';
    s.manual = buildManual(room.bomb, player.seat || 0, room.expertSeats, mode);
    s.canManual = true;
  }

  if (room.phase === 'ended') {
    s.result = {
      ...room.result,
      moduleReveal: room.bomb.modules.map((m) => ({
        uid: m.uid, title: m.title, icon: m.icon, tier: m.tier, status: m.status,
      })),
    };
  }
  return s;
}
