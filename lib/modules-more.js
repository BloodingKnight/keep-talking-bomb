// 第二批模块（参考手册里的经典玩法重新设计）：复杂线路 / 电容放电 / 保险柜旋钮 /
// 字母键盘 / 双序列闪光。数据模型与 lib/modules.js 完全一致。
//
// 所有规则表都是为本项目原创编写的。

import { serialOdd, serialLastDigit, hasVowel } from './rng.js';

const cn = (id) => ({ red: '红', blue: '蓝', yellow: '黄', green: '绿', white: '白', black: '黑' }[id] || id);

// ===========================================================================
// 复杂线路 — 带条纹/星标/LED 的线，按字母指引决定剪不剪
// ===========================================================================
const WIRE_LETTERS = ['C', 'D', 'S', 'P', 'B'];

export const complexWires = {
  id: 'wires2',
  title: '复杂线路',
  icon: '🧵',
  tier: (t) => t + 2,
  make(rng, cfg, tier) {
    const n = tier >= 5 ? 5 : 4;
    const colors = ['red', 'blue', 'white', 'yellow', 'black'];
    const wires = [];
    for (let i = 0; i < n; i++) {
      wires.push({
        i,
        color: rng.pick(colors),
        striped: rng.bool(0.45),
        star: rng.bool(0.4),
        led: rng.bool(0.5),
        cut: false,
      });
    }
    // 至少保证一根红线、一根蓝线
    if (!wires.some((w) => w.color === 'red')) wires[0].color = 'red';
    if (!wires.some((w) => w.color === 'blue')) wires[Math.min(1, n - 1)].color = 'blue';

    const letterFor = (w) => {
      const letters = [];
      // C：剪断
      if (w.color === 'red' && serialOdd(cfg.serial)) letters.push('C');
      if (w.color === 'white' && cfg.indicatorMap['SIG']) letters.push('C');
      // D：不要剪
      if (!w.led) letters.push('D');
      // S：序列号末位是偶数就剪
      if (w.color === 'blue' && !serialOdd(cfg.serial)) letters.push('S');
      // P：有 Parallel 端口就剪
      if (cfg.ports.includes('parallel') && w.star) letters.push('P');
      // B：电池两个以上就剪
      if (cfg.batteries >= 2 && w.color === 'yellow') letters.push('B');
      if (!letters.length) {
        if (w.striped) return 'C';
        if (cfg.ports.length >= 2) return 'P';
        return cfg.batteries >= 1 ? 'B' : 'D';
      }
      return letters[0];
    };
    const codes = wires.map(letterFor);
    // 从上往下找第一根"该剪"的（C/S/P/B）；如果全是 D，就按手册剪最后一根
    const found = codes.findIndex((c) => c === 'C' || c === 'S' || c === 'P' || c === 'B');
    const cutIdx = found >= 0 ? found : wires.length - 1;

    const rows = [
      { label: 'C', action: '剪断这根线' },
      { label: 'D', action: '不要剪这根线（直接跳过看下一根）' },
      { label: 'S', action: '序列号末位是偶数时剪断' },
      { label: 'P', action: '炸弹上有 Parallel 端口时剪断' },
      { label: 'B', action: '电池有 2 个或更多时剪断' },
    ];
    return {
      state: {
        wires: wires.map((w, i) => ({ ...w, code: codes[i] })),
        note: '每根线下面写着它的字母；从上到下看，第一根"该剪"的就剪它。',
      },
      rules: {
        groups: [
          { title: '每根线带上都有：一个字母、是否带条纹、是否带★、上方 LED 是否亮着。', kind: 'note', visibility: 'full' },
          { title: '字母含义', kind: 'table', visibility: 'full', head: ['字母', '含义'], rows },
          {
            title: '各根线的判定（按顺序检查）',
            kind: 'table',
            visibility: 'partial',
            head: ['第几根', '判定'],
            rows: wires.map((w, i) => {
              const why = [];
              if (w.color === 'red') why.push('红');
              if (w.color === 'blue') why.push('蓝');
              if (w.color === 'white') why.push('白');
              if (w.color === 'yellow') why.push('黄');
              if (w.color === 'black') why.push('黑');
              if (w.striped) why.push('有条纹');
              if (w.star) why.push('带★');
              why.push(w.led ? 'LED 亮' : 'LED 灭');
              return { label: `第 ${i + 1} 根（${why.join('、')}）`, action: `${codes[i]} —— ${rows.find((r) => r.label === codes[i]).action}` };
            }),
          },
          { title: '规则：从上往下找第一根字母是 C / S / P / B 的线剪断；全是 D 就剪最后一根。', kind: 'note', visibility: 'full' },
        ],
      },
      solution: { cutIndex: cutIdx, codes },
      asks: ['每根线的颜色、有没有条纹、有没有★、上方 LED 亮不亮', '序列号末位奇偶', '电池数量', '有没有 Parallel 端口', 'SIG 指示灯'],
      reset: false,
    };
  },
  apply(mod, action) {
    if (action.type !== 'cut') return { error: '不支持的操作' };
    const w = mod.state.wires[action.index];
    if (!w) return { error: '这根线不存在' };
    if (w.cut) return { error: '这根线已经剪断了' };
    w.cut = true;
    const want = mod.solution.cutIndex;
    if (action.index === want) return { solved: true, note: `剪断第 ${action.index + 1} 根 —— 正确（字母 ${mod.solution.codes[action.index]}）` };
    return { strike: true, note: `剪断第 ${action.index + 1} 根 —— 错误，应该剪第 ${want + 1} 根（字母 ${mod.solution.codes[want]}）` };
  },
};

