// 骗子酒馆（Liar's Bar）—— 服务端权威的纸牌 + 左轮游戏引擎。
//
// 规则（经典骗子纸牌）：
//   · 2~4 人，每人每轮摸 5 张牌；牌堆是 Q×6、K×6、A×6、J×2（J 是赖子，可当目标牌）。
//   · 每轮随机指定一张目标牌（Q / K / A），出牌的人只能"声称"自己出的是目标牌。
//   · 轮到自己时：出 1~3 张盖着的牌，或者质疑上家（Liar!）。不能过牌。
//   · 被质疑就亮牌：出的牌全是目标牌或赖子 → 质疑者对自己开一枪；否则出牌的人开一枪。
//   · 每个人的左轮有 6 个弹巢、1 发实弹；实弹位置在开局随机固定，开到那一枪就出局。
//   · 有人出完手牌时，只有他的下家还能质疑；下家不质疑，他就赢下这一轮。
//   · 一枪就是一轮的结束；所有人重新摸 5 张、换一张目标牌。
//   · 上一轮的输家（挨枪的人）下一轮先出；如果那一轮没人挨枪，就由赢家先出。
//   · 最后活下来的人赢。
//
// 这个文件是纯逻辑，不碰 HTTP / 文件 / 定时器；房间管理、时间推进都在这里，
// 传输层（server.js / Cloudflare Durable Object）只负责把视图发出去。
// 这样引擎可以脱离服务器直接单测（tests/liar-engine.mjs）。

import { Rng } from './rng.js';

export const LIAR_TABLE_RANKS = ['Q', 'K', 'A'];
export const LIAR_JOKER = 'J';
export const LIAR_HAND_SIZE = 5;
export const LIAR_CHAMBERS = 6;
export const LIAR_MIN_PLAY = 1;
export const LIAR_MAX_PLAY = 3;
export const LIAR_MIN_PLAYERS = 2;
export const LIAR_MAX_PLAYERS = 4;
export const LIAR_REVEAL_MS = 4600;
export const LIAR_PASS_REVEAL_MS = 2800;
/** 断线玩家的出牌托管时间（毫秒） */
export const LIAR_OFFLINE_AUTO_MS = 15000;
export const LIAR_TURN_SECONDS = [0, 30, 45, 60];
export const LIAR_RULES = {
  name: '骗子酒馆',
  en: "Liar's Bar",
  minPlayers: LIAR_MIN_PLAYERS,
  maxPlayers: LIAR_MAX_PLAYERS,
  handSize: LIAR_HAND_SIZE,
  chambers: LIAR_CHAMBERS,
  deck: 'Q×6 / K×6 / A×6 / J×2（J 是赖子）',
  maxPlay: LIAR_MAX_PLAY,
  turnSeconds: LIAR_TURN_SECONDS,
};

export const LIAR_RANK_INFO = {
  Q: { id: 'Q', name: '皇后', icon: '👑', color: '#f0abfc', wild: false },
  K: { id: 'K', name: '国王', icon: '🤴', color: '#fcd34d', wild: false },
  A: { id: 'A', name: '尖刀', icon: '⚔️', color: '#7dd3fc', wild: false },
  J: { id: 'J', name: '赖子', icon: '🃏', color: '#a3e635', wild: true },
};

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉易混淆的 I O 0 1
const RANK_ORDER = { Q: 0, K: 1, A: 2, J: 3 };

export function rankOf(card) {
  return String(card || '')[0] || '?';
}

export function isWildCard(card) {
  return rankOf(card) === LIAR_JOKER;
}

export function cardInfo(card) {
  const rank = rankOf(card);
  return { id: String(card), rank, ...(LIAR_RANK_INFO[rank] || { name: '?', icon: '?', color: '#8b98a9', wild: false }) };
}

/** 把一手牌按 Q、K、A、赖子 排好，方便客户端展示。 */
export function sortHand(hand) {
  return [...hand].sort((a, b) => {
    const ra = RANK_ORDER[rankOf(a)] ?? 9;
    const rb = RANK_ORDER[rankOf(b)] ?? 9;
    if (ra !== rb) return ra - rb;
    return String(a).localeCompare(String(b));
  });
}

