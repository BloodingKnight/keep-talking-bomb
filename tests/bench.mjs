// Tests for the host "module test bench" (preview / previewAction) and for the
// maze direction hint (the bug where a light on the goal's row still reported
// "north").
//
//   node server/server.js 3388 --test
//   node tests/bench.mjs http://127.0.0.1:3388

const BASE = process.argv[2] || 'http://127.0.0.1:3388';

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

const MODULE_IDS = ['wires', 'button', 'keypad', 'simon', 'memory', 'morse', 'maze', 'password', 'quiz', 'gears', 'balance', 'decoder', 'signal', 'wires2', 'capacitor', 'safeknob', 'letterpad', 'simon2'];
const N = 6; // 迷宫边长

console.log(`模块测试台 @ ${BASE}\n`);

const host = await api('/api/create', { name: '房主', difficulty: 'normal' });
const room = host.roomCode;
const other = await api('/api/join', { room, name: '路人', role: 'expert' });

const preview = (module, tier) => api('/api/action', { room, playerId: host.playerId, type: 'preview', module, tier });
const previewAct = (uid, action) => api('/api/action', { room, playerId: host.playerId, type: 'previewAction', uid, action });

/**
 * 迷宫路径：用引擎自己的墙（测试后门）做一次 BFS，得到从起点到终点的方向序列。
 * 手写"下一步"很容易把方向搞反，这里直接算整条路，走的时候按顺序取第一个。
 */
function solvePath(oracle) {
  const N2 = N;
  const key = (c, r) => `${c},${r}`;
  const dist = new Map([[key(...oracle.start), 0]]);
  const prev = new Map();
  const q = [[...oracle.start]];
  const MOVES = [[0, -1, 1, 'up'], [1, 0, 2, 'right'], [0, 1, 4, 'down'], [-1, 0, 8, 'left']];
  while (q.length) {
    const [c, r] = q.shift();
    const w = oracle.walls[r * N2 + c];
    for (const [dc, dr, bit, mDir] of MOVES) {
      if (w & bit) continue;
      const nc = c + dc, nr = r + dr;
      if (nc < 0 || nc >= N2 || nr < 0 || nr >= N2) continue;
      if (dist.has(key(nc, nr))) continue;
      dist.set(key(nc, nr), dist.get(key(c, r)) + 1);
      prev.set(key(nc, nr), [c, r, mDir]);
      q.push([nc, nr]);
    }
  }
  const path = [];
  let cur = [...oracle.goal];
  while (key(...cur) !== key(...oracle.start)) {
    const step = prev.get(key(...cur));
    if (!step) return null;
    path.unshift(step[2]);
    cur = [step[0], step[1]];
  }
  return path;
}

// ------------------------------------------------ 1) 每个模块 × 每个等级可生成
console.log('— 每个模块、每个等级都能生成「题目 + 手册」—');
let checked = 0;
for (const modId of MODULE_IDS) {
  for (const tier of [1, 2, 3, 4, 5]) {
    const res = await preview(modId, tier);
    const pv = res.preview;
    if (!pv) { fail(`${modId} 等级 ${tier}：没有返回 preview`); continue; }
    const problems = [];
    if (!pv.state?.state) problems.push('缺少题目状态');
    if (!pv.manual?.sections?.length) problems.push('缺少手册');
    const groups = pv.manual?.sections?.[0]?.groups || [];
    if (!groups.length) problems.push('手册没有规则块');
    if (pv.tier !== tier) problems.push(`等级不对（${pv.tier}）`);
    if (!pv.asks?.length) problems.push('没有列出要问的信息');
    if (groups.some((g) => g.kind === 'table' && (!g.rows || !g.rows.length))) problems.push('手册里有空表格');
    if (problems.length) fail(`${modId} 等级 ${tier}：${problems.join('；')}`);
    else checked++;
  }
}
if (checked === MODULE_IDS.length * 5) ok(`${MODULE_IDS.length} 个模块 × 5 个等级 = ${checked} 道题都有题目和手册`);

// ------------------------------------------- 2) 按手册操作能拆掉 / 做错会报失误
console.log('\n— 测试台会真的判定：按手册做对能拆掉，做错会报失误 —');
const oracleFor = (uid) => api('/api/action', { room, playerId: host.playerId, type: 'previewAction', uid, action: { type: 'oracle' } }).then((r) => r.oracle);
const RELEASE_TABLE = { blue: 4, white: 1, yellow: 5, other: 1 };