// ===========================================================================
// 电容放电 — 看充电条走到安全区时拉下拉杆
// ===========================================================================
export const capacitor = {
  id: 'capacitor',
  title: '电容放电',
  icon: '🔋',
  tier: (t) => t + 2,
  make(rng, cfg, tier) {
    const period = tier >= 5 ? 9 : tier >= 4 ? 7 : 6;
    // 触发秒数由手册规则给出（每个周期在 4~6 秒之间）
    const trigger = 4 + rng.int(3);
    const window = tier >= 5 ? 1 : 2;
    return {
      state: { period, elapsed: 0, pulled: false, pullAt: null },
      rules: {
        groups: [
          { title: `指示灯从右下角开始每隔 ${period} 秒在 7 根刻度条上循环点亮一次；充电条到顶就会过载。`, kind: 'note', visibility: 'full' },
          {
            title: '放电时机',
            kind: 'table',
            visibility: 'partial',
            head: ['线索', '结论'],
            rows: [
              { label: '本次周期长度', action: `${period} 秒` },
              { label: '要按下的时间点', action: `在本周期第 ${trigger} 秒拉下拉杆（前后 ${window} 秒都算对）` },
              ...(tier >= 5 ? [{ label: '额外约束', action: '不要提前拉，提前拉也算失败' }] : []),
            ],
          },
        ],
      },
      solution: { trigger, window, period },
      asks: ['指示灯从第几个刻度开始亮', '每个周期几秒', '现在亮到第几个刻度'],
      reset: false,
    };
  },
  apply(mod, action) {
    if (action.type !== 'pull') return { error: '不支持的操作' };
    const t = typeof action.t === 'number' ? action.t : mod.state.elapsed;
    mod.state.pulled = true;
    mod.state.pullAt = t;
    const { trigger, window: win } = mod.solution;
    if (Math.abs(t - trigger) <= win) return { solved: true, note: `第 ${t.toFixed(1)} 秒拉下拉杆 —— 正确` };
    return { strike: true, note: `第 ${t.toFixed(1)} 秒拉下拉杆 —— 错误，应该在 ${trigger} 秒左右（±${win}s）` };
  },
};