export function buildLiarDeck() {
  const deck = [];
  for (const rank of LIAR_TABLE_RANKS) for (let i = 1; i <= 6; i++) deck.push(`${rank}${i}`);
  deck.push('J1', 'J2');
  return deck;
}

export function isValidCard(card) {
  return buildLiarDeck().includes(String(card));
}

function cleanName(name) {
  return String(name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16);
}

let fallbackSeq = 0;

/**
 * 房间/对局管理 + 规则状态机。
 * 依赖可注入，测试里可以固定时间、房间号和玩家 id。
 */
export class LiarGame {
  constructor({ now = Date.now, makeId, makeCode } = {}) {
    this.rooms = new Map();
    this.now = now;
    this.makeId = makeId || (() => `p${(++fallbackSeq).toString(36)}${Math.random().toString(36).slice(2, 6)}`);
    this.makeCode = makeCode || (() => {
      let out = '';
      for (let i = 0; i < 4; i++) out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
      return out;
    });
  }

  // --------------------------------------------------------------- 房间
  createRoom({ hostName = '房主', seed, turnSeconds = 0 } = {}) {
    let code;
    do { code = this.makeCode(); } while (this.rooms.has(code));
    const now = this.now();
    const room = {
      code,
      createdAt: now,
      lastActivity: now,
      hostId: null,
      players: {},
      phase: 'lobby',
      config: { turnSeconds: normalizeTurnSeconds(turnSeconds) },
      round: 0,
      tableCard: null,
      stage: 'turn',
      turnId: null,
      turnDeadline: 0,
      lastPlay: null,
      finalPlayerId: null,
      reveal: null,
      revealUntil: 0,
      roundLoserId: null,
      roundWinnerId: null,
      pendingWinnerId: null,
      winnerId: null,
      result: null,
      startedAt: 0,
      log: [],
      chat: [],
      seed: seed || `${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      rng: null,
      rev: 0,
    };
    room.rng = new Rng(room.seed);
    this.rooms.set(code, room);
    this.log(room, `${cleanName(hostName) || '房主'} 创建了房间 ${code}`);
    return room;
  }

  getRoom(code) {
    return this.rooms.get(String(code || '').toUpperCase());
  }

  orderedPlayers(room) {
    return Object.values(room.players).sort((a, b) => (a.seat - b.seat) || (a.joinedAt - b.joinedAt));
  }

  alivePlayers(room) {
    return this.orderedPlayers(room).filter((p) => p.alive);
  }

  joinRoom(room, { name, playerId } = {}) {
    const existing = playerId ? room.players[playerId] : null;
    if (existing) {
      existing.name = cleanName(name) || existing.name;
      existing.connected = true;
      existing.lastSeen = this.now();
      if (room.phase === 'playing' || room.phase === 'reveal') this.armTurn(room);
      return existing;
    }
    if (room.phase !== 'lobby') throw new Error('这一局已经开始了，等他们打完再进来吧');
    const count = Object.keys(room.players).length;
    if (count >= LIAR_MAX_PLAYERS) throw new Error(`酒馆坐满了（最多 ${LIAR_MAX_PLAYERS} 人）`);
    const id = playerId && !room.players[playerId] ? String(playerId) : this.makeId();
    const now = this.now();
    const player = {
      id,
      name: cleanName(name) || `酒客${count + 1}`,
      seat: count,
      connected: true,
      lastSeen: now,
      joinedAt: now,
      alive: true,
      hand: [],
      shots: 0,
      bulletAt: 0,
      eliminatedRound: 0,
    };
    room.players[id] = player;
    if (!room.hostId) room.hostId = id;
    this.log(room, `${player.name} 走进了酒馆`);
    return player;
  }

  /** 房主在准备区设置：出牌倒计时（0 = 关闭）。 */
  configure(room, { turnSeconds } = {}) {
    if (room.phase !== 'lobby') throw new Error('只能在准备阶段修改设置');
    if (turnSeconds !== undefined) room.config.turnSeconds = normalizeTurnSeconds(turnSeconds);
    this.log(room, room.config.turnSeconds
      ? `设置：出牌倒计时 ${room.config.turnSeconds} 秒（超时自动出 1 张）`
      : '设置：出牌不限时');
    return room.config;
  }

  start(room) {
    if (room.phase !== 'lobby' && room.phase !== 'ended') throw new Error('游戏已经开始了');
    const players = this.orderedPlayers(room);
    if (players.length < LIAR_MIN_PLAYERS) throw new Error(`至少需要 ${LIAR_MIN_PLAYERS} 名玩家（现在 ${players.length} 名）`);
    if (players.length > LIAR_MAX_PLAYERS) throw new Error(`最多 ${LIAR_MAX_PLAYERS} 名玩家`);
    if (players.filter((p) => p.connected).length < LIAR_MIN_PLAYERS) throw new Error('至少需要 2 名在线玩家');

    for (const p of players) {
      p.alive = true;
      p.hand = [];
      p.shots = 0;
      p.eliminatedRound = 0;
      p.bulletAt = room.rng.range(1, LIAR_CHAMBERS);
    }
    room.phase = 'playing';
    room.stage = 'turn';
    room.round = 0;
    room.lastPlay = null;
    room.reveal = null;
    room.revealUntil = 0;
    room.winnerId = null;
    room.result = null;
    room.roundLoserId = null;
    room.roundWinnerId = null;
    room.pendingWinnerId = null;
    room.finalPlayerId = null;
    room.startedAt = this.now();
    const first = players[room.rng.int(players.length)];
    this.startRound(room, first.id, { firstRound: true });
    this.log(room, `🎬 开局：${players.length} 人，每人左轮 6 个弹巢、1 发实弹。`);
    return room;
  }

  startRound(room, starterId, { firstRound = false } = {}) {
    const active = this.alivePlayers(room);
    if (active.length < 2) {
      this.endGame(room, active[0] ? active[0].id : null);
      return;
    }
    room.round += 1;
    room.phase = 'playing';
    room.tableCard = room.rng.pick(LIAR_TABLE_RANKS);
    room.lastPlay = null;
    room.reveal = null;
    room.revealUntil = 0;
    room.finalPlayerId = null;
    room.roundLoserId = null;
    room.roundWinnerId = null;
    room.pendingWinnerId = null;
    room.stage = 'turn';

    const deck = room.rng.shuffle(buildLiarDeck());
    for (const p of this.orderedPlayers(room)) {
      p.hand = p.alive ? deck.splice(0, LIAR_HAND_SIZE) : [];
    }
    const starter = active.find((p) => p.id === starterId) || active[0];
    room.turnId = starter.id;
    this.armTurn(room);
    this.log(room, `第 ${room.round} 轮开始：目标牌是 ${room.tableCard}${room.tableCard === 'Q' ? '（皇后）' : room.tableCard === 'K' ? '（国王）' : '（尖刀）'}，${starter.name} 先出牌。`);
    if (firstRound) this.log(room, '提示：手里的 J 是赖子，可以当目标牌打出。');
  }

  /** 轮到自己：出 1~3 张牌，声称是目标牌。 */
  play(room, player, cardIds) {
    this.assertInTurn(room, player, { allowFinal: false });
    const ids = [...new Set((Array.isArray(cardIds) ? cardIds : []).map(String))];
    if (ids.length < LIAR_MIN_PLAY || ids.length > LIAR_MAX_PLAY) {
      throw new Error(`一次只能出 ${LIAR_MIN_PLAY}~${LIAR_MAX_PLAY} 张牌`);
    }
    const missing = ids.filter((id) => !player.hand.includes(id));
    if (missing.length) throw new Error('你手里没有这张牌');

    player.hand = player.hand.filter((id) => !ids.includes(id));
    room.lastPlay = {
      playerId: player.id,
      name: player.name,
      count: ids.length,
      cards: ids,
      claimedRank: room.tableCard,
      at: this.now(),
    };

    if (player.hand.length === 0) {
      // 出完手牌：下家可以选择质疑，也可以放过（放过 = 本轮他赢）
      const next = this.nextAliveId(room, player.id);
      room.stage = 'finalcall';
      room.finalPlayerId = player.id;
      room.turnId = next;
      this.armTurn(room);
      const nextP = room.players[next];
      this.log(room, `${player.name} 打完了最后 ${ids.length} 张，声称是 ${room.tableCard}。${nextP ? `${nextP.name} 只有两个选择：质疑，或者放过他。` : ''}`);
    } else {
      room.turnId = this.nextAliveId(room, player.id);
      this.armTurn(room);
      this.log(room, `${player.name} 出了 ${ids.length} 张，声称是 ${room.tableCard}（手里还剩 ${player.hand.length} 张）。`);
    }
    return room.lastPlay;
  }

  /** 质疑上家：亮牌 → 说谎的人 / 质疑错的人，对自己开一枪。 */
  challenge(room, player) {
    if (room.phase !== 'playing') throw new Error('游戏不在进行中');
    const last = room.lastPlay;
    if (last && last.playerId === player.id) throw new Error('不能质疑自己的出牌');
    this.assertInTurn(room, player);
    if (!last) throw new Error('上家还没出牌，没什么可质疑的');
    const target = room.players[last.playerId];
    if (!target) throw new Error('上家已经不在房间里了');
    const cards = last.cards.map((id) => {
      const rank = rankOf(id);
      const match = rank === room.tableCard || rank === LIAR_JOKER;
      return { id, rank, wild: rank === LIAR_JOKER, match };
    });
    const honest = cards.every((c) => c.match);
    const challenger = player;
    const shooter = honest ? challenger : target;
    const winner = honest ? target : challenger;
    this.resolveShot(room, {
      challenger,
      target,
      shooter,
      winner,
      cards,
      honest,
    });
    return room.reveal;
  }

  /** 下家放过"已经出完手牌"的玩家：本轮直接结束，出完牌的人赢。 */
  passFinal(room, player) {
    if (room.phase !== 'playing' || room.stage !== 'finalcall') throw new Error('现在不是"放不放过"的时机');
    if (room.turnId !== player.id) throw new Error('现在不是你做决定');
    const winner = room.players[room.finalPlayerId];
    if (!winner) throw new Error('出完牌的玩家已经不在了');
    const now = this.now();
    room.phase = 'reveal';
    room.stage = 'reveal';
    room.turnDeadline = 0;
    room.roundWinnerId = winner.id;
    room.roundLoserId = null;
    room.reveal = {
      kind: 'passed',
      tableCard: room.tableCard,
      challengerId: player.id,
      challengerName: player.name,
      winnerId: winner.id,
      winnerName: winner.name,
      playCount: room.lastPlay ? room.lastPlay.count : 0,
      at: now,
      until: now + LIAR_PASS_REVEAL_MS,
    };
    room.revealUntil = room.reveal.until;
    this.log(room, `${player.name} 选择不质疑，${winner.name} 赢下第 ${room.round} 轮（没有挨枪）。`);
    return room.reveal;
  }

  resolveShot(room, { challenger, target, shooter, winner, cards, honest }) {
    const now = this.now();
    shooter.shots += 1;
    const died = shooter.shots >= shooter.bulletAt && shooter.bulletAt > 0;
    if (died) {
      shooter.alive = false;
      shooter.eliminatedRound = room.round;
      shooter.hand = [];
    }
    room.phase = 'reveal';
    room.stage = 'reveal';
    room.turnDeadline = 0;
    room.roundLoserId = shooter.id;
    room.roundWinnerId = winner.id;
    room.reveal = {
      kind: 'challenge',
      tableCard: room.tableCard,
      challengerId: challenger.id,
      challengerName: challenger.name,
      targetId: target.id,
      targetName: target.name,
      cards,
      honest,
      shooterId: shooter.id,
      shooterName: shooter.name,
      shot: { playerId: shooter.id, name: shooter.name, chamber: shooter.shots, died },
      winnerId: winner.id,
      winnerName: winner.name,
      at: now,
      until: now + LIAR_REVEAL_MS,
    };
    room.revealUntil = room.reveal.until;
    this.log(room, `${challenger.name} 质疑 ${target.name}：亮出 ${cards.map((c) => c.rank).join(' ')}${honest ? ` —— 全是 ${room.tableCard}，质疑失败！` : ' —— 抓到骗子！'}`);
    if (died) {
      this.log(room, `🔫 ${shooter.name} 对着自己扣下第 ${shooter.shots}/6 枪…… 💥 出局！`);
    } else {
      this.log(room, `🔫 ${shooter.name} 对自己扣下第 ${shooter.shots}/6 枪…… 只有空响，活了下来。`);
    }
    const alive = this.alivePlayers(room);
    if (alive.length <= 1) room.pendingWinnerId = alive[0] ? alive[0].id : (winner ? winner.id : null);
    else room.pendingWinnerId = null;
    return room.reveal;
  }

  /** 一轮结束 → 开下一轮；或者只剩一人 → 结束整局。 */
  advance(room) {
    if (room.phase !== 'reveal') return false;
    if (room.pendingWinnerId) {
      this.endGame(room, room.pendingWinnerId);
      return true;
    }
    const loser = room.roundLoserId ? room.players[room.roundLoserId] : null;
    let starterId;
    if (loser) {
      // 上一轮的输家先出；如果他死了，就顺延给下一位活着的人
      starterId = loser.alive ? loser.id : this.nextAliveId(room, loser.id);
    } else if (room.roundWinnerId && room.players[room.roundWinnerId]?.alive) {
      starterId = room.roundWinnerId;
    } else {
      starterId = this.alivePlayers(room)[0]?.id;
    }
    this.startRound(room, starterId);
    return true;
  }

  endGame(room, winnerId) {
    if (room.phase === 'ended') return;
    const winner = winnerId ? room.players[winnerId] : null;
    room.phase = 'ended';
    room.stage = 'end';
    room.winnerId = winner ? winner.id : null;
    room.reveal = null;
    room.revealUntil = 0;
    room.turnDeadline = 0;
    room.result = {
      winnerId: winner ? winner.id : null,
      winnerName: winner ? winner.name : '—',
      rounds: room.round,
      durationMs: Math.max(0, this.now() - room.startedAt),
      players: this.orderedPlayers(room).map((p) => ({
        id: p.id,
        name: p.name,
        seat: p.seat,
        alive: p.alive,
        shots: p.shots,
        bulletAt: p.bulletAt,
        remaining: sortHand(p.hand),
        eliminatedRound: p.eliminatedRound || 0,
      })),
    };
    for (const p of this.orderedPlayers(room)) p.hand = p.hand.slice();
    this.log(room, winner ? `🏆 ${winner.name} 是唯一还活着的人，赢下了这一局！` : '🏆 这局没有胜者。');
  }

  restart(room) {
    if (room.phase !== 'ended') throw new Error('这一局还没结束');
    for (const p of this.orderedPlayers(room)) {
      p.alive = true;
      p.hand = [];
      p.shots = 0;
      p.bulletAt = 0;
      p.eliminatedRound = 0;
    }
    room.phase = 'lobby';
    room.stage = 'turn';
    room.round = 0;
    room.tableCard = null;
    room.lastPlay = null;
    room.reveal = null;
    room.revealUntil = 0;
    room.turnId = null;
    room.turnDeadline = 0;
    room.finalPlayerId = null;
    room.roundLoserId = null;
    room.roundWinnerId = null;
    room.pendingWinnerId = null;
    room.winnerId = null;
    room.result = null;
    room.startedAt = 0;
    room.seed = `${this.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    room.rng = new Rng(room.seed);
    this.log(room, '回到准备阶段，可以再来一局。');
    return room;
  }

  // --------------------------------------------------------------- 时间 / 托管
  /** 给当前出牌人装一个截止时间：房主开了倒计时，或他掉线了（15 秒托管）。 */
  armTurn(room) {
    if (room.phase !== 'playing') { room.turnDeadline = 0; return; }
    const player = room.players[room.turnId];
    let deadline = 0;
    const now = this.now();
    if (room.config.turnSeconds > 0) deadline = now + room.config.turnSeconds * 1000;
    if (player && !player.connected) {
      const offlineAt = now + LIAR_OFFLINE_AUTO_MS;
      deadline = deadline ? Math.min(deadline, offlineAt) : offlineAt;
    }
    room.turnDeadline = deadline;
  }

  tick(room) {
    if (room.phase === 'reveal' && this.now() >= room.revealUntil) {
      this.advance(room);
      return true;
    }
    if (room.phase !== 'playing') return false;
    const current = room.players[room.turnId];
    if (!current) {
      this.repairTurn(room);
      return true;
    }
    if (room.turnDeadline && this.now() >= room.turnDeadline) {
      this.autoAct(room, current);
      return true;
    }
    return false;
  }

  repairTurn(room) {
    const next = this.alivePlayers(room)[0];
    if (!next) return;
    room.turnId = next.id;
    room.stage = 'turn';
    room.lastPlay = null;
    this.armTurn(room);
  }

  /** 超时 / 掉线托管：出 1 张最"该出"的牌；"放过"时机则直接放过。 */
  autoAct(room, player) {
    if (room.phase !== 'playing') return;
    if (room.stage === 'finalcall') {
      this.log(room, `${player.name} 超时没有决定，默认放过。`);
      this.passFinal(room, player);
      return;
    }
    if (!player.hand.length) { this.repairTurn(room); return; }
    const table = room.tableCard;
    const pick = player.hand.find((c) => rankOf(c) === table) || player.hand.find((c) => isWildCard(c)) || player.hand[0];
    this.log(room, `${player.name} ${player.connected ? '超时' : '掉线托管'}，自动出了 1 张（声称 ${table}）。`);
    this.play(room, player, [pick]);
  }

  // --------------------------------------------------------------- 退出 / 回收
  leave(room, playerId) {
    const p = room.players[playerId];
    if (!p) return;
    p.connected = false;
    p.lastSeen = this.now();
    this.log(room, `${p.name} 暂时离开了座位`);
    if (room.phase === 'playing' && room.turnId === playerId) this.armTurn(room);
    this.transferHost(room, playerId);
  }

  removePlayer(room, playerId) {
    const p = room.players[playerId];
    if (!p) return { removed: false };
    if (room.phase === 'lobby') {
      delete room.players[playerId];
      this.log(room, `${p.name} 离开了酒馆`);
    } else {
      p.connected = false;
      p.lastSeen = this.now();
      this.log(room, `${p.name} 退出了游戏（座位保留，可以重连）`);
      if (room.phase === 'playing' && room.turnId === playerId) this.armTurn(room);
    }
    this.transferHost(room, playerId);
    if (!Object.keys(room.players).length) {
      this.deleteRoom(room.code);
      return { removed: true, roomDeleted: true };
    }
    return { removed: true };
  }

  transferHost(room, goneId) {
    if (room.hostId !== goneId) return;
    const next = this.orderedPlayers(room).find((p) => p.id !== goneId && p.connected);
    room.hostId = next ? next.id : null;
    if (next) this.log(room, `房主转给了 ${next.name}`);
  }

  closeRoom(room, byPlayer) {
    for (const p of Object.values(room.players)) p.connected = false;
    this.log(room, `${byPlayer ? byPlayer.name : '房主'} 关闭了酒馆`);
    for (const [code, r] of this.rooms) if (r === room) this.rooms.delete(code);
  }

  deleteRoom(code) {
    const room = this.getRoom(code);
    if (room) this.log(room, '房间里没人了，自动关门');
    this.rooms.delete(String(code || '').toUpperCase());
  }

  sweep() {
    const now = this.now();
    for (const room of this.rooms.values()) {
      for (const p of Object.values(room.players)) {
        if (p.connected && now - p.lastSeen > 45000) {
          p.connected = false;
          this.log(room, `${p.name} 掉线了（心跳超时）`);
          if (room.phase === 'playing' && room.turnId === p.id) this.armTurn(room);
        }
      }
      const anyone = Object.values(room.players).some((p) => p.connected);
      if (!anyone) {
        const grace = room.phase === 'lobby' ? 30 * 1000 : 30 * 60 * 1000;
        if (now - (room.lastActivity || room.createdAt) > grace) this.rooms.delete(room.code);
      }
    }
  }

  // --------------------------------------------------------------- 聊天 / 日志
  chat(room, player, text) {
    const clean = String(text || '').slice(0, 400).trim();
    if (!clean) return null;
    const msg = {
      id: this.makeId(),
      from: player.id,
      name: player.name,
      seat: player.seat,
      text: clean,
      at: this.now(),
    };
    room.chat.push(msg);
    if (room.chat.length > 200) room.chat.splice(0, room.chat.length - 200);
    return msg;
  }

  log(room, text) {
    room.log.push({ at: this.now(), text });
    if (room.log.length > 400) room.log.splice(0, room.log.length - 400);
  }

  // --------------------------------------------------------------- 列表 / 视图
  listRooms() {
    const now = this.now();
    return [...this.rooms.values()]
      .filter((r) => r.phase !== 'ended')
      .filter((r) => Object.values(r.players).some((p) => p.connected))
      .map((r) => ({
        code: r.code,
        phase: r.phase,
        players: Object.values(r.players).filter((p) => p.connected).length,
        seated: Object.keys(r.players).length,
        maxPlayers: LIAR_MAX_PLAYERS,
        round: r.round,
        alive: this.alivePlayers(r).length,
        host: r.players[r.hostId] ? r.players[r.hostId].name : '',
        createdAt: r.createdAt,
        ageMs: now - r.createdAt,
      }))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 30);
  }

  /** 每个玩家拿到的视图：别人的手牌只有数量，实弹位置只有死后/终局才公开。 */
  view(room, player) {
    const now = this.now();
    const players = this.orderedPlayers(room);
    const turn = room.players[room.turnId];
    const state = {
      serverTime: now,
      you: {
        id: player.id,
        name: player.name,
        seat: player.seat,
        alive: !!player.alive,
        connected: !!player.connected,
        isHost: room.hostId === player.id,
        shots: player.shots,
        hand: sortHand(player.hand),
        bulletAt: (room.phase === 'ended' || !player.alive) ? player.bulletAt : null,
      },
      room: {
        code: room.code,
        phase: room.phase,
        stage: room.stage,
        hostId: room.hostId,
        round: room.round,
        tableCard: room.tableCard,
        turnId: room.turnId,
        turnName: turn ? turn.name : '',
        turnDeadline: room.turnDeadline || 0,
        revealUntil: room.revealUntil || 0,
        config: { ...room.config },
        startedAt: room.startedAt || 0,
        players: players.map((p) => ({
          id: p.id,
          name: p.name,
          seat: p.seat,
          connected: !!p.connected,
          alive: !!p.alive,
          shots: p.shots,
          cardCount: p.hand.length,
          isHost: p.id === room.hostId,
          isYou: p.id === player.id,
          isTurn: p.id === room.turnId && room.phase === 'playing',
          eliminatedRound: p.eliminatedRound || 0,
          // 出局的人弹巢位置公开（活着的人永远看不到）
          bulletAt: (!p.alive || room.phase === 'ended') ? (p.bulletAt || null) : null,
        })),
      },
      lastPlay: room.lastPlay ? {
        playerId: room.lastPlay.playerId,
        name: room.lastPlay.name,
        count: room.lastPlay.count,
        claimedRank: room.lastPlay.claimedRank,
        at: room.lastPlay.at,
        mine: room.lastPlay.playerId === player.id,
        cards: room.phase === 'ended' || (room.reveal && room.reveal.kind === 'challenge' && room.reveal.targetId === room.lastPlay.playerId)
          ? room.lastPlay.cards.slice()
          : null,
      } : null,
      log: room.log.slice(-80),
      chat: room.chat.slice(-120),
      result: room.phase === 'ended' ? room.result : null,
    };
    if (room.phase === 'playing') {
      state.canPlay = room.stage === 'turn' && room.turnId === player.id && player.alive;
      state.canChallenge = (room.stage === 'turn' || room.stage === 'finalcall')
        && room.turnId === player.id
        && !!room.lastPlay
        && room.lastPlay.playerId !== player.id;
      state.canPassFinal = room.stage === 'finalcall' && room.turnId === player.id;
      state.finalPlayerId = room.stage === 'finalcall' ? room.finalPlayerId : null;
      state.finalPlayerName = room.stage === 'finalcall' && room.players[room.finalPlayerId]
        ? room.players[room.finalPlayerId].name
        : '';
    }
    if (room.phase === 'reveal') {
      // 亮牌阶段只多一个 reveal；卡片信息本来就是公开的
      state.reveal = room.reveal;
    }
    return state;
  }

  // --------------------------------------------------------------- 测试辅助
  //
  // 这些方法只在 --test 启动时由 server.js 暴露成 liarDebug 动作；
  // 引擎本身不做权限判断。这样自动化测试可以摆出确定的牌局。
  debugState(room) {
    return {
      phase: room.phase,
      stage: room.stage,
      round: room.round,
      tableCard: room.tableCard,
      turnId: room.turnId,
      lastPlay: room.lastPlay,
      hands: Object.fromEntries(this.orderedPlayers(room).map((p) => [p.id, p.hand.slice()])),
      bullets: Object.fromEntries(this.orderedPlayers(room).map((p) => [p.id, p.bulletAt])),
      shots: Object.fromEntries(this.orderedPlayers(room).map((p) => [p.id, p.shots])),
    };
  }

  debug(op) {
    const room = this.getRoom(op.room);
    if (!room) throw new Error('房间不存在');
    const target = op.targetId ? room.players[op.targetId] : null;
    switch (op.op) {
      case 'state':
        return this.debugState(room);
      case 'setHand': {
        if (!target) throw new Error('玩家不存在');
        const cards = (op.cards || []).map(String);
        if (cards.some((c) => !isValidCard(c))) throw new Error('牌不存在');
        for (const c of cards) {
          // 一张牌不能在两个人手里
          for (const p of this.orderedPlayers(room)) if (p.id !== target.id) p.hand = p.hand.filter((x) => x !== c);
        }
        target.hand = cards;
        return this.debugState(room);
      }
      case 'setTable':
        if (!LIAR_TABLE_RANKS.includes(op.rank)) throw new Error('目标牌只能是 Q/K/A');
        room.tableCard = op.rank;
        return this.debugState(room);
      case 'setBullet':
        if (!target) throw new Error('玩家不存在');
        target.bulletAt = Math.max(1, Math.min(LIAR_CHAMBERS, Number(op.chamber) | 0 || 1));
        return this.debugState(room);
      case 'setShots':
        if (!target) throw new Error('玩家不存在');
        target.shots = Math.max(0, Math.min(LIAR_CHAMBERS, Number(op.shots) | 0 || 0));
        return this.debugState(room);
      case 'setTurn':
        if (!target) throw new Error('玩家不存在');
        room.turnId = target.id;
        room.stage = 'turn';
        this.armTurn(room);
        return this.debugState(room);
      case 'advance':
        // 测试用：跳过 4.6 秒亮牌动画，立刻结算这一轮
        if (room.phase !== 'reveal') throw new Error('现在不在亮牌阶段');
        this.advance(room);
        return this.debugState(room);
      default:
        throw new Error('未知调试操作');
    }
  }

  // --------------------------------------------------------------- 内部
  assertInTurn(room, player, { allowFinal = true } = {}) {
    if (room.phase !== 'playing') throw new Error('游戏不在进行中');
    if (!player.alive) throw new Error('你已经被抬出酒馆了，只能看别人玩');
    if ((room.stage !== 'turn' && !(allowFinal && room.stage === 'finalcall'))) throw new Error('现在不是出牌的时候');
    if (room.turnId !== player.id) throw new Error('还没轮到你');
  }

  nextAliveId(room, fromId) {
    const list = this.orderedPlayers(room);
    const alive = list.filter((p) => p.alive);
    if (!alive.length) return null;
    const idx = list.findIndex((p) => p.id === fromId);
    for (let step = 1; step <= list.length; step++) {
      const p = list[(idx + step + list.length) % list.length];
      if (p && p.alive && p.id !== fromId) return p.id;
    }
    return alive[0].id;
  }
}

function normalizeTurnSeconds(v) {
  const n = Number(v) | 0;
  return LIAR_TURN_SECONDS.includes(n) ? n : 0;
}