/** 用"界面 + 手册（必要时用 oracle 充当一个耐心算数的专家）"推出下一步。 */
async function nextActions(modId, pv) {
  const st = pv.state.state;
  const rows = pv.manual.sections[0].groups.filter((g) => g.kind === 'table').flatMap((g) => g.rows || []);
  const oracle = (modId === 'quiz' || modId === 'gears') ? await oracleFor(pv.state.uid) : null;
  switch (modId) {
    case 'wires': return [{ type: 'cut', index: wireTarget(pv) }];
    case 'button': {
      if (st.holding && st.strip) return [{ type: 'release' }];
      if (st.holding) return [{ type: 'strip' }];
      const first = rows.find((r) => r.action.includes('轻按') || r.action.includes('按住'));
      if (!first) return [];
      return [{ type: 'press' }];
    }
    case 'keypad': {
      // 手册里那列必须"包含全部四个符号"（干扰列都缺一个）
      const col = rows.map((r) => r.action.split(/\s+/)).find((parts) => st.slots.every((s) => parts.includes(s)));
      if (!col) return [];
      const next = st.slots.filter((s) => !(st.pressed || []).includes(s)).sort((a, b) => col.indexOf(a) - col.indexOf(b))[0];
      return next ? [{ type: 'tap', symbol: next }] : [];
    }
    case 'simon': {
      // 界面给的是"要闪的颜色"（playSeq）；手册把它换算成要按的按钮
      const flash = (st.playSeq || [])[st.expected];
      if (!flash) return [];
      const nameOf = { red: '红', blue: '蓝', green: '绿', yellow: '黄' };
      const row = rows.find((r) => r.label.includes(nameOf[flash]));
      if (!row) return [];
      const cell = String(row.action).split(' / ')[0];
      const want = Object.entries(nameOf).find(([, n]) => cell.includes(n))?.[0];
      return want ? [{ type: 'pressColor', color: want }] : [];
    }
    case 'memory': {
      const row = rows[st.stage];
      if (!row || !row.action) return [];
      const m = new RegExp(`显示 ${st.display} → 第 (\\d) 个`).exec(row.action);
      return m ? [{ type: 'tap', pos: Number(m[1]) }] : [];
    }
    case 'morse':
    case 'signal': {
      // 电报机：从 oracle 拿到每个字母的点横（和灯带颜色），逐个发报
      const o = await oracleFor(pv.state.uid);
      const letters = o.letters[st.index] || o.letters[0];
      const item = letters[st.sentCount || 0];
      if (!item) return [];
      const code = typeof item === 'string' ? item : item.code;
      const color = typeof item === 'string' ? undefined : item.color;
      const marks = [...code].map((m) => (m === '-' ? 'dash' : 'dot'));
      return [{ type: 'sendLetter', marks, color }];
    }
    case 'maze': {
      const path = solvePath(await oracleFor(pv.state.uid));
      if (!path) return [];
      // 已经走过的步数 = moves；按路径继续走下一步
      return [{ type: 'move', dir: path[st.moves] }].filter((a) => a.dir);
    }
    case 'password': {
      const list = rows.map((r) => r.action);
      const current = st.slots.map((s) => s.letters[s.pos]).join('');
      if (list.includes(current)) return [{ type: 'submit' }];
      // 找出词表里"每列都能用现有字母拼出来"的那个词，然后逐列转到位
      const target = list.find((w) => w.split('').every((ch, i) => st.slots[i].letters.includes(ch)));
      if (!target) return [];
      const i = st.slots.findIndex((slot, idx) => slot.letters[slot.pos] !== target[idx]);
      return i >= 0 ? [{ type: 'cycle', index: i, dir: 1 }] : [{ type: 'submit' }];
    }
    case 'quiz': return [{ type: 'choose', index: oracle.index }];
    case 'gears': return [{ type: 'choose', dir: oracle.answer }];
    case 'balance': {
      const ruleRow = rows.find((r) => r.label.includes('所以要放的个数'));
      if (!ruleRow) return [];
      const need = Number(/放 (\d+) 个/.exec(ruleRow.action)[1]);
      const filled = st.slots[1].filled;
      if (filled < need) return [{ type: 'add', side: 1 }];
      if (filled > need) return [{ type: 'remove', side: 1 }];
      return [{ type: 'submit' }];
    }
    case 'decoder': {
      const a = parseInt(st.a, 2), b = parseInt(st.b, 2);
      const v = st.op === 'AND' ? (a & b) : st.op === 'OR' ? (a | b) : st.op === 'XOR' ? (a ^ b) : a + b;
      const want = String(v);
      const input = st.input || '';
      return input.length < want.length ? [{ type: 'digit', digit: want[input.length] }] : [{ type: 'submit' }];
    }
    case 'wires2':
      // 手册里逐根给了字母；这里用 oracle 拿到标准答案（等价于专家查表）
      return [{ type: 'cut', index: (await oracleFor(pv.state.uid)).cutIndex }];
    case 'capacitor':
      return [{ type: 'pull', t: (await oracleFor(pv.state.uid)).trigger }];
    case 'safeknob': {
      const ans = (await oracleFor(pv.state.uid)).answer;
      return st.entered.length < ans.length ? [{ type: 'confirm', value: ans[st.entered.length] }] : [];
    }
    case 'letterpad': {
      const word = (await oracleFor(pv.state.uid)).word;
      const next = word[st.picked.length];
      return next ? [{ type: 'tapLetter', letter: next }] : [];
    }
    case 'simon2': {
      const o = await oracleFor(pv.state.uid);
      const all = [...o.answerA, ...o.answerB];
      const next = all[st.expected];
      return next ? [{ type: 'pressColor', color: next }] : [];
    }
    default: return [];
  }
}
// 除了"按住类按钮"（测试台没有真实倒计时，无法判定松手时机），
// 其余模块都应该能按测试台给出的手册做对。
const SOLVABLE = ['wires', 'keypad', 'simon', 'memory', 'morse', 'maze', 'password', 'quiz', 'gears', 'balance', 'decoder', 'signal',
  'wires2', 'capacitor', 'safeknob', 'letterpad', 'simon2'];
