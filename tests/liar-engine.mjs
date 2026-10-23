// 骗子酒馆规则引擎单测（不需要起服务器）：
//
//   node tests/liar-engine.mjs
//
// 覆盖：发牌 / 越权 / 诚实与撒谎的质疑 / 左轮出局 / 出完手牌与放过 /
// 超时托管 / 隐藏信息 / 重连 / 再来一局。

import {
  LiarGame, LIAR_HAND_SIZE, LIAR_REVEAL_MS, LIAR_PASS_REVEAL_MS, rankOf,
} from '../lib/liars.js';

let failures = 0;
let checks = 0;
const ok = (m) => { checks++; console.log('  ✓ ' + m); };
const fail = (m) => { failures++; console.error('  ✗ ' + m); };
const assert = (cond, m) => (cond ? ok(m) : fail(m));
const throws = (fn, re, m) => {
  try { fn(); fail(`${m}（没有报错）`); } catch (e) { assert(re.test(e.message), `${m}：${e.message}`); }
};

function setup({ players = ['a', 'b', 'c'], turnSeconds = 0, seed = 'liar-test' } = {}) {
  let t = 1_700_000_000_000;
  let seq = 0;
  const game = new LiarGame({
    now: () => t,
    makeId: () => `x${++seq}`,
    makeCode: () => 'T' + String((seq % 9) + 1),
  });
  const room = game.createRoom({ hostName: '甲', seed, turnSeconds });
  for (const id of players) game.joinRoom(room, { name: id.toUpperCase(), playerId: id });
  return { game, room, players, setNow: (v) => { t = v; }, now: () => t, advance: (ms) => { t += ms; } };
}

function startWith(game, room) {
  game.start(room);
  return room;
}

console.log('骗子酒馆 · 规则引擎单测\n');

// ---------------------------------------------------------------- 发牌
console.log('— 开局 / 发牌 —');
{
  const { game, room, players } = setup();
  startWith(game, room);
  assert(room.phase === 'playing', '开局后进入 playing');
  assert(['Q', 'K', 'A'].includes(room.tableCard), `目标牌是 Q/K/A（${room.tableCard}）`);
  for (const id of players) {
    const p = room.players[id];
    assert(p.hand.length === LIAR_HAND_SIZE, `${p.name} 拿到 ${LIAR_HAND_SIZE} 张牌`);
    assert(p.hand.every((c) => ['Q', 'K', 'A', 'J'].includes(rankOf(c))), `${p.name} 的牌都在合法牌堆里`);
    assert(p.shots === 0 && p.alive, `${p.name} 满血、0 枪`);
    assert(p.bulletAt >= 1 && p.bulletAt <= 6, `${p.name} 的实弹在 1~6 号弹巢`);
  }
  const handIds = players.flatMap((id) => room.players[id].hand);
  assert(new Set(handIds).size === handIds.length, '没有人拿到同一张牌（无重复发牌）');
  assert(room.turnId && room.players[room.turnId], '有明确的先手玩家');

  const view = game.view(room, room.players.a);
  const others = view.room.players.filter((p) => !p.isYou);
  assert(others.every((p) => p.cardCount === LIAR_HAND_SIZE), '别人的视图里只有手牌数量');
  assert(others.every((p) => p.hand === undefined), '别人的手牌内容没有泄漏');
  assert(view.you.bulletAt === null, '自己的实弹位置在活着时也不下发');
  assert(!JSON.stringify(view).includes('"bulletAt":' ) || others.every((p) => p.bulletAt === undefined), '视图里没有别人的实弹位置');
}

// ---------------------------------------------------------------- 越权
console.log('\n— 出牌顺序 / 越权 —');
{
  const { game, room } = setup();
  startWith(game, room);
  const notTurn = Object.values(room.players).find((p) => p.id !== room.turnId);
  throws(() => game.play(room, notTurn, [notTurn.hand[0]]), /还没轮到你/, '不是自己回合不能出牌');
  const cur = room.players[room.turnId];
  throws(() => game.play(room, cur, []), /1~3 张/, '不能出 0 张');
  throws(() => game.play(room, cur, [cur.hand[0], cur.hand[1], cur.hand[2], cur.hand[3]].filter(Boolean)), /1~3 张/, '不能出 4 张');
  throws(() => game.play(room, cur, ['A6'].filter((c) => !cur.hand.includes(c))), /没有这张牌/, '不能出不在手里的牌');
  throws(() => game.challenge(room, cur), /还没出牌/, '还没人出牌时不能质疑');

  const target = room.players[room.turnId];
  game.play(room, target, [target.hand[0]]);
  throws(() => game.challenge(room, target), /自己的出牌/, '不能质疑自己');
  const next = room.players[room.turnId];
  game.challenge(room, next);
  assert(room.phase === 'reveal', '质疑后进入亮牌阶段');
}

