// Level generation for the bomb modules.
//
// Every module instance carries:
//   state    -> what the DEFUSER sees and manipulates (never the answer)
//   rules    -> rule-table blocks for the EXPERT manual
//               group.visibility = 'full'    : printed in every manual
//               group.visibility = 'partial' : split between expert seats on
//                                              hard+ difficulties
//   solution -> server-side only; what the engine validates against
//   asks     -> the bomb facts an expert must ask about for this module
//
// All rules here are original content written for this project.

import { makeSerial, hasVowel, serialLastDigit, serialOdd } from './rng.js';
import { COLORS } from './vocab.js';
import { gears, balance, decoder, signal } from './modules-extra.js';
import { EXTRA_MODULES } from './modules-more.js';

const cn = (id) => (COLORS[id] || { name: id }).name;
const nameList = (arr) => arr.map(cn).join('、');

// ===========================================================================
// 1) 线缆 — cut exactly one wire
// ===========================================================================
const wires = {
  id: 'wires',
  title: '线缆',
  icon: '🪢',
  tier: (t) => t,
  make(rng, cfg, tier) {
    const n = tier <= 1 ? rng.range(3, 4) : tier === 2 ? rng.range(4, 5) : rng.range(5, 6);
    const striped = tier >= 4;
    const colors = rng.shuffle(
      ['red', 'blue', 'yellow', 'green', 'white', 'black'].concat(rng.shuffle(['red', 'blue', 'yellow', 'green', 'white', 'black'])),
    ).slice(0, n);
    if (tier >= 3) {
      // make sure the guaranteed variety still holds after slicing
      for (const c of ['red', 'blue', 'yellow']) if (!colors.includes(c)) colors[rng.int(n)] = c;
    }
    const list = colors.map((c, i) => ({ i, color: c, striped: striped && rng.bool(0.4), cut: false }));
    const count = (c) => colors.filter((x) => x === c).length;
    const firstOf = (c) => colors.indexOf(c);
    const lastOf = (c) => colors.lastIndexOf(c);
    const last = n - 1;

    const rows = [];
    const add = (label, target, note = '') => rows.push({ label, action: `剪断第 ${target + 1} 根线`, target, note });

    const cands = [];
    if (tier === 1) {
      cands.push([!hasVowel(cfg.serial) && count('red') === 1, `序列号不含元音字母，且有且只有一根红线`, firstOf('red')]);
      cands.push([hasVowel(cfg.serial) && count('yellow') === 1, `序列号含元音字母，且有且只有一根黄线`, firstOf('yellow')]);
      cands.push([colors[last] === 'blue', `最后一根线是蓝线`, last]);
      cands.push([count('white') >= 2, `白线不止一根`, lastOf('white')]);
      cands.push([cfg.batteries >= 2, `电池有 2 个或更多`, last]);
      cands.push([true, `以上都不满足`, 0]);
    } else if (tier === 2) {
      cands.push([count('yellow') === 0 && serialOdd(cfg.serial), `没有黄线，且序列号末位是奇数`, 2 % n]);
      cands.push([count('yellow') >= 2 && count('red') === 1, `黄线不止一根，且红线只有一根`, last]);
      cands.push([colors[last] === 'black' && serialOdd(cfg.serial), `最后一根线是黑线，且序列号末位是奇数`, 3 % n]);
      cands.push([count('blue') === 1 && count('white') >= 1, `蓝线只有一根，且有白线`, firstOf('blue')]);
      cands.push([count('white') >= 2 && colors[0] === 'white', `白线不止一根，且第一根是白线`, 0]);
      cands.push([!!cfg.indicatorMap['CAR'] && count('red') >= 2, `CAR 指示灯亮着，且红线不止一根`, lastOf('red')]);
      cands.push([true, `以上都不满足`, 0]);
    } else {
      cands.push([count('red') >= 2 && serialOdd(cfg.serial), `红线不止一根，且序列号末位是奇数`, lastOf('red')]);
      cands.push([count('black') === 0 && cfg.batteries >= 1, `没有黑线，且至少有 1 个电池`, last]);
      cands.push([count('blue') === 1 && count('yellow') >= 2, `蓝线只有一根，且黄线不止一根`, firstOf('blue')]);
      cands.push([count('white') >= 2 && !cfg.indicatorMap['SIG'], `白线不止一根，且 SIG 指示灯没亮`, lastOf('white')]);
      cands.push([cfg.ports.includes('parallel') && count('blue') >= 1, `炸弹上有 Parallel 端口，且至少有一根蓝线`, lastOf('blue')]);
      cands.push([colors[last] === 'green' && count('green') === 1, `最后一根线是绿线，且只有这一根绿线`, last]);
      cands.push([cfg.batteries === 0 && count('black') >= 1, `没有电池，且至少有黑线`, lastOf('black')]);
      cands.push([hasVowel(cfg.serial) && count('yellow') === 1, `序列号含元音字母，且黄线只有一根`, firstOf('yellow')]);
      cands.push([true, `以上都不满足`, 0]);
    }
    let target = 0;
    for (const [cond, label, t] of cands) {
      if (cond) { target = t; }
      // 只把前面几条和命中的那条写进手册，方便专家顺着读
      rows.push({ label, action: `剪断第 ${t + 1} 根线`, target: t });
      if (cond) break;
    }

    return {
      state: { wires: list, n },
      rules: {
        groups: [
          { title: '线缆从上到下依次编号为第 1 根、第 2 根……', kind: 'note', visibility: 'full' },
          {
            title: `线缆模块规则（本模块 ${n} 根线${striped ? '，可能带条纹' : ''}）`,
            kind: 'table',
            visibility: 'partial',
            head: ['从上往下检查', '操作'],
            rows,
          },
        ],
      },
      solution: { target },
      asks: ['线缆数量', '从上到下的颜色顺序', '是否带条纹', '序列号是否含元音', '序列号末位奇偶', '电池数量', '亮着的指示灯', '端口'],
      reset: false,
    };
  },
  apply(mod, action) {
    if (action.type !== 'cut') return { error: '不支持的操作' };
    const w = mod.state.wires[action.index];
    if (!w) return { error: '这根线不存在' };
    if (w.cut) return { error: '这根线已经剪断了' };
    w.cut = true;
    if (action.index === mod.solution.target) return { solved: true, note: `剪断第 ${action.index + 1} 根线 —— 正确` };
    return { strike: true, note: `剪断第 ${action.index + 1} 根线 —— 错误，正确答案是第 ${mod.solution.target + 1} 根` };
  },
};