const NO_TIMER = ['button'];
let solved = 0;
const unsolved = [];
for (const modId of SOLVABLE) {
  let pv = (await preview(modId, 5)).preview;
  const trace = [];
  let result = null;
  for (let step = 0; step < 80; step++) {
    const actions = await nextActions(modId, pv);
    if (!actions.length) {
      fail(`${modId}：解不下去了 —— 状态 ${JSON.stringify(pv.state.state).slice(0, 200)}｜轨迹 ${trace.slice(-6).join(' → ') || '(无)'}`);
      result = { stuck: true };
      break;
    }
    for (const action of actions) {
      let r;
      try {
        r = await previewAct(pv.state.uid, action);
      } catch (e) {
        fail(`${modId}：操作被拒绝 —— ${action.type} ${JSON.stringify(action)}（${e.message}）`);
        result = { strike: true };
        break;
      }
      trace.push(`${action.type}${action.index !== undefined ? `(${action.index})` : ''}${action.symbol ? `(${action.symbol})` : ''}${action.pos ? `(${action.pos})` : ''}${action.dir ? `(${action.dir})` : ''}${action.color ? `(${action.color})` : ''}${action.side !== undefined ? `(${action.side})` : ''}${action.digit ? `(${action.digit})` : ''}${action.freq ? `(${action.freq})` : ''} → ${r.previewResult?.solved ? 'solved' : r.previewResult?.strike ? 'STRIKE' : 'ok'}`);
      result = r.previewResult || {};
      pv = r.preview;
      if (result.strike) { fail(`${modId}：按手册操作却被记为失误（${result.note}）｜轨迹 ${trace.join(' → ')}`); break; }
      if (result.solved) break;
    }
    if (result?.strike || result?.solved) break;
  }
  if (result?.solved) solved++;
  else if (!unsolved.includes(modId)) unsolved.push(modId);
}
if (solved === SOLVABLE.length) ok(`${solved}/${SOLVABLE.length} 个可判定模块都能按测试台里的手册做对`);
else fail(`这些模块没能在测试台里做对：${unsolved.join(', ')}`);

