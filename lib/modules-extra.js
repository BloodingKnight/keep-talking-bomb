// Extra puzzle modules: gears, balance, decoder, signal.
// Kept in a separate file so lib/modules.js stays readable; the same data model
// is used (state / rules / solution / asks / reset).
//
// All rule tables are original content written for this project.

import { hasVowel, serialOdd } from './rng.js';

const cn = (id) => ({ red: '红', blue: '蓝', yellow: '黄', green: '绿', white: '白', black: '黑' }[id] || id);

// ===========================================================================
// 齿轮传动 — 判断最后一枚齿轮的转向
// ===========================================================================
export const gears = {
  id: 'gears',
  title: '齿轮传动',
  icon: '⚙️',
  tier: (t) => t + 1,
  make(rng, cfg, tier) {
    const count = tier <= 2 ? rng.range(2, 3) : tier === 3 ? rng.range(4, 5) : rng.range(6, 8);
    const teethPool = [8, 10, 12, 15, 20, 24, 28, 32];
    const list = [];
    for (let i = 0; i < count; i++) list.push({ teeth: rng.pick(teethPool) });

    // 奇数个啮合齿轮 → 最后一枚反向；偶数个 → 同向
    const reverse = count % 2 === 1;
    const firstDir = 'cw'; // 起点固定顺时针（界面上写明）

    const rules = [];
    const rows = [];

    // 起始方向由手册规则决定，而不是固定值：让专家查表
    const startCw = tier >= 4 ? hasVowel(cfg.serial) : true;
    if (!startCw) list[0].startDir = 'ccw';
    const startDir = startCw ? 'cw' : 'ccw';
    const finalDir = (reverse ? (startDir === 'cw' ? 'ccw' : 'cw') : startDir);

    rows.push({
      label: '看齿轮的数量',
      action: '奇数个齿轮：最后一枚与第一枚反向；偶数个：与第一枚同向',
    });
    rows.push({
      label: '看第一枚齿轮的转向',
      action: tier >= 4
        ? '序列号含元音字母：第一枚顺时针；否则逆时针'
        : '第一枚固定顺时针',
    });
    if (tier >= 5) {
      rows.push({
        label: '另一条线索（末位奇数）',
        action: '若序列号末位是奇数，把最后得到的转向再翻转一次',
      });
    }
    const flipped = tier >= 5 && serialOdd(cfg.serial);
    const answer = flipped ? (finalDir === 'cw' ? 'ccw' : 'cw') : finalDir;

    return {
      state: {
        gears: list,
        startDir,
        expected: reverse ? 'reverse' : 'same',
      },
      rules: {
        groups: [
          { title: `本模块有 ${count} 个互相咬合的齿轮，第一个齿轮的转动会带动最后一个。`, kind: 'note', visibility: 'full' },
          { title: '判断方法', kind: 'table', visibility: 'partial', head: ['线索', '结论'], rows },
          { title: '咬合的两个齿轮一定反向转动。', kind: 'note', visibility: 'full' },
        ],
      },
      solution: { answer, count, startDir, reverse, flipped },
      asks: ['一共有几个齿轮', '第一枚齿轮的转向', '序列号是否含元音', '序列号末位奇偶'],
      reset: false,
    };
  },
  apply(mod, action) {
    if (action.type !== 'choose') return { error: '不支持的操作' };
    if (action.dir === mod.solution.answer) return { solved: true, note: `选择${action.dir === 'cw' ? '顺时针' : '逆时针'} —— 正确` };
    return { strike: true, note: `选择${action.dir === 'cw' ? '顺时针' : '逆时针'} —— 错误，正确答案是${mod.solution.answer === 'cw' ? '顺时针' : '逆时针'}` };
  },
};