// ===========================================================================
// 2) 按钮 — tap it, or hold it and release on the right timer digit
// ===========================================================================
const RELEASE_TABLE = [
  { label: '蓝色光条', action: '计时器任意一位显示 4 时松开', digit: 4, key: 'blue' },
  { label: '白色光条', action: '计时器任意一位显示 1 时松开', digit: 1, key: 'white' },
  { label: '黄色光条', action: '计时器任意一位显示 5 时松开', digit: 5, key: 'yellow' },
  { label: '其他颜色光条', action: '计时器任意一位显示 1 时松开', digit: 1, key: 'other' },
];
const STRIP_NAME = { blue: '蓝色光条', white: '白色光条', yellow: '黄色光条', other: '其他颜色光条' };
const STRIP_COLOR = { blue: 'blue', white: 'white', yellow: 'yellow', other: 'orange' };

/** 光条名字：solution 里缺字段时也能兜底，不给后面留 undefined。 */
function stripNameOf(strip) {
  return STRIP_NAME[strip] || STRIP_NAME.other;
}

const button = {
  id: 'button',
  title: '按钮',
  icon: '🔘',
  tier: (t) => t,
  make(rng, cfg, tier) {
    const color = rng.pick(['red', 'blue', 'yellow', 'white']);
    const label = rng.pick(['按下', '按住', '引爆', '中止', '重来']);
    const strip = rng.pick(['blue', 'white', 'yellow', 'other']);
    const useRca = tier >= 3;

    const conds = [
      color === 'blue' && label === '中止',
      color === 'white' && label === '按下' && !!cfg.indicatorMap['CAR'],
      color === 'red' && label === '按住',
      label === '引爆' && cfg.batteries >= 2,
      ...(useRca ? [color === 'red' && cfg.ports.includes('rca')] : []),
      color === 'yellow' && !!cfg.indicatorMap['FRK'],
      color === 'yellow',
      true,
    ];
    // 前三条与最后两条固定；中段在开启 RCA 规则时插入一条
    const acts = ['hold', 'hold', 'tap', 'tap', ...(useRca ? ['tap'] : []), 'hold', 'hold', 'hold'];
    const texts = [
      color === 'blue' && label === '中止' ? '按钮是蓝色，且写着「中止」' : null,
      color === 'white' && label === '按下' && cfg.indicatorMap['CAR'] ? '按钮是白色、写着「按下」，且 CAR 指示灯亮着' : null,
      color === 'red' && label === '按住' ? '按钮是红色，且写着「按住」' : null,
      label === '引爆' && cfg.batteries >= 2 ? '按钮写着「引爆」，且电池有 2 个或更多' : null,
      ...(useRca ? [color === 'red' && cfg.ports.includes('rca') ? '按钮是红色，且炸弹上有 Stereo RCA 端口' : null] : []),
      color === 'yellow' && cfg.indicatorMap['FRK'] ? '按钮是黄色，且 FRK 指示灯亮着' : null,
      color === 'yellow' ? '按钮是黄色' : null,
      '以上都不满足',
    ];

    let idx = 0;
    for (let i = 0; i < conds.length; i++) if (conds[i]) { idx = i; break; }
    const mode = acts[idx];
    const releaseRow = RELEASE_TABLE.find((r) => r.key === strip);

    const rows = [];
    for (let i = 0; i < texts.length; i++) {
      if (!texts[i]) continue;
      rows.push({
        label: texts[i],
        action: acts[i] === 'tap' ? '轻按一下就松手' : '按住不放，再查「松开时机」表',
      });
      if (i === idx) break;
    }

    return {
      state: { color, label, holding: false, strip: null, holdingSince: null },
      rules: {
        groups: [
          { title: '从上往下检查，命中第一条就照做', kind: 'note', visibility: 'full' },
          { title: '按下的方式', kind: 'table', visibility: 'partial', head: ['情况', '操作'], rows },
          { title: '松开时机（按住后右侧会亮起一根光条）', kind: 'table', visibility: 'full', head: ['光条颜色', '松开时机'], rows: RELEASE_TABLE.map(({ label, action }) => ({ label, action })) },
        ],
      },
      solution: { mode, digit: releaseRow.digit, strip, stripName: STRIP_NAME[strip], stripColor: STRIP_COLOR[strip] },
      asks: ['按钮颜色', '按钮上的文字', '指示灯（CAR / FRK）', '电池数量', '端口', '光条颜色', '计时器上的数字'],
      reset: false,
    };
  },
  apply(mod, action, ctx) {
    const sol = mod.solution;
    if (action.type === 'press') {
      if (mod.state.holding) return { error: '按钮已经按住了' };
      mod.state.holding = true;
      mod.state.holdingSince = Date.now();
      if (sol.mode === 'tap') {
        mod.state.holding = false;
        mod.state.holdingSince = null;
        return { solved: true, note: '轻按一下 —— 正确，模块解除' };
      }
      return { note: '按钮被按住，右侧光条亮起' };
    }
    if (action.type === 'strip') {
      if (!mod.state.holding) return { error: '没有按住按钮' };
      mod.state.strip = sol.strip;
      return { note: `光条亮起：${sol.stripName}` };
    }
    if (action.type === 'release') {
      if (!mod.state.holding) return { error: '没有按住按钮' };
      mod.state.holding = false;
      mod.state.holdingSince = null;
      if (sol.mode === 'tap') return { strike: true, note: '这个按钮应该轻按一下' };
      const seconds = Math.max(0, Math.ceil((ctx ? ctx.remainingMs : 0) / 1000));
      const ok = String(seconds).includes(String(sol.digit));
      mod.state.strip = null;
      if (ok) return { solved: true, note: `在计时器显示 ${seconds} 时松开 —— 正确` };
      return { strike: true, note: `在计时器显示 ${seconds} 时松开 —— 错误，应该在显示 ${sol.digit} 时松开` };
    }
    return { error: '不支持的操作' };
  },
};