// 按住类按钮：测试台不判失误，但要告诉房主"正式游戏里该在第几秒松手"
for (const modId of NO_TIMER) {
  const pv = (await preview(modId, 5)).preview;
  const o = await oracleFor(pv.state.uid);
  if (o.mode === 'tap') { ok('按住类按钮这道题是"轻按"，直接判定正确'); continue; }
  await previewAct(pv.state.uid, { type: 'press' });
  await previewAct(pv.state.uid, { type: 'strip' });
  const r = await previewAct(pv.state.uid, { type: 'release' });
  const note = r.previewResult?.benchNote || '';
  if (!r.previewResult?.strike && note.includes(String(o.digit))) {
    ok(`按住类按钮不判失误，并提示了正确松手时机（显示 ${o.digit} 时）：${note.slice(0, 40)}…`);
  } else {
    fail(`按住类按钮的测试台提示不对：${JSON.stringify(r.previewResult)}`);
  }
}

// 故意做错一次，确认会报"会记一次失误"
const wrongWire = (await preview('wires', 1)).preview;
const cutPlan = wireTarget(wrongWire);
const wrongIndex = wrongWire.state.state.wires.find((w) => w.i !== cutPlan)?.i ?? 0;
const wrongRes = await previewAct(wrongWire.state.uid, { type: 'cut', index: wrongIndex });
if (wrongRes.previewResult?.strike) ok(`故意剪错会报失误：${wrongRes.previewResult.note}`);
else fail('剪错线缆没有报失误');

const wrongQuiz = (await preview('quiz', 3)).preview;
const quizAnswer = (await oracleFor(wrongQuiz.state.uid)).index;
const wrongChoice = await previewAct(wrongQuiz.state.uid, { type: 'choose', index: (quizAnswer + 1) % wrongQuiz.state.state.options.length });
if (wrongChoice.previewResult?.strike) ok('故意答错问答会报失误');
else fail('问答答错没有报失误');

// ------------------------------------------------------------- 3) 权限隔离
console.log('\n— 只有房主能开测试台，且不影响正式游戏 —');
const denied = await api('/api/action', { room, playerId: other.playerId, type: 'preview', module: 'wires', tier: 3 })
  .then(() => null).catch((e) => e.message);
if (denied) ok(`非房主被拒绝：${denied}`);
else fail('非房主也能生成测试题目');

const a = (await preview('wires', 1)).preview;
const b = (await preview('wires', 1)).preview;
if (a.state.uid !== b.state.uid || JSON.stringify(a.state.state) !== JSON.stringify(b.state.state)) ok('每次「换一道题」都是新题目');
else fail('两次生成的题目完全一样');
const st = await fetch(`${BASE}/api/state?room=${room}&player=${host.playerId}`).then((r) => r.json());
if (st.state.room.phase === 'lobby' && !st.state.bomb?.moduleStates) ok('测试台不会往准备区塞炸弹');
else fail('测试台污染了房间状态');

// 测试台里做对了，不会让房间"开始游戏"
const solvedInBench = (await preview('gears', 2)).preview;
const gearDir = (await oracleFor(solvedInBench.state.uid)).answer;
await previewAct(solvedInBench.state.uid, { type: 'choose', dir: gearDir });
const st2 = await fetch(`${BASE}/api/state?room=${room}&player=${host.playerId}`).then((r) => r.json());
if (st2.state.room.phase === 'lobby') ok('测试台里拆掉模块不会推进正式游戏');
else fail('测试台的操作影响了正式游戏阶段');

// ------------------------------------------------------ 4) 迷宫方向提示
console.log('\n— 迷宫方向提示（同一行不该再报「北」）—');
const { mazeHint } = await import('../client/bomb.js');
const cases = [
  { relC: 0, relR: 0, expect: '就在这一格' },
  { relC: 3, relR: 0, expect: '东' },
  { relC: -2, relR: 0, expect: '西' },
  { relC: 0, relR: -2, expect: '北' },
  { relC: 0, relR: 1, expect: '南' },
  { relC: 2, relR: -3, expect: '北东' },
  { relC: -1, relR: 2, expect: '南西' },
];
let hintOk = 0;
for (const c of cases) {
  const got = mazeHint(c.relC, c.relR).name;
  if (got === c.expect) hintOk++;
  else fail(`relC=${c.relC} relR=${c.relR}：期望「${c.expect}」，实际「${got}」`);
}
if (hintOk === cases.length) ok(`方向提示 ${hintOk}/${cases.length} 组正确（同一行/同一列不再误报北）`);