// ---------------------------------------------------------------- 诚实质疑
console.log('\n— 质疑：对方没撒谎 —');
{
  const { game, room, advance } = setup();
  startWith(game, room);
  game.debug({ room: room.code, op: 'setTable', rank: 'Q' });
  game.debug({ room: room.code, op: 'setHand', targetId: 'a', cards: ['Q1', 'J1'] });
  game.debug({ room: room.code, op: 'setTurn', targetId: 'a' });
  game.debug({ room: room.code, op: 'setBullet', targetId: 'b', chamber: 1 });
  game.play(room, room.players.a, ['Q1', 'J1']);
  assert(room.turnId === 'b', '出牌后轮到下家');
  game.challenge(room, room.players.b);
  const rv = room.reveal;
  assert(rv.kind === 'challenge', '亮牌类型是 challenge');
  assert(rv.honest === true, 'Q + 赖子 J 判定为诚实（J 是赖子）');
  assert(rv.cards.every((c) => c.match), '每一张都标了 match');
  assert(rv.shooterId === 'b' && rv.targetId === 'a', '质疑者挨枪（质疑错了）');
  assert(rv.shot.chamber === 1 && rv.shot.died === true, '第 1 枪命中实弹，质疑者出局');
  assert(room.players.b.alive === false, '质疑者被标记为出局');
  assert(room.pendingWinnerId === null, '还有两人存活，游戏继续');
  advance(LIAR_REVEAL_MS + 1);
  assert(game.tick(room) === true, '亮牌时间到，自动进入下一轮');
  assert(room.phase === 'playing' && room.round === 2, '进入第 2 轮');
  assert(room.turnId === 'c', '上一轮输家（已出局）的下一位先出牌');
}

// ---------------------------------------------------------------- 撒谎质疑
console.log('\n— 质疑：抓到骗子 —');
{
  const { game, room } = setup();
  startWith(game, room);
  game.debug({ room: room.code, op: 'setTable', rank: 'K' });
  game.debug({ room: room.code, op: 'setHand', targetId: 'b', cards: ['A1', 'J2'] });
  game.debug({ room: room.code, op: 'setTurn', targetId: 'b' });
  game.debug({ room: room.code, op: 'setBullet', targetId: 'b', chamber: 2 });
  game.play(room, room.players.b, ['A1', 'J2']);
  game.challenge(room, room.players.c);
  const rv = room.reveal;
  assert(rv.honest === false, 'A + 赖子 在目标 K 下判定为撒谎');
  assert(rv.cards.find((c) => c.id === 'A1').match === false, 'A 被标记为不匹配');
  assert(rv.cards.find((c) => c.id === 'J2').match === true, '赖子被标记为匹配');
  assert(rv.shooterId === 'b', '出牌的人挨枪');
  assert(rv.shot.chamber === 1 && rv.shot.died === false, '第 1 枪空响');
  assert(room.players.b.alive === true, '空响后还活着');
  assert(room.players.b.shots === 1, '已打出 1 枪');
}

// ---------------------------------------------------------------- 出局 / 终局
console.log('\n— 出局与终局 —');
{
  const { game, room, advance } = setup({ players: ['a', 'b'] });
  startWith(game, room);
  game.debug({ room: room.code, op: 'setTable', rank: 'A' });
  game.debug({ room: room.code, op: 'setHand', targetId: 'a', cards: ['K1'] });
  game.debug({ room: room.code, op: 'setTurn', targetId: 'a' });
  game.debug({ room: room.code, op: 'setBullet', targetId: 'a', chamber: 1 });
  game.play(room, room.players.a, ['K1']);
  game.challenge(room, room.players.b);
  assert(room.players.a.alive === false, '撒谎的人在实弹上出局');
  assert(room.pendingWinnerId === 'b', '只剩 b，记录待定的胜者');
  advance(LIAR_REVEAL_MS + 1);
  game.tick(room);
  assert(room.phase === 'ended', '亮牌结束后整局结束');
  assert(room.winnerId === 'b', 'b 是唯一活下来的人');
  assert(room.result.players.find((p) => p.id === 'a').bulletAt === 1, '终局公开所有实弹位置');
  const deadView = game.view(room, room.players.a);
  assert(deadView.result && deadView.result.winnerId === 'b', '死人也能看到终局结果');
  game.restart(room);
  assert(room.phase === 'lobby' && room.round === 0, '再来一局回到准备阶段');
  assert(Object.values(room.players).every((p) => p.alive && p.shots === 0), '重开后所有人满血');
}