// ===========================================================================
// 3) 符号键盘 — press the four symbols in the order of the matching column
// ===========================================================================
const KEYPAD_SYMBOLS = ['Ϙ', 'Ѧ', 'ƛ', 'Ϟ', 'Ѭ', 'ϗ', 'Ω', 'Ѣ', 'Ж', '҂', 'Ѵ', 'Ѳ', '҈', 'Ҋ', '★', '☯', '☘', '⚑'];

const keypad = {
  id: 'keypad',
  title: '符号键盘',
  icon: '⌨️',
  tier: (t) => Math.min(5, t + 1),
  make(rng, cfg, tier) {
    // 键盘上正好 4 个符号（和手册里"只有一列完整包含这四个符号"的规则对应）
    const symbols = rng.sample(KEYPAD_SYMBOLS, 4);
    const slots = rng.shuffle(symbols);
    const order = rng.shuffle(symbols);

    // 干扰列各缺一个模块上的符号：3 个正确符号 + 1 个不在键盘上的符号
    const pool = KEYPAD_SYMBOLS.filter((s) => !symbols.includes(s));
    const others = [];
    while (others.length < 2) {
      const keep = rng.sample(symbols, 3);
      const extra = rng.pick(pool);
      const col = rng.shuffle(keep.concat(extra));
      const key = [...col].sort().join('');
      if (others.some((o) => [...o].sort().join('') === key)) continue;
      others.push(col);
    }
    const columns = rng.shuffle([order, ...others]);
    return {
      state: { slots, pressed: [] },
      rules: {
        groups: [
          { title: '三列符号中，只有一列完整包含键盘上的四个符号。', kind: 'note', visibility: 'full' },
          {
            title: '符号列',
            kind: 'table',
            visibility: 'partial',
            head: ['列', '从上到下'],
            rows: columns.map((col, i) => ({ label: `第 ${i + 1} 列`, action: col.join('  ') })),
          },
          { title: '操作：按那一列里符号从上到下的先后顺序，依次按下键盘上的四个符号。', kind: 'note', visibility: 'full' },
        ],
      },
      solution: { order },
      asks: ['键盘上的四个符号', '每个符号所在的位置'],
      reset: true,
    };
  },
  apply(mod, action) {
    if (action.type !== 'tap') return { error: '不支持的操作' };
    const sym = action.symbol;
    if (!mod.state.slots.includes(sym)) return { error: '这个符号不在模块上' };
    if (mod.state.pressed.includes(sym)) return { error: '这个符号已经按过了' };
    const expect = mod.solution.order[mod.state.pressed.length];
    const ok = sym === expect;
    mod.state.pressed.push(sym);
    if (!ok) return { strike: true, reset: true, note: `按下 ${sym} —— 顺序错误，模块重置` };
    if (mod.state.pressed.length === 4) return { solved: true, note: '四个符号顺序全部正确' };
    return { note: `按下 ${sym} —— 正确（${mod.state.pressed.length}/4）` };
  },
  resetState(mod) { mod.state.pressed = []; },
};

// ===========================================================================
// 4) 闪光序列 — repeat the flashes using a colour-conversion table
// ===========================================================================
const SIMON_BTN = ['red', 'blue', 'green', 'yellow'];

