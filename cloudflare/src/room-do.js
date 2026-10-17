import { Game } from '../../server/room.js';
import { playerState } from '../../lib/view.js';

/**
 * 一个房间 = 一个 Durable Object 实例。
 *
 * 这里**没有**改任何游戏逻辑：直接 `new Game()`（就是本地版 server/room.js 里那个类），
 * 然后把 HTTP 传输层从 `node:http` 换成 Workers 的 `fetch` + ReadableStream(SSE)。
 * 房间状态全在 DO 内存里，DO 是单实例、强一致的，正好对应本地版的"服务端权威"。
 */
export class RoomDurableObject {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.game = new Game();
    this.subs = new Set(); // { playerId, push(state) }
    this.ticker = null;
    this.now = () => Date.now();
  }

  // ---------------------------------------------------------------- 路由
  async fetch(request) {
    const url = new URL(request.url);
    const route = url.pathname.replace(/^\/+/, '');
    try {
      if (route === 'create') return await this.onCreate(request, url);
      if (route === 'join') return await this.onJoin(request);
      if (route === 'state') return await this.onState(url);
      if (route === 'action') return await this.onAction(request);
      if (route === 'events') return await this.onEvents(url);
      return json({ error: '未知路由' }, 404);
    } catch (e) {
      return json({ error: e.message || String(e) }, e.statusCode || 500);
    }
  }

  roomByCode(code) {
    const room = this.game.getRoom(code);
    if (!room) {
      const err = new Error('房间不存在');
      err.statusCode = 404;
      throw err;
    }
    return room;
  }

  // ---------------------------------------------------------------- 建房 / 加入
  async onCreate(request, url) {
    const body = await request.json().catch(() => ({}));
    const code = String(url.searchParams.get('code') || '').toUpperCase();
    if (!code) return json({ error: '缺少房间号' }, 400);
    if (this.game.getRoom(code)) return json({ error: '房间号已被占用' }, 409);

    const room = this.game.createRoom({
      difficulty: body.difficulty || 'normal',
      hostName: body.name || '房主',
      seed: body.seed,
    });
    // Game.createRoom 自己生成房间号，这里换成 Worker 分配好的（并保持索引一致）
    this.game.rooms.delete(room.code);
    room.code = code;
    this.game.rooms.set(code, room);

    const player = this.game.joinRoom(room, { name: body.name, role: null, playerId: body.playerId });
    if (!player.role) player.role = 'expert';
    this.game.recomputeSeats(room);
    this.broadcast(room);
    return json({ roomCode: room.code, playerId: player.id });
  }

  async onJoin(request) {
    const body = await request.json().catch(() => ({}));
    const room = this.roomByCode(body.room);
    const player = this.game.joinRoom(room, {
      name: body.name,
      role: body.role || null,
      playerId: body.playerId,
    });
    this.game.recomputeSeats(room);
    this.broadcast(room);
    return json({ roomCode: room.code, playerId: player.id, role: player.role });
  }

  onState(url) {
    const room = this.roomByCode(url.searchParams.get('room'));
    const player = room.players[url.searchParams.get('player')];
    if (!player) return json({ error: '玩家不在这个房间里' }, 404);
    return json(playerState(room, player));
  }

  // ---------------------------------------------------------------- 动作
  async onAction(request) {
    const body = await request.json().catch(() => ({}));
    const room = this.roomByCode(body.room);
    const player = room.players[body.playerId];
    if (!player) return json({ error: '玩家不在这个房间里' }, 404);
    player.lastSeen = Date.now();
    player.connected = true;

    const type = body.type;
    let result = {};
    if (type === 'role') {
      this.game.setRole(room, player.id, body.role);
    } else if (type === 'autoAssign') {
      this.game.autoAssign(room);
    } else if (type === 'preset') {
      if (room.hostId !== player.id) throw new Error('只有房主可以套用角色预设');
      if (room.phase !== 'lobby') throw new Error('只能在准备阶段改角色');
      result = { preset: this.game.applyPreset(room, body.preset) };
    } else if (type === 'signal') {
      const kind = String(body.signal || '').slice(0, 24);
      if (!kind) throw new Error('信号不能为空');
      this.game.signal(room, player, kind);
    } else if (type === 'cursor') {
      this.game.cursor(room, player, { uid: body.uid, x: body.x, y: body.y });
    } else if (type === 'note') {
      this.game.signal(room, player, 'note', String(body.text || '').slice(0, 60));
    } else if (type === 'configure') {
      if (room.phase !== 'lobby') throw new Error('只能在准备阶段修改设置');
      this.game.configure(room, body);
    } else if (type === 'start') {
      this.game.start(room);
    } else if (type === 'restart') {
      this.game.restart(room, { seed: body.seed });
    } else if (type === 'module') {
      result = this.game.act(room, player, { uid: body.uid, action: body.action });
    } else if (type === 'chat') {
      this.game.chat(room, player, body.text);
    } else if (type === 'ping') {
      // presence only
    } else if (type === 'leave') {
      const info = this.game.removePlayer(room, player.id);
      if (!info.roomDeleted) this.broadcast(room);
      return json({ ok: true, left: true, roomDeleted: !!info.roomDeleted });
    } else if (type === 'closeRoom') {
      if (room.hostId !== player.id) throw new Error('只有房主可以关闭房间');
      for (const sub of this.subs) sub.push && this.push(sub, 'closed', { reason: 'closed' });
      this.game.closeRoom(room, player);
      this.stopTickerIfIdle();
      return json({ ok: true, closed: true });
    } else if (type === 'kick') {
      if (room.hostId !== player.id) throw new Error('只有房主可以踢人');
      const gone = room.players[body.target];
      if (!gone) throw new Error('玩家不存在');
      this.game.removePlayer(room, body.target);
      if (!this.game.getRoom(room.code)) return json({ ok: true, kicked: true, roomDeleted: true });
    } else {
      throw new Error('未知操作');
    }

    this.broadcast(room);
    return json(result || { ok: true });
  }

  // ---------------------------------------------------------------- SSE
  onEvents(url) {
    const room = this.roomByCode(url.searchParams.get('room'));
    const playerId = url.searchParams.get('player');
    const player = room.players[playerId];
    if (!player) return json({ error: '玩家不在这个房间里' }, 404);
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
          try {
            controller.enqueue(encoder.encode(text));
          } catch {
            closed = true;
          }
        };
        // 注意：客户端用 es.onmessage 收状态，所以状态必须是**无名事件**（只有 data:）。
        // 发成 `event: state` 客户端会一条都收不到（这是踩过的坑）。
        // 只有 closed 这种"专门的事件"才用 event: 且客户端用 addEventListener('closed')。
        sub = {
          playerId,
          pushData: (obj) => write(`data: ${JSON.stringify(obj)}\n\n`),
          pushEvent: (name, obj) => write(`event: ${name}\ndata: ${JSON.stringify(obj)}\n\n`),
          close: () => {
            closed = true;
            try {
              controller.close();
            } catch {
              /* 已经关了 */
            }
          },
        };
        self.subs.add(sub);
        self.ensureTicker();
        // 先推一次当前状态，客户端不用等下一个 tick
        sub.pushData(playerState(room, player));
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

  // 每秒 tick + 广播：相当于本地版 server.js 里那个 setInterval
  ensureTicker() {
    if (this.ticker) return;
    const self = this;
    this.ticker = setInterval(() => {
      const room = self.currentRoom();
      if (!room || !self.subs.size) {
        self.stopTickerIfIdle();
        return;
      }
      try {
        self.game.tick(room);
      } catch { /* 房间可能已结束 */ }
      self.broadcast(room);
    }, 1000);
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

  push(sub, event, data) {
    if (event === 'closed') sub.pushEvent && sub.pushEvent('closed', data);
    else sub.pushData && sub.pushData(data);
  }

  broadcast(room) {
    if (!room) return;
    for (const sub of [...this.subs]) {
      const player = room.players[sub.playerId];
      if (!player) {
        // 玩家被踢/离开了
        this.push(sub, 'closed', { reason: 'left' });
        this.subs.delete(sub);
        sub.close && sub.close();
        continue;
      }
      try {
        this.push(sub, 'state', playerState(room, player));
      } catch {
        this.subs.delete(sub);
      }
    }
    this.stopTickerIfIdle();
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