// ---------------------------------------------------------------- 出完手牌
console.log('\n— 出完手牌：下家质疑 / 放过 —');
{
  const { game, room } = setup({ players: ['a', 'b'] });
  startWith(game, room);
  game.debug({ room: room.code, op: 'setTable', rank: 'Q' });
  game.debug({ room: room.code, op: 'setHand', targetId: 'a', cards: ['Q2'] });
  game.debug({ room: room.code, op: 'setTurn', targetId: 'a' });
  game.play(room, room.players.a, ['Q2']);
  assert(room.stage === 'finalcall', '出完手牌后进入"质疑/放过"阶段');
  assert(room.turnId === 'b', '由下家决定');
  throws(() => game.play(room, room.players.b, [room.players.b.hand[0]]), /不是出牌/, '下家此时不能直接出牌');
  game.passFinal(room, room.players.b);
  assert(room.reveal.kind === 'passed' && room.reveal.winnerId === 'a', '放过 = 出完牌的人赢下本轮');
  assert(room.players.a.alive && room.players.a.shots === 0, '放过时没有人挨枪');
  // 手动推进时间
  room.revealUntil = 1;
  game.tick(room);
  assert(room.phase === 'playing' && room.round === 2, '放过后进入下一轮');
  assert(room.turnId === 'a', '本轮赢家先出牌');
}

// ---------------------------------------------------------------- 超时托管
console.log('\n— 超时 / 掉线托管 —');
{
  const { game, room, advance } = setup({ players: ['a', 'b'], turnSeconds: 30 });
  startWith(game, room);
  const cur = room.players[room.turnId];
  const before = cur.hand.length;
  game.tick(room);
  assert(cur.hand.length === before, '没到时间不会自动出牌');
  advance(30_000 + 1);
  game.tick(room);
  assert(cur.hand.length === before - 1, '超时自动出 1 张牌');
  assert(room.lastPlay && room.lastPlay.playerId === cur.id, '自动出牌也会记录 lastPlay');

  const { game: g2, room: r2, advance: adv2 } = setup({ players: ['a', 'b'] });
  startWith(g2, r2);
  const p = r2.players[r2.turnId];
  g2.leave(r2, p.id);
  assert(r2.turnDeadline > 0, '掉线玩家会被装上托管倒计时');
  adv2(15_000 + 1);
  g2.tick(r2);
  assert(r2.lastPlay && r2.lastPlay.playerId === p.id, '掉线超时后自动替他出牌');
}

// ---------------------------------------------------------------- 重连 / 聊天
console.log('\n— 重连 / 聊天 —');
{
  const { game, room } = setup();
  startWith(game, room);
  const before = room.players.a.hand.slice();
  game.leave(room, 'a');
  assert(room.players.a.connected === false, '掉线只标记离线，座位保留');
  game.joinRoom(room, { name: 'A', playerId: 'a' });
  assert(room.players.a.connected === true, '同一个 playerId 可以重连');
  assert(room.players.a.hand.join() === before.join(), '重连后手牌不变');
  game.chat(room, room.players.a, '  有人质疑我吗？  ');
  assert(room.chat.at(-1).text === '有人质疑我吗？', '聊天会去掉首尾空白');
  assert(room.players.a.connected === true, '聊天不影响座位');
  assert(!game.chat(room, room.players.a, ''), '空消息不广播');
}

// ---------------------------------------------------------------- 房间列表
console.log('\n— 房间列表 —');
{
  const { game, room } = setup();
  assert(game.listRooms().some((r) => r.code === room.code), '准备中的房间会出现在列表里');
  game.start(room);
  const item = game.listRooms().find((r) => r.code === room.code);
  assert(item && item.phase === 'playing' && item.players === 3, '列表显示进行中与人数');
}

console.log(`\n${checks} 项检查，失败 ${failures} 项`);
process.exit(failures ? 1 : 0);