const simon = {
  id: 'simon',
  title: '闪光序列',
  icon: '🚦',
  tier: (t) => t,
  make(rng, cfg, tier) {
    const rounds = tier <= 1 ? 3 : tier <= 2 ? 4 : tier <= 3 ? 5 : tier === 4 ? 6 : 7;
    const sequence = [];
    for (let i = 0; i < rounds; i++) sequence.push(rng.pick(SIMON_BTN));
    const buttons = rng.shuffle(SIMON_BTN);
    // 序列本身不能在拆弹者界面上出现（否则不用沟通就能拆）
    const playSeq = sequence.slice();
    const strikesNow = 0;

    const tableFor = (strikesState) => {
      const table = {};
      if (tier <= 2) {
        const map = hasVowel(cfg.serial)
          ? { red: 'blue', blue: 'red', green: 'yellow', yellow: 'green' }
          : { red: 'blue', blue: 'yellow', green: 'green', yellow: 'red' };
        for (const c of SIMON_BTN) table[c] = [map[c]];
      } else {
        const vowel = hasVowel(cfg.serial);
        const noStrike = vowel
          ? { red: 'blue', blue: 'yellow', green: 'green', yellow: 'red' }
          : { red: 'blue', blue: 'red', green: 'yellow', yellow: 'green' };
        const one = vowel
          ? { red: 'yellow', blue: 'green', green: 'blue', yellow: 'red' }
          : { red: 'red', blue: 'blue', green: 'yellow', yellow: 'green' };
        const two = vowel
          ? { red: 'green', blue: 'red', green: 'yellow', yellow: 'blue' }
          : { red: 'yellow', blue: 'green', green: 'blue', yellow: 'red' };
        for (const c of SIMON_BTN) table[c] = [noStrike[c], one[c], two[c]];
      }
      return table;
    };

    const strikeStates = tier <= 2 ? 1 : 3;
    const strikeLabels = ['没有失误', '有 1 次失误', '有 2 次失误'].slice(0, strikeStates);
    const table = tableFor();
    const colorLabel = (c) => cn(c);
    const rows = [];
    for (const flash of SIMON_BTN) {
      const cells = table[flash];
      rows.push({
        label: `${colorLabel(flash)}光闪烁`,
        action: cells.map((c) => `按${colorLabel(c)}`).join(' / '),
      });
    }

    return {
      // 注意：这里只把"要闪的颜色序列"给拆弹者看（playSeq），答案是另一张表，
      // 拆弹者拿到 sequence 也没用，但仍然不给，避免客户端顺走答案。
      state: { buttons, playSeq, seqLength: sequence.length, expected: 0, rounds, strikeStates },
      rules: {
        groups: [
          { title: `模块会按顺序闪 ${sequence.length} 次。把每次闪的颜色念给专家，他查表告诉你该按哪个按钮。`, kind: 'note', visibility: 'full' },
          {
            title: tier <= 2 ? (hasVowel(cfg.serial) ? '序列号含元音字母时的换算表' : '序列号不含元音字母时的换算表') : '换算表（列 = 当前失误次数）',
            kind: 'table',
            visibility: 'partial',
            head: tier <= 2 ? ['闪烁的颜色', '要按的按钮'] : ['闪烁的颜色', ...strikeLabels],
            rows: tier <= 2 ? rows.map((r) => ({ label: r.label, action: r.action.split(' / ')[0] })) : rows,
          },
          { title: '按错不会重置序列，但会累计一次炸弹失误，并从第 1 次闪烁重新开始。', kind: 'note', visibility: 'full' },
        ],
      },
      solution: { sequence, table, strikeStates },
      asks: ['每次闪烁的颜色与顺序', '序列号是否含元音', '当前失误次数'],
      reset: false,
    };
  },
  apply(mod, action, ctx) {
    if (action.type !== 'pressColor') return { error: '不支持的操作' };
    const color = action.color;
    if (!SIMON_BTN.includes(color)) return { error: '颜色不存在' };
    const i = mod.state.expected;
    const total = mod.solution.sequence.length;
    const flash = mod.solution.sequence[i];
    const strikes = Math.min(ctx ? ctx.strikes : 0, mod.solution.table[flash].length - 1);
    const want = mod.solution.table[flash][strikes];
    if (color !== want) {
      mod.state.expected = 0;
      mod.state.beat = 0;
      return { strike: true, note: `按了${cn(color)} —— 错误，第 ${i + 1} 次闪烁应该按${cn(want)}，从第 1 次重新开始` };
    }
    mod.state.expected++;
    mod.state.beat = mod.state.expected;
    if (mod.state.expected >= total) {
      mod.state.round = mod.state.rounds;
      return { solved: true, note: '整个序列都按对了，模块解除' };
    }
    return { note: `按${cn(color)} —— 正确（${mod.state.expected}/${total}）` };
  },
  resetState(mod) { mod.state.expected = 0; mod.state.beat = 0; },
};

// ===========================================================================
// 5) 记忆 — five stages, later answers depend on what you pressed before
// ===========================================================================
const memory = {
  id: 'memory',
  title: '记忆',
  icon: '🧠',
  tier: (t) => t + 1,
  make(rng, cfg, tier) {
    const stages = [];
    for (let s = 0; s < 5; s++) {
      stages.push({ display: rng.pick([1, 2, 3, 4]), buttons: rng.shuffle([1, 2, 3, 4]) });
    }
    // 手册里给出的固定映射（阶段 1 是逐条列出的，之后每行给出四列结果）
    const T = {
      1: { 1: 2, 2: 2, 3: 3, 4: 4 },
      2: { 1: 4, 2: 3, 3: 2, 4: 1 },
      3: { 1: 1, 2: 4, 3: 1, 4: 2 },
      4: { 1: 3, 2: 1, 3: 3, 4: 2 },
      5: { 1: 2, 2: 1, 3: 4, 4: 4 },
    };
    const solve = stages.map((st, i) => T[i + 1][st.display]);

    const tableRows = [
      { label: '阶段 1', action: '显示 1 → 第 2 个；显示 2 → 第 2 个；显示 3 → 第 3 个；显示 4 → 第 4 个' },
      { label: '阶段 2', action: '显示 1 → 第 4 个；显示 2 → 第 3 个；显示 3 → 第 2 个；显示 4 → 第 1 个' },
      { label: '阶段 3', action: '显示 1 → 第 1 个；显示 2 → 第 4 个；显示 3 → 第 1 个；显示 4 → 第 2 个' },
      { label: '阶段 4', action: '显示 1 → 第 3 个；显示 2 → 第 1 个；显示 3 → 第 3 个；显示 4 → 第 2 个' },
      { label: '阶段 5', action: '显示 1 → 第 2 个；显示 2 → 第 1 个；显示 3 → 第 4 个；显示 4 → 第 4 个' },
    ];

    return {
      state: { stage: 0, display: stages[0].display, buttons: stages[0].buttons, history: [] },
      rules: {
        groups: [
          { title: '共 5 个阶段。按钮位置从左到右依次是第 1~4 个。按错按钮会让阶段回到 1。', kind: 'note', visibility: 'full' },
          { title: '各阶段要按的按钮', kind: 'table', visibility: 'partial', head: ['阶段', '要按的按钮'], rows: tableRows },
        ],
      },
      solution: { stages, solve },
      asks: ['屏幕上的数字', '四个按钮上的数字与它们的位置', '现在是第几个阶段'],
      reset: true,
    };
  },
  apply(mod, action) {
    if (action.type !== 'tap') return { error: '不支持的操作' };
    const pos = action.pos;
    const s = mod.state.stage;
    const want = mod.solution.solve[s];
    if (pos !== want) {
      mod.state.stage = 0;
      mod.state.display = mod.solution.stages[0].display;
      mod.state.buttons = mod.solution.stages[0].buttons;
      mod.state.history = [];
      return { strike: true, reset: true, note: `按下第 ${pos} 个按钮 —— 错误，应该按第 ${want} 个；阶段回到 1` };
    }
    mod.state.history.push(pos);
    if (s === 4) return { solved: true, note: '五个阶段全部正确，模块解除' };
    mod.state.stage = s + 1;
    mod.state.display = mod.solution.stages[s + 1].display;
    mod.state.buttons = mod.solution.stages[s + 1].buttons;
    return { note: `阶段 ${s + 1} 正确，进入阶段 ${s + 2}` };
  },
  resetState(mod) {
    mod.state.stage = 0;
    mod.state.display = mod.solution.stages[0].display;
    mod.state.buttons = mod.solution.stages[0].buttons;
    mod.state.history = [];
  },
};

