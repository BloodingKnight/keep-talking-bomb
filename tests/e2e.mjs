// Multi-client end-to-end test.
//
// Spins up several "dummy clients" that behave like real browser tabs:
//   * they join over HTTP and subscribe to the SSE stream,
//   * they only ever look at the role-filtered view the server pushes them,
//   * the defuser-ish client drives module actions through POST /api/action,
//   * the expert-ish clients assert they can see the manual and never the bomb.
//
// Requires the server running in test mode (the test-only "oracle" action is
// used to learn the correct answers, exactly like a player reading the manual):
//
//   node server/server.js 3388 --test
//   node tests/e2e.mjs http://127.0.0.1:3388

const BASE = process.argv[2] || 'http://127.0.0.1:3388';

// Node <22 has no global EventSource; fall back to a tiny SSE reader over fetch.
const EventSourceImpl = globalThis.EventSource || (await (async () => {
  const { default: http } = await import('node:http');
  return class MiniEventSource {
    constructor(url) {
      this.url = url;
      this.onmessage = null;
      this.onerror = null;
      this.readyState = 0;
      this._start();
    }
    _start() {
      const req = http.get(this.url, (res) => {
        this.readyState = 1;
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          buf += chunk;
          let idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const raw = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const line = raw.split('\n').find((l) => l.startsWith('data:'));
            if (line && this.onmessage) {
              try { this.onmessage({ data: line.slice(5).trim() }); } catch { /* ignore */ }
            }
          }
        });
        res.on('end', () => { this.readyState = 2; this.onerror && this.onerror(); });
      });
      req.on('error', () => { this.readyState = 2; this.onerror && this.onerror(); });
      this._req = req;
    }
    close() { try { this._req?.destroy(); } catch { /* ignore */ } this.readyState = 2; }
  };
})());

let failures = 0;
const fail = (m) => { failures++; console.error('  ✗ ' + m); };
const ok = (m) => console.log('  ✓ ' + m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${path} -> ${res.status}`);
  return data;
}

async function state(room, playerId) {
  const res = await fetch(`${BASE}/api/state?room=${room}&player=${playerId}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'state failed');
  return data.state;
}

// --------------------------------------------------------------------- client
class Client {
  constructor(label) { this.label = label; this.id = null; this.room = null; this.view = null; }

  async create(name, difficulty = 'normal') {
    const r = await api('/api/create', { name, difficulty });
    this.room = r.roomCode; this.id = r.playerId;
    return this;
  }

  async join(room, name, role) {
    const r = await api('/api/join', { room, name, role });
    this.room = r.roomCode; this.id = r.playerId;
    return this;
  }

  async send(payload) {
    return api('/api/action', { ...payload, room: this.room, playerId: this.id });
  }