// 在真实迷宫里按引擎自己的答案走一条路，提示必须跟着位置更新
let mazeMoves = 0;
let mazePv = (await preview('maze', 3)).preview;
const path = solvePath(await oracleFor(mazePv.state.uid));
if (!path) fail('迷宫题目没有从起点到终点的路');
else {
  for (const dir of path) {
    const before = mazePv.state.state;
    const r = await previewAct(mazePv.state.uid, { type: 'move', dir });
    if (r.previewResult?.strike) {
      fail(`按引擎给的路径走却撞墙：pos=${before.pos} dir=${dir}`);
      break;
    }
    mazePv = r.preview;
    mazeMoves++;
    const after = mazePv.state.state;
    if (expectedRel(after) !== `${after.relC},${after.relR}`) fail(`服务端下发的相对位置不对（pos=${after.pos} goal=${after.goal} rel=${after.relC},${after.relR}）`);
    const expect = mazeHint(after.goal[0] - after.pos[0], after.goal[1] - after.pos[1]).name;
    const shown = mazeHint(after.relC, after.relR).name;
    if (shown !== expect) fail(`移动后方向提示不对：${shown} ≠ ${expect}（pos=${after.pos} goal=${after.goal}）`);
    if (r.previewResult?.solved) break;
  }
}
if (mazeMoves) ok(`在真实迷宫里走了 ${mazeMoves} 步：方向提示与相对位置每一步都同步`);
// 终点在同一行时不能报"北"（用户报的那个 bug）
const rowCase = mazeHint(3, 0);
if (rowCase.name === '东' && rowCase.detail.includes('同一行')) ok(`同一行时提示「${rowCase.name}」（${rowCase.detail}），不再误报北`);
else fail(`同一行时提示仍然不对：${rowCase.name} / ${rowCase.detail}`);

console.log(`\n失败 ${failures} 项`);
process.exit(failures ? 1 : 0);

// ------------------------------------------------------------------ helpers
function expectedRel(st) {
  return `${st.goal[0] - st.pos[0]},${st.goal[1] - st.pos[1]}`;
}

function mazeWalls(pv) {
  return pv.manual.sections[0].groups.find((g) => g.kind === 'maze').walls;
}

/** 线缆：手册最后一行就是命中的那条。 */
function wireTarget(pv) {
  const rows = pv.manual.sections[0].groups.filter((g) => g.kind === 'table').flatMap((g) => g.rows || []);
  const m = /剪断第 (\d+) 根线/.exec(rows[rows.length - 1].action);
  return Number(m[1]) - 1;
}

/**
 * 用当前墙（手册）从**终点**做 BFS，next[起点] 就是"朝终点走的第一步"。
 * （从起点做 BFS 的话，next[格] 存的是"该格走向父亲"的方向，对终点来说
 *  那恰好是最后一步，会给出穿墙方向 —— 之前就踩了这个坑。）
 */
function pathStep(pv) {
  const walls = mazeWalls(pv);
  const st = pv.state.state;
  const key = (c, r) => `${c},${r}`;
  const dist = new Map([[key(...st.goal), 0]]);
  const next = new Map();
  const q = [[...st.goal]];
  const MOVES = [[0, -1, 1, 'up'], [1, 0, 2, 'right'], [0, 1, 4, 'down'], [-1, 0, 8, 'left']];
  while (q.length) {
    const [c, r] = q.shift();
    const w = walls[r * N + c];
    for (const [dc, dr, bit, mDir] of MOVES) {
      if (w & bit) continue;
      const nc = c + dc, nr = r + dr;
      if (nc < 0 || nc >= N || nr < 0 || nr >= N) continue;
      if (dist.has(key(nc, nr))) continue;
      dist.set(key(nc, nr), dist.get(key(c, r)) + 1);
      next.set(key(nc, nr), mDir);
      q.push([nc, nr]);
    }
  }
  return next.get(key(...st.pos)) || null;
}

/** 从任意格 BFS 到终点，返回从该格出发的第一步。 */