// ===========================================================================
// 6) 摩斯电码 — read the flashing light, set the frequency, transmit
// ===========================================================================
const MORSE_TABLE = [
  { w: 'shell', f: '3.505 MHz', code: '-... . .... . .-.. .-..' },
  { w: 'brick', f: '3.575 MHz', code: '-... .-. .. -.-. -.-' },
  { w: 'flick', f: '3.555 MHz', code: '..-. .-.. .. -.-. -.-' },
  { w: 'sting', f: '3.592 MHz', code: '... - .. -. --.' },
  { w: 'beats', f: '3.600 MHz', code: '-... . .- - ...' },
  { w: 'trick', f: '3.532 MHz', code: '- .-. .. -.-. -.-' },
  { w: 'bombs', f: '3.565 MHz', code: '-... --- -- -... ...' },
  { w: 'boxes', f: '3.535 MHz', code: '-... --- -..- . ...' },
  { w: 'leaks', f: '3.542 MHz', code: '.-.. . .- -.- ...' },
  { w: 'strobe', f: '3.545 MHz', code: '... - .-. --- -... .' },
  { w: 'bistro', f: '3.552 MHz', code: '-... .. ... - .-. ---' },
  { w: 'vector', f: '3.595 MHz', code: '...- . -.-. - --- .-.' },
  { w: 'steak', f: '3.582 MHz', code: '... - . .- -.-' },
  { w: 'break', f: '3.572 MHz', code: '-... .-. . .- -.-' },
  { w: 'slick', f: '3.522 MHz', code: '... .-.. .. -.-. -.-' },
  { w: 'halls', f: '3.515 MHz', code: '.... .- .-.. .-.. ...' },
];
const MORSE_DIGITS = [
  ['1', '.----'], ['2', '..---'], ['3', '...--'], ['4', '....-'], ['5', '.....'],
  ['6', '-....'], ['7', '--...'], ['8', '---..'], ['9', '----.'], ['0', '-----'],
];

const MORSE_ALPHABET = {
  A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.', H: '....',
  I: '..', J: '.---', K: '-.-', L: '.-..', M: '--', N: '-.', O: '---', P: '.--.',
  Q: '--.-', R: '.-.', S: '...', T: '-', U: '..-', V: '...-', W: '.--', X: '-..-',
  Y: '-.--', Z: '--..',
};

function fmtMarks(s) {
  return [...String(s)].map((m) => (m === '-' ? '—' : '·')).join(' ');
}

const morse = {
  id: 'morse',
  title: '摩斯电报',
  icon: '📻',
  tier: (t) => t + 1,
  make(rng, cfg, tier) {
    const count = tier >= 5 ? 2 : 1;
    const picks = rng.sample(MORSE_TABLE, count);
    const letterRows = [];
    for (const p of picks) {
      [...p.w].forEach((ch, i) => {
        letterRows.push({ label: `${p.w} 第 ${i + 1} 个字母「${ch}」`, action: MORSE_ALPHABET[ch.toUpperCase()] || '?' });
      });
    }
    return {
      state: {
        words: picks.map((p) => ({ word: p.w })),
        index: 0,
        entered: [],
        sentCount: 0,
        done: 0,
        total: count,
      },
      rules: {
        groups: [
          { title: '拆弹者的屏幕上显示一个【单词】。你的任务：把这个单词翻译成摩斯电码，把每一串念给他，让他在电报机上敲出来。', kind: 'note', visibility: 'full' },
          { title: '摩斯电码对照表：A .-  B -...  C -.-.  D -..  E .  F ..-.  G --.  H ....  I ..  J .---  K -.-  L .-..  M --  N -.  O ---  P .--.  Q --.-  R .-.  S ...  T -  U ..-  V ...-  W .--  X -..-  Y -.--  Z --..', kind: 'note', visibility: 'full' },
          { title: '数字：' + MORSE_DIGITS.map(([d, c]) => `${d} ${c}`).join('  '), kind: 'note', visibility: 'full' },
          {
            title: '逐字母拆解（一个字母一串，念完停一下最清楚）',
            kind: 'table',
            visibility: 'partial',
            head: ['位置', '该字母的电码'],
            rows: letterRows,
          },
          {
            title: '整个单词的完整序列（也可以直接照着念）',
            kind: 'table',
            visibility: 'partial',
            head: ['单词', '点横序列'],
            rows: picks.map((p) => ({ label: p.w, action: p.code })),
          },
          { title: '拆弹者一个字母一组地敲进电报机；敲错一整个单词会退回重来。', kind: 'note', visibility: 'full' },
        ],
      },
      solution: {
        words: picks.map((p) => ({ word: p.w, code: p.code })),
        letters: picks.map((p) => [...p.w].map((ch) => MORSE_ALPHABET[ch.toUpperCase()] || '?')),
      },
      asks: ['屏幕上显示的单词是什么', '一共几个单词'],
      reset: true,
    };
  },
  /** 电报机输入：按字母提交点横序列（也可以先 tapKey 攒着再 sendLetter）。 */
  apply(mod, action) {
    const sol = mod.solution;
    const want = sol.letters[mod.state.index] || [];
    if (action.type === 'tapKey') {
      const mark = action.mark === 'dash' ? '-' : '.';
      mod.state.entered = (mod.state.entered || []).slice(0, 7);
      mod.state.entered.push(mark);
      return { note: `敲入 ${fmtMarks(mod.state.entered.join('')).replace(/ /g, '')}（${mod.state.entered.length} 个）` };
    }
    if (action.type === 'clearKey') {
      mod.state.entered = [];
      return { note: '清空了当前这一串' };
    }
    if (action.type === 'sendLetter') {
      const given = Array.isArray(action.marks) && action.marks.length
        ? action.marks.map((m) => (m === 'dash' || m === '-' ? '-' : '.'))
        : (mod.state.entered || []);
      if (!given.length) return { error: '还没有敲任何点横' };
      const idx = mod.state.sentCount || 0;
      const expect = want[Math.min(idx, want.length - 1)] || want[0];
      const got = given.join('');
      mod.state.entered = [];
      if (got !== expect) {
        mod.state.sentCount = 0;
        return { strike: true, reset: true, note: `这一串敲成了 ${fmtMarks(got)} —— 错误，应该按 ${fmtMarks(expect)}，整个单词重来` };
      }
      mod.state.sentCount = idx + 1;
      if (mod.state.sentCount >= want.length) {
        const wordInfo = sol.words[mod.state.index];
        mod.state.sentCount = 0;
        mod.state.done++;
        mod.state.index++;
        if (mod.state.done >= mod.state.total) {
          return { solved: true, note: `${wordInfo.word} 的电码全部敲对，模块解除` };
        }
        return { note: `${wordInfo.word} 完成，还有 ${mod.state.total - mod.state.done} 个单词` };
      }
      return { note: `第 ${mod.state.sentCount}/${want.length} 个字母敲对（${fmtMarks(expect)}）` };
    }
    if (action.type === 'skipWord') {
      mod.state.index = (mod.state.index + 1) % sol.words.length;
      mod.state.entered = [];
      mod.state.sentCount = 0;
      return { note: '切换到下一个单词' };
    }
    return { error: '不支持的操作' };
  },
  resetState(mod) { mod.state.entered = []; mod.state.sentCount = 0; },
};