// ===========================================================================
// 天平配重 — 用重量 × 格数凑出相等的力矩
// ===========================================================================
export const balance = {
  id: 'balance',
  title: '天平配重',
  icon: '⚖️',
  tier: (t) => t + 2,
  make(rng, cfg, tier) {
    // 左盘固定 1 个配重（界面上就摆着），玩家只需要往两边加/减，
    // 最后让力矩相等。手册给出的是一套确定的配方。
    const leftWeight = rng.pick([2, 3, 4, 5]);
    const leftDist = rng.range(1, 3);
    const target = leftWeight * leftDist;

    // 右盘：挑一个能整除 target 的（重量 × 格数），保证有整数解
    const rightOptions = [];
    for (const w of [2, 3, 4, 5, 6]) {
      for (const d of [1, 2, 3]) {
        const unit = w * d;
        if (target % unit === 0 && target / unit >= 1 && target / unit <= 6) rightOptions.push({ w, d, need: target / unit });
      }
    }
    if (!rightOptions.length) rightOptions.push({ w: 2, d: 1, need: target / 2 });
    const right = rng.pick(rightOptions);
    const rightCount = right.need;

    const left = { weight: leftWeight, dist: leftDist, filled: 1, fixed: true };
    const rightSlot = { weight: right.w, dist: right.d, filled: 0, fixed: false };
    const cap = rightCount + 3;

    return {
      state: {
        slots: [
          { ...left, side: '左' },
          { ...rightSlot, side: '右' },
        ],
        cap,
      },
      rules: {
        groups: [
          { title: '平衡条件：左侧（重量 × 距支点格数 × 数量）等于右侧。左侧那一个配重是固定的，你只能动右边的数量。', kind: 'note', visibility: 'full' },
          {
            title: '配重规则',
            kind: 'table',
            visibility: 'partial',
            head: ['线索', '结论'],
            rows: [
              { label: '左侧力矩', action: `${leftWeight} × ${leftDist} = ${target}` },
              { label: '右侧每个的力矩', action: `${right.w} × ${right.d} = ${right.w * right.d}` },
              { label: '所以要放的个数', action: `右侧放 ${rightCount} 个` },
              ...(tier >= 4 ? [{ label: '上限提醒', action: `右侧最多放 ${cap} 个，不要多放` }] : []),
            ],
          },
          { title: '放好之后按「确认平衡」。', kind: 'note', visibility: 'full' },
        ],
      },
      solution: { leftCount: 1, rightCount, target },
      asks: ['两侧配重的重量', '两侧距支点的格数', '左侧现在是几个'],
      reset: false,
    };
  },
  apply(mod, action) {
    const st = mod.state;
    if (action.type === 'add' || action.type === 'remove') {
      const slot = st.slots[action.side];
      if (!slot) return { error: '这一侧不存在' };
      if (slot.fixed && action.type === 'remove') return { error: '左侧那个配重是固定的，拿不下来' };
      slot.filled = Math.max(0, Math.min(st.cap, slot.filled + (action.type === 'add' ? 1 : -1)));
      const l = st.slots[0], r = st.slots[1];
      return { note: `左侧 ${l.filled} 个（力矩 ${l.filled * l.weight * l.dist}），右侧 ${r.filled} 个（力矩 ${r.filled * r.weight * r.dist}）` };
    }
    if (action.type === 'submit') {
      const l = st.slots[0], r = st.slots[1];
      const lm = l.filled * l.weight * l.dist;
      const rm = r.filled * r.weight * r.dist;
      if (lm === rm && lm > 0) return { solved: true, note: `力矩 ${lm} = ${rm} —— 平衡了，模块解除` };
      return { strike: true, note: `还是不平衡（左 ${lm} / 右 ${rm}）` };
    }
    return { error: '不支持的操作' };
  },
};

// ===========================================================================
// 十进制解码 — 读两个二进制数字，算出结果再输入十进制
// ===========================================================================
const OPS = {
  AND: (a, b) => a & b,
  OR: (a, b) => a | b,
  XOR: (a, b) => a ^ b,
  ADD: (a, b) => a + b,
};