// ===========================================================================
// 保险柜旋钮 — 按手册算出三位密码
// ===========================================================================
export const safeKnob = {
  id: 'safeknob',
  title: '保险柜旋钮',
  icon: '🔒',
  tier: (t) => t + 3,
  make(rng, cfg, tier) {
    const a = rng.range(1, 9) * 10 + rng.range(0, 9);
    const b = rng.range(1, 9) * 10 + rng.range(0, 9);
    const lastDigit = serialLastDigit(cfg.serial);
    // 第三条密码由前两条与炸弹信息算出
    const cThird = (a + b + lastDigit) % 10 === 0 ? 10 + (a % 9) : (a + b + lastDigit) % 90 + 10;
    const first = hasVowel(cfg.serial) ? a : b;
    const second = hasVowel(cfg.serial) ? b : a;
    const third = cThird;
    const answer = [first, second, third];
    return {
      state: { dial: 0, entered: [], hint: '转动旋钮选数字，按「确认」输入一位' },
      rules: {
        groups: [
          { title: '保险柜要按顺序输入三个两位数。', kind: 'note', visibility: 'full' },
          {
            title: '密码推算',
            kind: 'table',
            visibility: 'partial',
            head: ['线索', '结论'],
            rows: [
              { label: '旋钮上的两个刻度', action: `第一个刻度 ${a}，第二个刻度 ${b}` },
              { label: '第一位', action: hasVowel(cfg.serial) ? `序列号含元音 → 取 ${a}` : `序列号不含元音 → 取 ${b}` },
              { label: '第二位', action: hasVowel(cfg.serial) ? `序列号含元音 → 取 ${b}` : `序列号不含元音 → 取 ${a}` },
              { label: '第三位', action: `前两位之和 + 序列号末位（${lastDigit}），超过 90 就减 90，再取两位数` },
              { label: '第三位的算法', action: `(${first} + ${second} + ${lastDigit}) 落在 10~99 之间，即 ${third}` },
            ],
          },
          { title: '输入顺序必须正确，输错一位整个密码会重置。', kind: 'note', visibility: 'full' },
        ],
      },
      solution: { answer },
      asks: ['旋钮上的两个刻度', '序列号是否含元音', '序列号末位是几'],
      reset: true,
    };
  },
  apply(mod, action) {
    if (action.type === 'setDial') {
      mod.state.dial = Math.max(0, Math.min(99, Number(action.value) | 0));
      return { note: `旋钮停在 ${String(mod.state.dial).padStart(2, '0')}` };
    }
    if (action.type === 'confirm') {
      const want = mod.solution.answer;
      const idx = mod.state.entered.length;
      if (idx >= want.length) return { error: '三位已经输完了' };
      const got = Number(action.value !== undefined ? action.value : mod.state.dial);
      mod.state.entered.push(got);
      if (got !== want[idx]) {
        mod.state.entered = [];
        return { strike: true, reset: true, note: `第 ${idx + 1} 位输入 ${got} —— 错误，密码重置` };
      }
      if (mod.state.entered.length === want.length) return { solved: true, note: '三位密码全部正确，保险柜打开' };
      return { note: `第 ${idx + 1} 位 ${got} 正确（${mod.state.entered.length}/3）` };
    }
    return { error: '不支持的操作' };
  },
  resetState(mod) { mod.state.entered = []; mod.state.dial = 0; },
};

// ===========================================================================
// 字母键盘 — 手册给出一串字母，按顺序敲进去
// ===========================================================================
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const SAFE_WORDS = ['OPEN', 'LOCK', 'SAFE', 'CODE', 'BOMB', 'WIRE', 'FUSE', 'VAULT', 'ALARM', 'RELAY'];

export const letterPad = {
  id: 'letterpad',
  title: '字母键盘',
  icon: '🔠',
  tier: (t) => t + 4,
  make(rng, cfg, tier) {
    const word = rng.pick(SAFE_WORDS);
    // 手册给的是"移位后的单词"：每位按规则前移/后移，玩家按手册还原
    const shift = rng.range(1, 4);
    const shifted = word.split('').map((ch) => {
      const i = ALPHABET.indexOf(ch);
      return ALPHABET[(i + shift + 26) % 26];
    }).join('');
    const collected = word.split('').map((ch, i) => ({
      pos: i,
      shown: shifted[i],
      answer: ch,
      options: rng.shuffle(ALPHABET.filter((c) => c !== ch)).slice(0, 2).concat(ch).sort(),
    }));
    return {
      state: {
        text: shifted,
        picked: [],
        options: collected.map((c) => c.options),
      },
      rules: {
        groups: [
          { title: '面板上显示一串字母（已经按规则移过位）。把它还原成真正的口令，再一个字母一个字母敲进去。', kind: 'note', visibility: 'full' },
          {
            title: '还原规则',
            kind: 'table',
            visibility: 'partial',
            head: ['线索', '结论'],
            rows: [
              { label: '移位量', action: `每个字母往前（字母表顺序减小）挪 ${shift} 位` },
              { label: '示例', action: `例如 ${shifted[0]} 往前 ${shift} 位就是 ${word[0]}` },
              ...(tier >= 5 ? [{ label: '额外检查', action: '若序列号含元音字母，移位量再加 1' }] : []),
            ],
          },
          { title: '敲错一个字母，整串会清空重来。', kind: 'note', visibility: 'full' },
        ],
      },
      solution: { word },
      asks: ['面板上的那串字母', '序列号是否含元音'],
      reset: true,
    };
  },
  apply(mod, action) {
    if (action.type !== 'tapLetter' && action.type !== 'tap') return { error: '不支持的操作' };
    const ch = String(action.letter || action.value || '').toUpperCase();
    if (!/^[A-Z]$/.test(ch)) return { error: '请点一个字母' };
    const want = mod.solution.word[mod.state.picked.length];
    mod.state.picked.push(ch);
    if (ch !== want) return { strike: true, reset: true, note: `敲了 ${ch} —— 错误，整串清空` };
    if (mod.state.picked.length === mod.solution.word.length) return { solved: true, note: '口令输入正确' };
    return { note: `第 ${mod.state.picked.length} 个字母 ${ch} 正确` };
  },
  resetState(mod) { mod.state.picked = []; },
};