// ===========================================================================
// 7) 迷宫 — the wall layout is only printed in the manual
// ===========================================================================
const MAZE_N = 6;

function mazeGen(rng) {
  const idx = (c, r) => r * MAZE_N + c;
  const walls = new Array(MAZE_N * MAZE_N).fill(0b1111); // N E S W
  const seen = new Set();
  const stack = [[rng.int(MAZE_N), rng.int(MAZE_N)]];
  seen.add(idx(stack[0][0], stack[0][1]));
  const dirs = [
    [0, -1, 1, 4], // N
    [1, 0, 2, 8],  // E
    [0, 1, 4, 1],  // S
    [-1, 0, 8, 2], // W
  ];
  while (stack.length) {
    const [c, r] = stack[stack.length - 1];
    const options = dirs.filter(([dc, dr]) => {
      const nc = c + dc, nr = r + dr;
      return nc >= 0 && nc < MAZE_N && nr >= 0 && nr < MAZE_N && !seen.has(idx(nc, nr));
    });
    if (!options.length) { stack.pop(); continue; }
    const [dc, dr, bit, opp] = rng.pick(options);
    const nc = c + dc, nr = r + dr;
    walls[idx(c, r)] &= ~bit;
    walls[idx(nc, nr)] &= ~opp;
    seen.add(idx(nc, nr));
    stack.push([nc, nr]);
  }
  // 再加几段"多余"的墙做出死路，但只有不会把迷宫切成两块时才加
  for (let k = 0; k < 6; k++) {
    const c = rng.int(MAZE_N), r = rng.int(MAZE_N);
    const [dc, dr, bit, opp] = rng.pick(dirs);
    const nc = c + dc, nr = r + dr;
    if (nc < 0 || nc >= MAZE_N || nr < 0 || nr >= MAZE_N) continue;
    if (walls[idx(c, r)] & bit) continue; // 本来就有墙
    const savedA = walls[idx(c, r)];
    const savedB = walls[idx(nc, nr)];
    walls[idx(c, r)] |= bit;
    walls[idx(nc, nr)] |= opp;
    if (mazeReachable(walls, [0, 0]) < MAZE_N * MAZE_N) {
      walls[idx(c, r)] = savedA;
      walls[idx(nc, nr)] = savedB;
    }
  }
  return walls;
}

/** 从 start 出发能到达多少格（用于保证迷宫连通）。 */
function mazeReachable(walls, start) {
  const seen = new Set([start[1] * MAZE_N + start[0]]);
  const q = [start];
  const steps = [[0, -1, 1], [1, 0, 2], [0, 1, 4], [-1, 0, 8]];
  while (q.length) {
    const [c, r] = q.shift();
    const w = walls[r * MAZE_N + c];
    for (const [dc, dr, bit] of steps) {
      if (w & bit) continue;
      const nc = c + dc, nr = r + dr;
      if (nc < 0 || nc >= MAZE_N || nr < 0 || nr >= MAZE_N) continue;
      const k = nr * MAZE_N + nc;
      if (seen.has(k)) continue;
      seen.add(k);
      q.push([nc, nr]);
    }
  }
  return seen.size;
}