export const decoder = {
  id: 'decoder',
  title: '十进制解码',
  icon: '🔢',
  tier: (t) => t + 2,
  make(rng, cfg, tier) {
    const bits = tier >= 5 ? 6 : tier >= 3 ? 5 : 4;
    const a = rng.range(1, (1 << bits) - 1);
    const b = rng.range(1, (1 << bits) - 1);
    const opKeys = tier >= 4 ? ['AND', 'OR', 'XOR', 'ADD'] : ['AND', 'OR', 'ADD'];
    const op = rng.pick(opKeys);
    const answer = OPS[op](a, b);
    const pad = (n) => n.toString(2).padStart(bits, '0');
    const opName = { AND: '与', OR: '或', XOR: '异或', ADD: '加' }[op];
    const opSymbol = { AND: 'AND', OR: 'OR', XOR: 'XOR', ADD: '+' }[op];

    return {
      state: { a: pad(a), b: pad(b), op: opSymbol, bits, input: '' },
      rules: {
        groups: [
          { title: `两个数字各 ${bits} 位二进制。把上面的数字与下面的数字做运算，结果用十进制填进去。`, kind: 'note', visibility: 'full' },
          {
            title: '运算定义',
            kind: 'table',
            visibility: 'full',
            head: ['符号', '含义'],
            rows: [
              { label: 'AND（与）', action: '两位都是 1 才是 1' },
              { label: 'OR（或）', action: '有一位是 1 就是 1' },
              { label: 'XOR（异或）', action: '两位不同才是 1' },
              { label: '+（加）', action: '两个二进制数相加（可能有进位）' },
            ],
          },
          { title: '从最高位（左）往最低位（右）逐位对照，最后把二进制结果换成十进制。', kind: 'note', visibility: 'full' },
          ...(tier >= 4 ? [{
            title: '换算表（十进制）',
            kind: 'table',
            visibility: 'partial',
            head: ['二进制', '十进制'],
            rows: [
              { label: '00001 / 00010 / 00100', action: '1 / 2 / 4' },
              { label: '01000 / 10000 / 100000', action: '8 / 16 / 32' },
              { label: '其余位', action: '把出现 1 的位对应的数值加起来' },
            ],
          }] : []),
        ],
      },
      solution: { answer: String(answer), a, b, op, opName },
      asks: ['两串二进制数字（逐位念）', '中间的运算符号'],
      reset: false,
    };
  },
  apply(mod, action) {
    const st = mod.state;
    if (action.type === 'digit') {
      if (st.input.length >= 4) return { error: '最多输入 4 位数字' };
      st.input = (st.input || '') + String(action.digit);
      return { note: `当前输入 ${st.input}` };
    }
    if (action.type === 'back') {
      st.input = (st.input || '').slice(0, -1);
      return { note: `当前输入 ${st.input || '空'}` };
    }
    if (action.type === 'submit') {
      if (!st.input) return { error: '还没有输入数字' };
      if (st.input === mod.solution.answer) return { solved: true, note: `输入 ${st.input} —— 正确` };
      st.input = '';
      return { strike: true, note: `输入的数字不对（正确是 ${mod.solution.answer}），输入已清空` };
    }
    return { error: '不支持的操作' };
  },
};

// ===========================================================================
// 三色信号灯 — 三条灯带轮流闪摩斯节奏，读出各自的字母
// ===========================================================================
const SIGNAL_WORDS = ['shell', 'brick', 'flick', 'sting', 'beats', 'trick', 'bombs', 'boxes', 'leaks', 'strobe', 'bistro', 'vector', 'steak', 'break', 'slick', 'halls'];
const MORSE = {
  a: '.-', b: '-...', c: '-.-.', d: '-..', e: '.', f: '..-.', g: '--.', h: '....', i: '..', j: '.---',
  k: '-.-', l: '.-..', m: '--', n: '-.', o: '---', p: '.--.', q: '--.-', r: '.-.', s: '...', t: '-',
  u: '..-', v: '...-', w: '.--', x: '-..-', y: '-.--', z: '--..',
};

