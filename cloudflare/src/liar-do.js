// 骗子酒馆的 Cloudflare Durable Object 版本。
//
// 规则引擎仍然是 lib/liars.js（和本地版完全同一份），这里只把传输层
// 从 node:http + SSE 换成 Workers 的 fetch + ReadableStream。
//
// 一个房间 = 一个 DO 实例；房间列表在 Workers 版里是空的（房间分散在各个 DO 里），
// 想加入就靠房间号 / 邀请链接。
import { LiarGame } from '../../lib/liars.js';

export class LiarRoomDurableObject {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.game = new LiarGame({
      makeId: () => crypto.randomUUID(),
      makeCode: () => randomCode(),
    });
    this.subs = new Set(); // { playerId, pushData, pushEvent, close }
    this.ticker = null;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const route = url.pathname.replace(/^\/+/, '');
    try {
      if (route === 'create') return await this.onCreate(request, url);
      if (route === 'join') return await this.onJoin(request);
      if (route === 'state') return this.onState(url);
      if (route === 'action') return await this.onAction(request);
      if (route === 'events') return this.onEvents(url);
      return json({ error: '未知路由' }, 404);
    } catch (e) {
      return json({ error: e.message || String(e) }, e.statusCode || 500);
    }
  }

  roomByCode(code) {
    const room = this.game.getRoom(code);
    if (!room) {
      const err = new Error('没有这个房间');
      err.statusCode = 404;
      throw err;
    }
    return room;
  }

  async onCreate(request, url) {
    const body = await request.json().catch(() => ({}));
    const code = String(url.searchParams.get('code') || '').toUpperCase();
    if (!code) return json({ error: '缺少房间号' }, 400);
    if (this.game.getRoom(code)) return json({ error: '房间号已被占用' }, 409);
    const room = this.game.createRoom({ hostName: body.name || '房主', turnSeconds: body.turnSeconds });
    this.game.rooms.delete(room.code);
    room.code = code;
    this.game.rooms.set(code, room);
    const player = this.game.joinRoom(room, { name: body.name, playerId: body.playerId });
    this.broadcast(room);
    return json({ roomCode: code, playerId: player.id });
  }

  async onJoin(request) {
    const body = await request.json().catch(() => ({}));
    const room = this.roomByCode(body.room);
    const player = this.game.joinRoom(room, { name: body.name, playerId: body.playerId });
    this.broadcast(room);
    return json({ roomCode: room.code, playerId: player.id, name: player.name });
  }

  onState(url) {
    const room = this.roomByCode(url.searchParams.get('room'));
    const player = room.players[url.searchParams.get('player')];
    if (!player) return json({ error: '你不在这个房间里' }, 404);
    return json({ rev: room.rev || 0, state: this.game.view(room, player) });
  }

  async onAction(request) {
    const body = await request.json().catch(() => ({}));
    const room = this.roomByCode(body.room);
    const player = room.players[body.playerId];
    if (!player) return json({ error: '你不在这个房间里' }, 404);
    player.lastSeen = Date.now();
    player.connected = true;
    const isHost = room.hostId === player.id;
    const type = body.type;
    try {
      if (type === 'configure') {
        if (!isHost) throw new Error('只有房主可以修改设置');
        this.game.configure(room, { turnSeconds: body.turnSeconds });
      } else if (type === 'start') {
        if (!isHost) throw new Error('只有房主可以开始游戏');
        this.game.start(room);
      } else if (type === 'play') {
        this.game.play(room, player, body.cards);
      } else if (type === 'challenge') {
        this.game.challenge(room, player);
      } else if (type === 'passFinal') {
        this.game.passFinal(room, player);
      } else if (type === 'restart') {
        if (!isHost) throw new Error('只有房主可以开下一局');
        this.game.restart(room);
      } else if (type === 'chat') {
        this.game.chat(room, player, body.text);
      } else if (type === 'ping') {
        // presence only
      } else if (type === 'leave') {
        const info = this.game.removePlayer(room, player.id);
        if (info.roomDeleted) return json({ ok: true, left: true, roomDeleted: true });
        this.broadcast(room);
        this.notifyClosed(player.id, 'left');
        return json({ ok: true, left: true });
      } else if (type === 'closeRoom') {
        if (!isHost) throw new Error('只有房主可以关闭房间');
        for (const sub of [...this.subs]) this.notifyClosed(sub.playerId, 'closed');
        this.game.closeRoom(room, player);
        return json({ ok: true, closed: true });
      } else if (type === 'kick') {
        if (!isHost) throw new Error('只有房主可以请人出去');
        if (room.phase !== 'lobby') throw new Error('游戏进行中不能踢人');
        const target = room.players[body.targetId];
        if (!target) throw new Error('玩家不存在');
        if (target.id === player.id) throw new Error('不能踢自己');
        this.notifyClosed(target.id, 'kicked');
        this.game.removePlayer(room, target.id);
      } else {
        throw new Error('未知操作');
      }
    } catch (e) {
      return json({ error: e.message }, 400);
    }
    this.broadcast(room);
    return json({ ok: true });
  }

  onEvents(url) {
    const room = this.roomByCode(url.searchParams.get('room'));
    const playerId = url.searchParams.get('player');
    const player = room.players[playerId];
    if (!player) return json({ error: '你不在这个房间里' }, 404);
    player.connected = true;
    player.lastSeen = Date.now();

    const encoder = new TextEncoder();
    const self = this;
    let closed = false;
    let sub = null;
    const stream = new ReadableStream({
      start(controller) {
        const write = (text) => {
          if (closed) return;
          try { controller.enqueue(encoder.encode(text)); } catch { closed = true; }
        };
        sub = {
          playerId,
          pushData: (obj) => write(`data: ${JSON.stringify(obj)}\n\n`),
          pushEvent: (name, obj) => write(`event: ${name}\ndata: ${JSON.stringify(obj)}\n\n`),
          close: () => { closed = true; try { controller.close(); } catch { /* already closed */ } },
        };
        self.subs.add(sub);
        self.ensureTicker();
        // 客户端用 es.onmessage 收状态，所以必须是无名事件（只有 data:）
        sub.pushData({ rev: room.rev || 0, state: self.game.view(room, player) });
      },
      cancel() {
        closed = true;
        if (sub) self.subs.delete(sub);
        self.stopTickerIfIdle();
      },
    });

    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        'x-accel-buffering': 'no',
      },
    });
  }

  ensureTicker() {
    if (this.ticker) return;
    const self = this;
    this.ticker = setInterval(() => {
      const room = self.currentRoom();
      if (!room || !self.subs.size) { self.stopTickerIfIdle(); return; }
      try { self.game.tick(room); } catch { /* 房间可能已关闭 */ }
      self.broadcast(room);
    }, 500);
  }

  stopTickerIfIdle() {
    if (this.subs.size === 0 && this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  }

  currentRoom() {
    for (const room of this.game.rooms.values()) return room;
    return null;
  }

  notifyClosed(playerId, reason) {
    for (const sub of [...this.subs]) {
      if (sub.playerId !== playerId) continue;
      try { sub.pushEvent && sub.pushEvent('closed', { reason }); } catch { /* ignore */ }
      this.subs.delete(sub);
      sub.close && sub.close();
    }
  }

  broadcast(room) {
    if (!room) return;
    room.rev = (room.rev || 0) + 1;
    room.lastActivity = Date.now();
    for (const sub of [...this.subs]) {
      const player = room.players[sub.playerId];
      if (!player) {
        this.notifyClosed(sub.playerId, 'left');
        continue;
      }
      try {
        sub.pushData({ rev: room.rev, state: this.game.view(room, player) });
      } catch {
        this.subs.delete(sub);
      }
    }
    this.stopTickerIfIdle();
  }
}

function randomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 4; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