  async refresh() {
    const res = await fetch(`${BASE}/api/state?room=${this.room}&player=${this.id}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'state failed');
    this.view = data.state;
    return this.view;
  }

  /** Subscribe to SSE and remember both the latest push and event count. */
  listen() {
    this.events = 0;
    this.pushed = null;
    this.es = new EventSourceImpl(`${BASE}/api/events?room=${this.room}&player=${this.id}`);
    this.es.onmessage = (ev) => {
      this.events++;
      try { this.pushed = JSON.parse(ev.data).state; } catch { /* ignore */ }
    };
    this.es.onerror = () => { /* reconnects are fine */ };
    return this;
  }

  close() { try { this.es?.close(); } catch { /* ignore */ } }
}

const rowsOf = (manual) => (manual ? manual.sections.flatMap((s) =>
  s.groups.flatMap((g) => (g.rows || []).map((r) => `${s.uid}|${r.label}`))) : []);

async function main() {
  console.log(`E2E @ ${BASE}\n`);

  // ============================================== 场景 1：标准 4 人局 + 全程拆弹
  console.log('— 场景 1：拆弹者 + 专家 + 盲眼观察员 + 专家 II，走完一整局 —');
  // 时间给足，让自动化客户端有充裕的时间一个模块一个模块地拆（真人局用默认时长）
  const host = new Client('房主');
  await host.create('房主', 'normal');
  const room = host.room;
  await host.send({ type: 'configure', timeSec: 900 });
  ok(`建房成功 ${room}`);

  const defuser = new Client('拆弹者');
  const expert = new Client('专家');
  const blind = new Client('盲眼');
  const extra = new Client('专家II');
  await defuser.join(room, '拆弹者', 'defuser');
  await expert.join(room, '专家', 'expert');
  await blind.join(room, '盲眼', 'blind');
  await extra.join(room, '专家II', 'expert2');
  [defuser, expert, blind, extra].forEach((c) => c.listen());

  // 加入时指定的角色应当直接生效
  await defuser.refresh(); await expert.refresh(); await blind.refresh(); await extra.refresh();
  const roles = [defuser, expert, blind, extra].map((c) => c.view.you.role);
  if (roles.join(',') === 'defuser,expert,blind,expert2') ok(`4 个座位按指定角色就位：${roles.join(' / ')}`);
  else fail(`角色没有按指定席位分配：${roles.join(' / ')}`);

  // 显式抢座必须被拒绝
  const dup = await extra.send({ type: 'role', role: 'defuser' }).then(() => null).catch((e) => e.message);
  if (dup) ok(`抢占拆弹者座位被拒绝：${dup}`);
  else fail('拆弹者座位被重复占用');

  // 准备阶段：谁都没有手册
  if (defuser.view.manual) fail('准备阶段的拆弹者不应该有手册');
  else ok('准备阶段视图正常');

  await host.send({ type: 'start' });
  await Promise.all([defuser.refresh(), expert.refresh(), blind.refresh(), extra.refresh()]);

  // --- 角色可见性
  const dv = defuser.view, ev = expert.view, bv = blind.view, xv = extra.view;
  if (dv.manual) fail('拆弹者不应该拿到手册');
  if (!dv.bomb.moduleStates?.[0]?.state) fail('拆弹者应该拿到模块状态');
  if (dv.remainingMsExact === undefined) fail('拆弹者应该看到精确倒计时');
  if (dv.canInteract !== true) fail('拆弹者应该能操作');
  ok('拆弹者：炸弹模块 + 精确倒计时 + 可操作，没有手册');

  if (!ev.manual) fail('专家应该拿到手册');
  if (ev.canInteract) fail('专家不应该能操作炸弹');
  if (ev.bomb.moduleStates.some((m) => m.state !== undefined)) fail('专家视图泄露了模块内部状态');
  if (!ev.manual.casing.serial) fail('专家手册缺少炸弹外壳信息');
  if (JSON.stringify(ev).includes('"solution"')) fail('专家视图里出现了 solution 字段');
  ok(`专家：手册（${ev.manual.sections.length} 章）+ 外壳信息（序列号 ${ev.manual.casing.serial}），看不到模块状态`);

  if (bv.manual?.mode !== 'partial') fail(`盲眼观察员应该拿到拆分手册，实际 ${bv.manual?.mode}`);
  if (xv.manual?.mode !== 'partial') fail(`专家 II 应该拿到拆分手册，实际 ${xv.manual?.mode}`);
  const bRows = rowsOf(bv.manual).filter((r) => !r.startsWith('__'));
  ok(`拆分手册：盲眼 ${bRows.length} 条 / 专家 II ${rowsOf(xv.manual).length} 条`);

  // 权限：专家不能操作
  const denied = await expert.send({ type: 'module', uid: dv.bomb.moduleStates[0].uid, action: { type: 'cut', index: 0 } })
    .then(() => null).catch((e) => e.message);
  if (denied) ok(`专家操作模块被拒绝：${denied}`);
  else fail('专家居然成功操作了模块');

  // --- SSE 推送与轮询一致
  await sleep(300);
  if (defuser.events > 0 && defuser.pushed) {
    await defuser.refresh();
    if (defuser.pushed.you.role === defuser.view.you.role) ok(`SSE 实时推送正常（已收到 ${defuser.events} 次更新）`);
    else fail('SSE 推送的角色与轮询结果不一致');
  } else fail('SSE 没有推送任何事件');

  // --- 文字频道
  await blind.send({ type: 'chat', text: '我这边手册里有线缆那一页' });
  await expert.refresh();
  if (expert.view.chat.some((m) => m.text.includes('线缆那一页'))) ok('文字频道把情报广播给了其他玩家');
  else fail('聊天消息没有广播');

  // --- 完整拆弹（模块万一被计时类判定打回，就像真人一样再拆一次）
  const gameDeadline = Date.now() + dv.remainingMsExact;
  const total = dv.bomb.moduleStates.length;
  for (const m of dv.bomb.moduleStates) {
    if (m.status === 'solved') continue;
    let res = await solveModule(defuser, m.uid, { gameDeadline, maxSteps: 200 });
    if (!res.solved) {
      await defuser.refresh();
      if (defuser.view.room.phase === 'playing' && defuser.view.status === 'running') {
        res = await solveModule(defuser, m.uid, { gameDeadline, maxSteps: 200 });
      }
    }
    if (res.solved) ok(`模块「${m.title}」按手册拆除成功`);
    else fail(`模块「${m.title}」没能拆掉：${res.reason}`);
    await defuser.refresh();
    if (defuser.view.room.phase === 'ended') break;
  }
  await defuser.refresh();
  if (defuser.view.status === 'defused') {
    ok(`整颗炸弹拆除成功：得分 ${defuser.view.result.score.score}，模块 ${defuser.view.result.score.solved}/${total}`);
  } else {
    fail(`应该拆弹成功，实际 ${defuser.view.status}（模块 ${defuser.view.result?.score?.solved}/${total}）`);
  }
  await expert.refresh();
  if (expert.view.result?.moduleReveal?.length) ok('结算页对所有角色给出模块复盘');
  else fail('结算页没有模块复盘');

  [defuser, expert, blind, extra].forEach((c) => c.close());

  // ==================================================== 场景 2：静默操作员
  console.log('\n— 场景 2：静默操作员（能操作、不能说话）+ 专家 —');
  const h2 = new Client('房主2');
  await h2.create('房主2', 'easy');
  const room2 = h2.room;
  const mute = new Client('静默');
  const e2 = new Client('专家2');
  await mute.join(room2, '静默', 'mute');
  await e2.join(room2, '专家', 'expert');
  const probe = await state(room2, mute.id);
  ok(`静默操作员已进入房间（房间内：${probe.room.players.map((p) => `${p.name}=${p.role}`).join('、')}）`);
  mute.listen(); e2.listen();
  await h2.send({ type: 'start' });
  await mute.refresh(); await e2.refresh();

  if (mute.view.canInteract !== true) fail('静默操作员应该能操作炸弹');
  else ok('静默操作员可以操作炸弹');
  if (mute.view.manual) fail('静默操作员不应该有手册');
  if (mute.view.you.roleInfo.canSpeak !== false) fail('静默操作员不应被标记为可发言');
  ok(`静默操作员设定：${mute.view.you.roleInfo.tagline}`);

  await mute.send({ type: 'chat', text: '我看到了三根线：红、蓝、黄' });
  await e2.refresh();
  if (e2.view.chat.some((m) => m.text.includes('三根线'))) ok('静默操作员通过文字频道传出了情报');
  else fail('静默操作员的文字情报没有送达');

  if (e2.view.manual) ok('同房间的专家正常拿到手册');
  else fail('专家没有拿到手册');

  // ================================================ 场景 3：失误到上限 → 爆炸
  console.log('\n— 场景 3：连续失误直到爆炸 —');
  let s3;
  try {
    s3 = await state(room2, mute.id);
  } catch (e) {
    // 给出足够定位问题的上下文
    const rooms = await fetch(`${BASE}/api/rooms`).then((r) => r.json()).catch(() => ({ rooms: [] }));
    fail(`读取静默操作员状态失败：${e.message}（room2=${room2} player=${mute.id} 房间列表=${JSON.stringify(rooms.rooms)}）`);
    throw e;
  }
  const maxStrikes = s3.maxStrikes;
  let strikesMade = 0;
  const exhausted = new Set(); // 已经"剪不出失误"的模块，别老盯着它
  for (let attempt = 0; attempt < 60 && strikesMade < maxStrikes; attempt++) {
    s3 = await state(room2, mute.id);
    if (s3.room.phase !== 'playing') break;
    const candidates = s3.bomb.moduleStates.filter((x) => x.status !== 'solved' && x.state && !exhausted.has(x.uid));
    const target =
      candidates.find((x) => ['keypad', 'memory', 'password', 'quiz', 'simon', 'morse'].includes(x.id)) || candidates[0];
    if (!target) {
      // 整颗炸弹被"误打误撞"拆完了（或者剩下的模块都剪不出失误）：重开一颗新的继续测失误上限
      exhausted.clear();
      await h2.send({ type: 'restart' });
      await h2.send({ type: 'start' });
      continue;
    }
    const res = await makeStrike(mute, target.uid);
    if (res.strike) {
      strikesMade++;
      ok(`第 ${strikesMade}/${maxStrikes} 次失误（${target.title}）：${res.note}`);
    } else if (res.error) {
      // 这个模块这条路已经走不通了，下一轮换一个
      exhausted.add(target.uid);
    } else {
      fail(`故意失误没有被记录（${target.title}: ${JSON.stringify(res)}）`);
      break;
    }
  }
  await mute.refresh();
  if (mute.view.status === 'exploded') ok(`失误达到上限 → 炸弹爆炸，结算 ${mute.view.result.score.score} 分`);
  else fail(`失误到上限后应该爆炸，实际 ${mute.view.status}`);

  await h2.send({ type: 'restart' });
  await mute.refresh();
  if (mute.view.room.phase === 'lobby') ok('重开回到准备阶段，可以再来一局');
  else fail('重开没有回到准备阶段');

  // ================================================ 场景 4：时间耗尽 → 爆炸
  console.log('\n— 场景 4：倒计时耗尽 —');
  const h3 = new Client('房主3');
  await h3.create('房主3', 'normal');
  const room3 = h3.room;
  const d3 = new Client('拆弹3');
  const e3 = new Client('专家3');
  await d3.join(room3, '拆弹3', 'defuser');
  await e3.join(room3, '专家3', 'expert');
  d3.listen(); e3.listen();
  await h3.send({ type: 'start' });
  // 把倒计时压到 1 秒（测试后门只在 --test 下存在）
  await h3.send({ type: 'debugSetTime', ms: 1200 }).catch(() => {
    fail('测试后门 debugSetTime 不可用（服务端没有以 --test 启动？）');
  });
  await sleep(2200);
  await d3.refresh();
  if (d3.view.status === 'timeout') ok('倒计时归零 → 炸弹爆炸（超时结算）');
  else fail(`倒计时归零后应当超时爆炸，实际 ${d3.view.status}`);

  // ==================================================== 场景 5：难度与会话信息
  console.log('\n— 场景 5：难度档位与会话信息 —');
  const rooms = await fetch(BASE + '/api/rooms').then((r) => r.json());
  if (rooms.difficulties?.length) {
    ok(`难度档位：${rooms.difficulties.map((d) => `${d.name}(${d.modules[0]}~${d.modules[1]} 模块/${d.maxStrikes} 失误/${d.timeSec}s)`).join('、')}`);
  } else fail('/api/rooms 没有返回难度列表');
  if (rooms.roles?.length) ok(`可选角色：${rooms.roles.map((r) => r.name).join('、')}`);
  else fail('/api/rooms 没有返回角色列表');

  [mute, e2, d3, e3].forEach((c) => c.close());
  console.log(`\n失败 ${failures} 项`);
  process.exit(failures ? 1 : 0);
}

// --------------------------------------------------------------- play a module
async function oracle(client, uid) {
  const o = await client.send({ type: 'module', uid, action: { type: 'oracle' } });
  return o;
}

/** Play one module correctly, step by step, over HTTP (like a real defuser). */
async function solveModule(client, uid, ctx) {
  let steps = 0;
  let waits = 0;
  let lastError = '';
  const deadline = ctx.gameDeadline || Date.now() + 120000;
  while (steps < (ctx.maxSteps || 80)) {
    await client.refresh();
    const mod = client.view.bomb.moduleStates.find((m) => m.uid === uid);
    if (!mod) return { solved: false, reason: '模块不存在' };
    if (mod.status === 'solved') return { solved: true };
    if (client.view.room.phase !== 'playing') return { solved: false, reason: `游戏已经结束（${client.view.status}）` };
    const o = await oracle(client, uid);
    const S = o.oracle;
    const st = o.moduleState;
    let action = null;

    switch (o.moduleId) {
      case 'wires': action = { type: 'cut', index: S.target }; break;
      case 'button': {
        if (S.mode === 'tap') action = { type: 'press' };
        else if (!st.holding) action = { type: 'press' };
        else if (!st.strip) { await sleep(320); action = { type: 'strip' }; }
        else {
          const remain = Math.ceil((deadline - Date.now()) / 1000);
          // 只有当倒计时马上要显示目标数字时才值得松手（真人也是在等这一秒）
          if (!String(remain).includes(String(S.digit))) {
            if (waits++ > 60) return { solved: false, reason: `等不到显示 ${S.digit} 的那一秒（当前 ${remain}s）` };
            await sleep(150);
            continue;
          }
          action = { type: 'release' };
        }
        break;
      }
      case 'keypad': action = { type: 'tap', symbol: S.order[st.pressed.length] }; break;
      case 'simon': action = { type: 'pressColor', color: S.table[S.sequence[st.expected]][0] }; break;
      case 'memory': action = { type: 'tap', pos: S.solve[st.stage] }; break;
      case 'morse': {
        // 电报机：按字母把点横（和灯带颜色）发出去
        const letters = S.letters[st.index] || S.letters[0];
        const item = letters[st.sentCount || 0];
        if (!item) return { solved: false, reason: '没有下一个字母' };
        const code = typeof item === 'string' ? item : item.code;
        const color = typeof item === 'string' ? undefined : item.color;
        action = { type: 'sendLetter', marks: [...code].map((m) => (m === '-' ? 'dash' : 'dot')), color };
        break;
      }
      case 'maze': action = { type: 'move', dir: nextMazeStep(S, st.pos) }; break;
      case 'password': {
        const i = st.slots.findIndex((slot, idx) => slot.letters[slot.pos] !== S.word[idx]);
        action = i >= 0 ? { type: 'cycle', index: i, dir: 1 } : { type: 'submit' };
        break;
      }
      case 'quiz': action = { type: 'choose', index: S.index }; break;
      case 'gears': action = { type: 'choose', dir: S.answer }; break;
      case 'balance': {
        const l = st.slots[0], r = st.slots[1];
        if (l.filled < S.leftCount) action = { type: 'add', side: 0 };
        else if (r.filled < S.rightCount) action = { type: 'add', side: 1 };
        else if (l.filled > S.leftCount) action = { type: 'remove', side: 0 };
        else if (r.filled > S.rightCount) action = { type: 'remove', side: 1 };
        else action = { type: 'submit' };
        break;
      }
      case 'decoder': {
        const want = String(S.answer);
        action = (st.input || '').length < want.length
          ? { type: 'digit', digit: want[(st.input || '').length] }
          : { type: 'submit' };
        break;
      }
      case 'signal': {
        // 电报机：按字母把点横（和灯带颜色）发出去
        const letters = S.letters[st.index] || S.letters[0];
        const item = letters[st.sentCount || 0];
        if (!item) return { solved: false, reason: '没有下一个字母' };
        const code = typeof item === 'string' ? item : item.code;
        const color = typeof item === 'string' ? undefined : item.color;
        action = { type: 'sendLetter', marks: [...code].map((m) => (m === '-' ? 'dash' : 'dot')), color };
        break;
      }
      case 'wires2': action = { type: 'cut', index: S.cutIndex }; break;
      case 'capacitor': action = { type: 'pull', t: S.trigger }; break;
      case 'safeknob': action = st.entered.length < S.answer.length ? { type: 'confirm', value: S.answer[st.entered.length] } : { type: 'confirm', value: S.answer[0] }; break;
      case 'letterpad': action = { type: 'tapLetter', letter: S.word[st.picked.length] }; break;
      case 'simon2': {
        const all = [...S.answerA, ...S.answerB];
        action = { type: 'pressColor', color: all[st.expected] };
        break;
      }
      default: return { solved: false, reason: `未知模块 ${o.moduleId}` };
    }

    if (!action) return { solved: false, reason: '无法决定下一步动作' };
    steps++;
    const res = await client.send({ type: 'module', uid, action });
    if (res.error) lastError = res.error;
    if (res.strike) lastError = `解算过程中被记了一次失误（${res.note}）`;
    if (res.solved) {
      if (res.strike) return { solved: true, reason: '（附带一次失误）' };
      return { solved: true };
    }
  }
  return { solved: false, reason: `超过步数上限${lastError ? `（最后错误：${lastError}）` : ''}` };
}

function nextMazeStep(S, pos) {
  const N = 6;
  const key = (c, r) => `${c},${r}`;
  const dist = new Map([[key(...S.goal), 0]]);
  const next = new Map();
  const q = [[...S.goal]];
  const steps = [[0, -1, 1, 'up'], [1, 0, 2, 'right'], [0, 1, 4, 'down'], [-1, 0, 8, 'left']];
  const opposite = { up: 'down', down: 'up', left: 'right', right: 'left' };
  while (q.length) {
    const [c, r] = q.shift();
    const w = S.walls[r * N + c];
    for (const [dc, dr, bit, dir] of steps) {
      if (w & bit) continue;
      const nc = c + dc, nr = r + dr;
      if (nc < 0 || nc >= N || nr < 0 || nr >= N) continue;
      if (dist.has(key(nc, nr))) continue;
      dist.set(key(nc, nr), dist.get(key(c, r)) + 1);
      // BFS 从终点往外走：邻居要往"回到当前格"的方向前进，也就是相反方向
      next.set(key(nc, nr), opposite[dir]);
      q.push([nc, nr]);
    }
  }
  return next.get(key(...pos)) || null;
}

/** Produce one deliberate mistake that the server must count as a strike. */
async function makeStrike(client, uid) {
  const o = await oracle(client, uid);
  const S = o.oracle;
  const st = o.moduleState;
  const act = (action) => client.send({ type: 'module', uid, action });
  switch (o.moduleId) {
    case 'wires': {
      const other = st.wires.find((w) => w.i !== S.target && !w.cut);
      // 线剪完了就剪不出失误了：当成"这条路走不通"，让调用方换模块（别当成断言失败）
      if (!other) return { error: '这个线缆模块已经没有别的线可剪了' };
      return act({ type: 'cut', index: other.i });
    }
    case 'button': {
      // 按住类：先把倒计时推到"肯定不显示正确数字"的秒数，再松手 → 必定失误
      if (S.mode === 'tap') { await act({ type: 'press' }); return act({ type: 'release' }); }
      await act({ type: 'press' });
      await sleep(320);
      await act({ type: 'strip' });
      // 找一个两位秒数区间：既不含正确数字，也不是 0
      const digits = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].filter((d) => d !== S.digit);
      const target = 10 + (digits.find((d) => d !== 0) || 1);
      await client.send({ type: 'debugSetTime', ms: (target - 1) * 1000 + 500 }).catch(() => {});
      await sleep(120);
      return act({ type: 'release' });
    }
    case 'keypad': return act({ type: 'tap', symbol: S.order[3] });
    case 'simon': return act({ type: 'pressColor', color: ['red', 'blue', 'green', 'yellow'].find((c) => c !== S.table[S.sequence[0]][0]) });
    case 'memory': return act({ type: 'tap', pos: S.solve[0] === 1 ? 2 : 1 });
    case 'maze': {
      const N = 6; const [c, r] = st.pos; const w = S.walls[r * N + c];
      const dir = (w & 1) ? 'up' : (w & 2) ? 'right' : (w & 4) ? 'down' : 'left';
      return act({ type: 'move', dir });
    }
    case 'password': return act({ type: 'submit' });
    case 'quiz': return act({ type: 'choose', index: (S.index + 1) % st.options.length });
    case 'gears': return act({ type: 'choose', dir: S.answer === 'cw' ? 'ccw' : 'cw' });
    case 'balance': return act({ type: 'add', side: 0 });
    case 'decoder': {
      await act({ type: 'digit', digit: '9' });
      return act({ type: 'submit' });
    }
    case 'signal': return act({ type: 'sendLetter', marks: ['dot'] });
    case 'wires2': {
      const other = st.wires.find((w) => w.i !== S.cutIndex && !w.cut);
      return act({ type: 'cut', index: other ? other.i : (S.cutIndex + 1) % st.wires.length });
    }
    case 'capacitor': return act({ type: 'pull', t: 1 });
    case 'safeknob': {
      await act({ type: 'setDial', value: 3 });
      return act({ type: 'confirm', value: 3 });
    }
    case 'letterpad': return act({ type: 'tapLetter', letter: 'Q' });
    case 'simon2': {
      const all = [...S.answerA, ...S.answerB];
      const right = all[0];
      return act({ type: 'pressColor', color: ['red', 'blue', 'green', 'yellow', 'white'].find((c) => c !== right) });
    }
    case 'morse': return act({ type: 'sendLetter', marks: ['dot'] });
    default: return act({ type: 'tap' });
  }
}

main().catch((e) => { console.error('E2E 异常:', e.message); process.exit(1); });