export const signal = {
  id: 'signal',
  title: '三色电报',
  icon: '🚨',
  tier: (t) => t + 1,
  make(rng, cfg, tier) {
    const count = tier >= 5 ? 2 : 1;
    const picks = rng.sample(SIGNAL_WORDS, count);
    const channels = ['红', '黄', '蓝'];
    // 每个字母都绑定一条灯带颜色：第 1 个字母走红灯、第 2 个黄灯、第 3 个蓝灯，循环
    const sets = picks.map((word) => ({
      word,
      letters: [...word].map((ch, i) => ({
        idx: i + 1,
        ch,
        chUpper: ch.toUpperCase(),
        color: channels[i % 3],
        code: MORSE[ch] || '?',
      })),
    }));

    return {
      state: {
        words: picks.map((p, i) => ({ word: p, index: i })),
        index: 0,
        entered: [],
        sentCount: 0,
        done: 0,
        total: count,
        // 三条灯带只显示"颜色 + 第几个字母"，节奏由专家给
        strips: channels.map((c) => ({ ch: c })),
      },
      rules: {
        groups: [
          { title: '拆弹者的屏幕上显示一个【单词】，还有红/黄/蓝三条灯带。第 1 个字母走红灯、第 2 个黄灯、第 3 个蓝灯，之后循环。', kind: 'note', visibility: 'full' },
          { title: '摩斯电码：A .-  B -...  C -.-.  D -..  E .  F ..-.  G --.  H ....  I ..  J .---  K -.-  L .-..  M --  N -.  O ---  P .--.  Q --.-  R .-.  S ...  T -  U ..-  V ...-  W .--  X -..-  Y -.--  Z --..', kind: 'note', visibility: 'full' },
          {
            title: '逐字母：要按哪条灯带、电码是什么（念给拆弹者）',
            kind: 'table',
            visibility: 'partial',
            head: ['字母', '灯带 + 电码'],
            rows: sets.flatMap((s) => s.letters.map((l) => ({
              label: `${s.word} 第 ${l.idx} 个「${l.ch}」`,
              action: `${l.color}灯：${l.code}`,
            }))),
          },
          ...(tier >= 5 ? [{ title: '会有两个单词，做完第一个再做第二个。', kind: 'note', visibility: 'full' }] : []),
          { title: '拆弹者按"灯带颜色 + 电码"逐个发报；某一串敲错，这个词要重来。', kind: 'note', visibility: 'full' },
        ],
      },
      solution: {
        words: picks.map((p) => ({ word: p })),
        letters: sets.map((s) => s.letters.map((l) => ({ color: l.color, code: l.code }))),
      },
      asks: ['屏幕上显示的单词是什么', '一共几个单词'],
      reset: true,
    };
  },
  /** 电报机输入：按字母提交"灯带颜色 + 点横序列"。 */
  apply(mod, action) {
    const sol = mod.solution;
    const want = sol.letters[mod.state.index] || [];
    if (action.type === 'tapKey') {
      const mark = action.mark === 'dash' ? '-' : '.';
      mod.state.entered = (mod.state.entered || []).slice(0, 7);
      mod.state.entered.push(mark);
      return { note: `敲入 ${mod.state.entered.map((m) => (m === '-' ? '—' : '·')).join(' ')}` };
    }
    if (action.type === 'clearKey') {
      mod.state.entered = [];
      return { note: '清空了当前这一串' };
    }
    if (action.type === 'sendLetter') {
      const idx = mod.state.sentCount || 0;
      const target = want[Math.min(idx, want.length - 1)] || want[0];
      const given = Array.isArray(action.marks) && action.marks.length
        ? action.marks.map((m) => (m === 'dash' || m === '-' ? '-' : '.'))
        : (mod.state.entered || []);
      if (!given.length) return { error: '还没有敲任何点横' };
      const got = given.join('');
      mod.state.entered = [];
      if (action.color && action.color !== target.color) {
        mod.state.sentCount = 0;
        return { strike: true, reset: true, note: `选了${action.color}灯 —— 错误，第 ${idx + 1} 个字母应该走${target.color}灯，这个词重来` };
      }
      if (got !== target.code) {
        mod.state.sentCount = 0;
        return { strike: true, reset: true, note: `${target.color}灯上敲成了 ${got} —— 错误，应该是 ${target.code}，这个词重来` };
      }
      mod.state.sentCount = idx + 1;
      if (mod.state.sentCount >= want.length) {
        const w = sol.words[mod.state.index];
        mod.state.sentCount = 0;
        mod.state.done++;
        mod.state.index++;
        if (mod.state.done >= mod.state.total) return { solved: true, note: `${w.word} 全部发报正确，模块解除` };
        return { note: `${w.word} 完成，还有 ${mod.state.total - mod.state.done} 个单词` };
      }
      return { note: `${target.color}灯第 ${mod.state.sentCount}/${want.length} 个字母正确` };
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