// ===========================================================================
// 双序列闪光 — 两段序列，各用一张表
// ===========================================================================
const DUO_COLORS = ['red', 'blue', 'green', 'yellow', 'white'];

export const simonDuo = {
  id: 'simon2',
  title: '双序列闪光',
  icon: '🎇',
  tier: (t) => t + 3,
  make(rng, cfg, tier) {
    const lenA = tier >= 5 ? 4 : 3;
    const lenB = tier >= 5 ? 3 : 2;
    const seqA = Array.from({ length: lenA }, () => rng.pick(DUO_COLORS));
    const seqB = Array.from({ length: lenB }, () => rng.pick(DUO_COLORS));
    const mapA = {};
    const mapB = {};
    for (const c of DUO_COLORS) {
      mapA[c] = rng.pick(DUO_COLORS.filter((x) => x !== c));
      mapB[c] = rng.pick(DUO_COLORS.filter((x) => x !== c));
    }
    const answerA = seqA.map((c) => mapA[c]);
    const answerB = seqB.map((c) => mapB[c]);
    return {
      state: {
        buttons: rng.shuffle(DUO_COLORS),
        playA: seqA,
        playB: seqB,
        phase: 'A',
        expected: 0,
        note: '先闪第一段（较慢），停一下再闪第二段（较快）',
      },
      rules: {
        groups: [
          { title: '模块会闪两段序列：第一段较慢，第二段较快。第一段按「表 A」换算，第二段按「表 B」换算，全部按对才算拆除。', kind: 'note', visibility: 'full' },
          { title: '表 A（第一段）', kind: 'table', visibility: 'partial', head: ['闪的颜色', '要按的按钮'], rows: DUO_COLORS.map((c) => ({ label: `${cn(c)}光`, action: `按${cn(mapA[c])}` })) },
          { title: '表 B（第二段）', kind: 'table', visibility: 'partial', head: ['闪的颜色', '要按的按钮'], rows: DUO_COLORS.map((c) => ({ label: `${cn(c)}光`, action: `按${cn(mapB[c])}` })) },
          { title: '在第二段结束前按完第一段；按错会从第一段重新开始。', kind: 'note', visibility: 'full' },
        ],
      },
      solution: { seqA, seqB, answerA, answerB },
      asks: ['第一段闪了哪些颜色', '第二段闪了哪些颜色'],
      reset: false,
    };
  },
  apply(mod, action) {
    if (action.type !== 'pressColor') return { error: '不支持的操作' };
    const { answerA, answerB } = mod.solution;
    const phase = mod.state.expected < answerA.length ? 'A' : 'B';
    const want = phase === 'A' ? answerA[mod.state.expected] : answerB[mod.state.expected - answerA.length];
    if (action.color !== want) {
      mod.state.expected = 0;
      return { strike: true, note: `按了${cn(action.color)} —— 错误，${phase === 'A' ? '第一' : '第二'}段第 ${(phase === 'A' ? mod.state.expected : mod.state.expected - answerA.length) + 1} 下应该按${cn(want)}，从第一段重新开始` };
    }
    mod.state.expected++;
    const total = answerA.length + answerB.length;
    if (mod.state.expected >= total) return { solved: true, note: '两段序列全部按对，模块解除' };
    if (mod.state.expected === answerA.length) return { note: `第一段完成，进入第二段（${mod.state.expected}/${total}）` };
    return { note: `按${cn(action.color)} —— 正确（${mod.state.expected}/${total}）` };
  },
  resetState(mod) { mod.state.expected = 0; },
};

export const EXTRA_MODULES = { complexWires, capacitor, safeKnob, letterPad, simonDuo };