function mazeDist(walls, start) {
  const dist = new Map();
  const key = (c, r) => r * MAZE_N + c;
  dist.set(key(start[0], start[1]), 0);
  const q = [[start[0], start[1]]];
  const steps = [[0, -1, 1], [1, 0, 2], [0, 1, 4], [-1, 0, 8]];
  while (q.length) {
    const [c, r] = q.shift();
    const w = walls[r * MAZE_N + c];
    for (const [dc, dr, bit] of steps) {
      if (w & bit) continue;
      const nc = c + dc, nr = r + dr;
      if (nc < 0 || nc >= MAZE_N || nr < 0 || nr >= MAZE_N) continue;
      if (dist.has(key(nc, nr))) continue;
      dist.set(key(nc, nr), dist.get(key(c, r)) + 1);
      q.push([nc, nr]);
    }
  }
  return { get: (cell) => dist.get(key(cell[0], cell[1])), size: dist.size };
}

const maze = {
  id: 'maze',
  title: '迷宫',
  icon: '🌀',
  tier: (t) => t + 1,
  make(rng, cfg, tier) {
    const walls = mazeGen(rng);
    const start = [rng.int(MAZE_N), rng.int(MAZE_N)];
    // 终点取离起点尽可能远的格子（优先至少 7 步），让迷宫有真实路程
    const distances = mazeDist(walls, start);
    const ranked = [];
    for (let c = 0; c < MAZE_N; c++) {
      for (let r = 0; r < MAZE_N; r++) {
        const d = distances.get([c, r]);
        if (d === undefined || d === 0) continue;
        ranked.push({ cell: [c, r], d });
      }
    }
    ranked.sort((a, b) => b.d - a.d);
    const far = ranked.filter((x) => x.d >= 7);
    const fallback = ranked[0] ? ranked[0].cell : [(start[0] + 1) % MAZE_N, start[1]];
    const goal = far.length ? rng.pick(far.slice(0, Math.max(1, Math.ceil(far.length / 3)))).cell : fallback;
    // `ranked` was built from mazeDist, so every entry (and the goal) is reachable.

    return {
      state: {
        pos: start.slice(),
        goal,
        moves: 0,
        // 相对终点的行列差：拆弹者只能看到方向，看不到墙
        relC: goal[0] - start[0],
        relR: goal[1] - start[1],
      },
      rules: {
        groups: [
          { title: `迷宫是 ${MAZE_N}×${MAZE_N} 的格子。拆弹者只能看到自己的光点和终点的相对方向，看不到墙；只有手册上有墙。`, kind: 'note', visibility: 'full' },
          {
            title: '墙的分布（每格用四面墙里有哪些墙表示）',
            kind: 'maze',
            visibility: 'partial',
            walls,
            n: MAZE_N,
          },
          { title: '操作：拆弹者用上下左右移动光点，走到终点三角形即完成。', kind: 'note', visibility: 'full' },
        ],
      },
      solution: { walls, goal, start },
      asks: ['光点现在在第几行第几列', '终点三角形在第几行第几列', '上下左右哪些方向能走'],
      reset: false,
    };
  },
  apply(mod, action) {
    if (action.type !== 'move') return { error: '不支持的操作' };
    const { walls } = mod.solution;
    const [c, r] = mod.state.pos;
    const D = { up: [0, -1, 1], right: [1, 0, 2], down: [0, 1, 4], left: [-1, 0, 8] };
    const [dc, dr, bit] = D[action.dir];
    if (walls[r * MAZE_N + c] & bit) return { strike: true, note: '撞墙了 —— 那个方向没有路' };
    const nc = c + dc, nr = r + dr;
    if (nc < 0 || nc >= MAZE_N || nr < 0 || nr >= MAZE_N) return { strike: true, note: '撞到迷宫边缘了' };
    mod.state.pos = [nc, nr];
    mod.state.moves++;
    mod.state.relC = mod.state.goal[0] - nc;
    mod.state.relR = mod.state.goal[1] - nr;
    if (nc === mod.state.goal[0] && nr === mod.state.goal[1]) return { solved: true, note: '光点抵达终点三角形' };
    return { note: `移动到第 ${nr + 1} 行第 ${nc + 1} 列` };
  },
};

// ===========================================================================
// 8) 密码 — spin the letter drums into a word from the manual list
// ===========================================================================
const PASSWORD_WORDS = ['apple', 'bread', 'chair', 'dance', 'eagle', 'flame', 'ghost', 'house', 'input', 'juice', 'knife', 'lemon', 'money', 'nurse', 'ocean', 'piano', 'queen', 'radio'];

const password = {
  id: 'password',
  title: '密码',
  icon: '🔤',
  tier: (t) => t + 2,
  make(rng, cfg, tier) {
    const word = rng.pick(PASSWORD_WORDS);
    const letters = word.split('');
    const slots = letters.map((ch, i) => {
      const others = rng.shuffle('abcdefghijklmnopqrstuvwxyz'.split('').filter((c) => c !== ch));
      const set = [ch, others[0], others[1]];
      return { i, options: rng.shuffle(set), pos: 0 };
    });
    const rows = rng.sample(PASSWORD_WORDS, 8).map((w) => ({ label: w.slice(0, 2).toUpperCase(), action: w }));
    if (!rows.some((r) => r.action === word)) rows[0] = { label: word.slice(0, 2).toUpperCase(), action: word };
    return {
      state: { slots: slots.map((s) => ({ pos: s.pos, letters: s.options })), current: slots.map((s) => s.options[0]) },
      rules: {
        groups: [
          { title: '每个字母转轮上下各有按钮可以循环切换。把所有转轮拼成一个手册词表里存在的单词，然后按「提交」。', kind: 'note', visibility: 'full' },
          { title: '词表（可供拼出的单词）', kind: 'table', visibility: 'partial', head: ['编号', '单词'], rows },
        ],
      },
      solution: { word },
      asks: ['每个转轮上出现的字母', '转轮现在是第几个字母'],
      reset: false,
    };
  },
  apply(mod, action) {
    if (action.type === 'cycle') {
      const slot = mod.state.slots[action.index];
      if (!slot) return { error: '转轮不存在' };
      slot.pos = (slot.pos + action.dir + slot.letters.length) % slot.letters.length;
      mod.state.current[action.index] = slot.letters[slot.pos];
      return { note: `第 ${action.index + 1} 个转轮切换到 ${slot.letters[slot.pos]}` };
    }
    if (action.type === 'submit') {
      const got = mod.state.current.join('');
      if (got === mod.solution.word) return { solved: true, note: `提交 ${got} —— 正确，模块解除` };
      return { strike: true, note: `提交 ${got} —— 不在词表里，模块重置为初始字母` };
    }
    return { error: '不支持的操作' };
  },
  resetState(mod) {
    mod.state.slots = mod.state.slots.map((s) => ({ ...s, pos: 0 }));
    mod.state.current = mod.state.slots.map((s) => s.letters[0]);
  },
};

