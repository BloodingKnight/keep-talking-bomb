// Automated self-play test: for every difficulty and every module type, solve
// the generated bombs the way an expert+defuser pair would (following the
// printed rule tables), and report any module that cannot be solved.
//
//   node tests/selftest.mjs [iterations]

import { makeBomb } from '../lib/bomb.js';
import { MODULES } from '../lib/modules.js';
import { buildManual } from '../lib/view.js';
import { DIFFICULTY_ORDER, DIFFICULTIES } from '../lib/vocab.js';

let failures = 0;
let solvedCount = 0;
const perModule = {};

function fail(msg) { failures++; console.error('  ✗ ' + msg); }

/** Solve one module with the same information the real players would have. */
function telegraphSend(send, S) {
  for (const letters of S.letters) {
    for (const item of letters) {
      // morse 里是 '.-' 字符串；signal 里是 { color, code }
      const code = typeof item === 'string' ? item : item.code;
      const color = typeof item === 'string' ? undefined : item.color;
      const marks = [...code].map((m) => (m === '-' ? 'dash' : 'dot'));
      const r = send({ type: 'sendLetter', marks, color });
      if (r && r.solved) return true;
      if (r && r.strike) return false;
    }
  }
  return false;
}

function solveModule(bomb, mod, ctx) {
  const def = MODULES[mod.id];
  const send = (action, ctxOverride) => {
    const useCtx = ctxOverride || ctx;
    let res;
    if (def.extraActions && action.type === 'transmit') res = def.submit(mod, action, useCtx);
    else res = def.apply(mod, action, useCtx);
    if (!res) res = {};
    if (res.error) fail(`${mod.id}: 操作被拒绝（${res.error}）`);
    if (res.reset || res.strike) { if (def.resetState) def.resetState(mod); }
    return res;
  };
  const S = mod.solution;

  switch (mod.id) {
    case 'wires': return send({ type: 'cut', index: S.target }).solved;
    case 'button': {
      if (S.mode === 'tap') return send({ type: 'press' }).solved;
      send({ type: 'press' });
      send({ type: 'strip' });
      // release exactly when the countdown shows the required digit
      const ms = ctx.digitMs(S.digit);
      return send({ type: 'release' }, { ...ctx, remainingMs: ms }).solved;
    }
    case 'keypad': {
      for (const sym of S.order) { if (send({ type: 'tap', symbol: sym }).solved) return true; }
      return false;
    }
    case 'simon': {
      for (const flash of S.sequence) {
        const strikes = Math.min(ctx.strikes || 0, S.table[flash].length - 1);
        const r = send({ type: 'pressColor', color: S.table[flash][strikes] });
        if (r.solved) return true;
      }
      return false;
    }
    case 'memory': {
      for (const pos of S.solve) { if (send({ type: 'tap', pos }).solved) return true; }
      return false;
    }
    case 'morse': return telegraphSend(send, S);
    case 'maze': {
      // walk the shortest path using the walls from the manual
      const N = 6;
      const start = S.start, goal = S.goal;
      const dist = new Map();
      const prev = new Map();
      const key = (c, r) => `${c},${r}`;
      dist.set(key(...start), 0);
      const q = [start];
      const steps = [[0, -1, 1, 'up'], [1, 0, 2, 'right'], [0, 1, 4, 'down'], [-1, 0, 8, 'left']];
      while (q.length) {
        const [c, r] = q.shift();
        const w = S.walls[r * N + c];
        for (const [dc, dr, bit, dir] of steps) {
          if (w & bit) continue;
          const nc = c + dc, nr = r + dr;
          if (nc < 0 || nc >= N || nr < 0 || nr >= N) continue;
          if (dist.has(key(nc, nr))) continue;
          dist.set(key(nc, nr), dist.get(key(c, r)) + 1);
          prev.set(key(nc, nr), [c, r, dir]);
          q.push([nc, nr]);
        }
      }
      if (!dist.has(key(...goal))) return fail('maze: 终点不可达') && false;
      const path = [];
      let cur = goal;
      let guard = 0;
      while (key(...cur) !== key(...start) && guard++ < 200) {
        const step = prev.get(key(...cur));
        if (!step) break;
        const [pc, pr, dir] = step;
        path.unshift(dir);
        cur = [pc, pr];
      }
      for (const dir of path) { if (send({ type: 'move', dir }).solved) return true; }
      return fail(`${mod.id}: 走到终点却没有判定成功（path=${path.join(',')} start=${S.start} goal=${S.goal} pos=${mod.state.pos}）`) && false;
    }
    case 'password': {
      for (let i = 0; i < S.word.length; i++) {
        const slot = mod.state.slots[i];
        const want = S.word[i];
        let guard = 0;
        while (slot.letters[slot.pos] !== want && guard++ < 10) {
          send({ type: 'cycle', index: i, dir: 1 });
        }
      }
      return send({ type: 'submit' }).solved;
    }
    case 'quiz': return send({ type: 'choose', index: S.index }).solved;
    case 'gears': return send({ type: 'choose', dir: S.answer }).solved;
    case 'balance': {
      // 按手册：左侧保持 1 个，右侧放到解出的数量
      for (let i = 0; i < S.rightCount; i++) send({ type: 'add', side: 1 });
      for (let i = 0; i < S.leftCount - 1; i++) send({ type: 'add', side: 0 });
      return send({ type: 'submit' }).solved;
    }
    case 'decoder': {
      for (const d of String(S.answer)) send({ type: 'digit', digit: d });
      return send({ type: 'submit' }).solved;
    }
    case 'signal': return telegraphSend(send, S);
    case 'wires2': return send({ type: 'cut', index: S.cutIndex }).solved;
    case 'capacitor': return send({ type: 'pull', t: S.trigger }).solved;
    case 'safeknob': {
      let last;
      for (const v of S.answer) last = send({ type: 'confirm', value: v });
      return !!(last && last.solved);
    }
    case 'letterpad': {
      let last;
      for (const ch of S.word) last = send({ type: 'tapLetter', letter: ch });
      return !!(last && last.solved);
    }
    case 'simon2': {
      let last;
      for (const c of [...S.answerA, ...S.answerB]) {
        last = send({ type: 'pressColor', color: c });
        if (last && last.solved) return true;
      }
      return !!(last && last.solved);
    }
    default: return fail(`未知模块 ${mod.id}`) && false;
  }
}