// ===========================================================================
// 9) 问答 — the question is on the bomb, the bomb facts are in the manual
// ===========================================================================
const quiz = {
  id: 'quiz',
  title: '逻辑问答',
  icon: '❓',
  tier: (t) => t + 1,
  make(rng, cfg, tier) {
    const bank = [];
    const portNames = cfg.ports.map((p) => ({ serial: 'Serial', parallel: 'Parallel', rca: 'Stereo RCA', dvid: 'DVI-D', usb: 'USB', rj45: 'RJ-45' }[p]));
    const letters = cfg.serial.replace(/[0-9]/g, '').split('');
    const digits = cfg.serial.replace(/[A-Z]/g, '').split('');
    const vowelCount = letters.filter((c) => 'AEIOU'.includes(c)).length;
    const indicators = Object.keys(cfg.indicatorMap).sort();

    bank.push({ q: '序列号里有几个元音字母？', a: String(vowelCount) });
    bank.push({ q: '序列号末位是奇数吗？', a: serialOdd(cfg.serial) ? '是' : '否' });
    bank.push({ q: '炸弹上电池有几个？', a: String(cfg.batteries) });
    bank.push({ q: '电池数量加上端口数量是多少？', a: String(cfg.batteries + cfg.ports.length) });
    bank.push({ q: '亮着的指示灯有几个？', a: String(indicators.length) });
    bank.push({ q: '序列号里字母出现的次数是多少？', a: String(letters.length) });
    bank.push({ q: '序列号里数字与字母数量的差是多少？', a: String(Math.abs(letters.length - digits.length)) });
    bank.push({ q: '炸弹上有 Parallel 端口吗？', a: cfg.ports.includes('parallel') ? '是' : '否' });
    bank.push({ q: '炸弹上有 Stereo RCA 端口吗？', a: cfg.ports.includes('rca') ? '是' : '否' });
    bank.push({ q: '序列号中最大的数字是几？', a: String(Math.max(...digits.map(Number))) });
    bank.push({ q: '序列号中最小数字的平方是多少？', a: String(Math.min(...digits.map(Number)) ** 2) });
    bank.push({ q: '电池数乘以指示灯数量是多少？', a: String(cfg.batteries * indicators.length) });
    bank.push({ q: '端口数量减去电池数量是多少？', a: String(cfg.ports.length - cfg.batteries) });
    bank.push({ q: '序列号第一个字母在字母表中的位置除以 2 余几？', a: String((cfg.serial[0].charCodeAt(0) - 64) % 2) });
    bank.push({ q: '亮着的指示灯的字母总数是多少？', a: String(indicators.join('').length) });
    bank.push({ q: `SIG、CAR、FRK 三个指示灯里有几个是亮着的？`, a: String(['SIG', 'CAR', 'FRK'].filter((k) => cfg.indicatorMap[k]).length) });

    const q = rng.pick(bank);
    // 干扰项：正确答案只在服务器存在，客户端只看到打乱后的选项
    const noisePool = [...new Set([String(vowelCount), String(vowelCount + 1), String(cfg.batteries), String(cfg.batteries + 1), '是', '否', '0', '1', '2', '3', '4', '5'].filter((x) => x !== q.a))];
    const wrong = rng.sample(noisePool, Math.min(3, noisePool.length));
    const shuffled = rng.shuffle([q.a, ...wrong]);
    const correctIndex = shuffled.indexOf(q.a);

    return {
      state: { question: q.q, options: shuffled, pressed: null, revealed: false },
      rules: {
        groups: [
          { title: `问题：${q.q}`, kind: 'note', visibility: 'full' },
          {
            title: '按钮上的选项',
            kind: 'table',
            visibility: 'full',
            head: ['编号', '选项'],
            rows: shuffled.map((o, i) => ({ label: `第 ${i + 1} 个`, action: o })),
          },
          { title: '提示：拆弹者看不到炸弹外壳上的序列号、电池、指示灯和端口，这些只有专家这边有。', kind: 'note', visibility: 'full' },
        ],
      },
      solution: { answer: q.a, index: correctIndex },
      asks: ['序列号', '电池数量', '亮着的指示灯', '端口'],
      reset: false,
    };
  },
  apply(mod, action) {
    if (action.type !== 'choose') return { error: '不支持的操作' };
    const i = action.index;
    mod.state.pressed = i;
    if (i === mod.solution.index) {
      mod.state.revealed = true;
      return { solved: true, note: '回答正确，模块解除' };
    }
    return { strike: true, note: '回答错误' };
  },
};

export const MODULES = {
  wires, button, keypad, simon, memory, morse, maze, password, quiz,
  gears, balance, decoder, signal,
  wires2: EXTRA_MODULES.complexWires,
  capacitor: EXTRA_MODULES.capacitor,
  safeknob: EXTRA_MODULES.safeKnob,
  letterpad: EXTRA_MODULES.letterPad,
  simon2: EXTRA_MODULES.simonDuo,
};
export const MODULE_LIST = Object.values(MODULES);
export { MAZE_N };