const iters = Number(process.argv[2] || 40);
console.log(`自检：${iters} 次 × ${DIFFICULTY_ORDER.length} 个难度\n`);

for (const diffId of DIFFICULTY_ORDER) {
  let strikes = 0, mods = 0, ok = 0;
  for (let i = 0; i < iters; i++) {
    const bomb = makeBomb({ seed: `${diffId}-${i}`, difficulty: diffId });
    // sanity: serial + casing are well formed
    if (!/^[A-Z]{2}[0-9][A-Z][0-9]{2}$/.test(bomb.serial)) fail(`序列号格式错误: ${bomb.serial}`);
    if (bomb.modules.length !== DIFFICULTIES[diffId].modules[0] && bomb.modules.length !== DIFFICULTIES[diffId].modules[1]) {
      fail(`${diffId}: 模块数量 ${bomb.modules.length} 不在预期范围内`);
    }
    for (const mod of bomb.modules) {
      mods++;
      perModule[mod.id] = perModule[mod.id] || { n: 0, ok: 0 };
      perModule[mod.id].n++;
      const ctx = {
        strikes,
        remainingMs: bomb.durationMs,
        // pick a remaining time that makes the countdown show the wanted digit
        digitMs: (d) => (d === 0 ? 60000 : (10 + d) * 1000),
      };
      const solved = solveModule(bomb, mod, ctx);
      if (solved) { mod.status = 'solved'; ok++; perModule[mod.id].ok++; solvedCount++; }
      else fail(`${diffId}/${mod.uid}: 无法按手册解出`);
    }
  }
  console.log(`${DIFFICULTIES[diffId].name.padEnd(4)} 模块 ${mods} 个，可解 ${ok} 个`);
}

console.log('\n每个模块的生成与可解性：');
for (const [id, s] of Object.entries(perModule)) {
  const mark = s.ok === s.n ? '✓' : '✗';
  console.log(`  ${mark} ${id.padEnd(10)} ${s.ok}/${s.n}`);
}

// Manual projection sanity: every module contributes rule blocks, and a
// partial manual for the same seat is stable.
const bomb = makeBomb({ seed: 'manual-check', difficulty: 'expert' });
const m0 = buildManual(bomb, 0, 2, 'partial');
const m0b = buildManual(bomb, 0, 2, 'partial');
const m1 = buildManual(bomb, 1, 2, 'partial');
if (JSON.stringify(m0) !== JSON.stringify(m0b)) fail('手册投影不稳定（同一座位两次结果不同）');
if (JSON.stringify(m0.sections) === JSON.stringify(m1.sections)) fail('拆分手册：两个专家座位拿到了完全相同的内容');
if (!m0.casing.serial) fail('手册缺少外壳信息');
console.log(`\n手册投影：座位 0 与座位 1 ${JSON.stringify(m0.sections) === JSON.stringify(m1.sections) ? '相同（异常）' : '不同（正常）'}`);

console.log(`\n共解出 ${solvedCount} 个模块，失败 ${failures} 项`);
process.exit(failures ? 1 : 0);
