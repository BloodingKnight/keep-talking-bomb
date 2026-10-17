// Defuser-side bomb view: renders each module's interactive widget.
// The client never receives the answer (solutions live on the server), so
// everything here is presentation + input only.

import { el, clear, COLOR_CSS, COLOR_NAME, fmtClock } from './dom.js';

export function renderBomb(main, ctx) {
  const { state, act } = ctx;
  clear(main);
  const bomb = state.bomb || {};
  const modules = (bomb.moduleStates || []).filter((m) => m.state);
  const solvedCount = (bomb.moduleStates || []).filter((m) => m.status === 'solved').length;
  const blind = state.you?.vision === 'blind';
  // 盲操猴：走单独的渲染路径 —— 语义文字根本不会生成，而不是靠 CSS 藏起来
  if (blind) return renderBlindBomb(main, ctx, modules);

  // 炸弹外壳：螺丝 + 顶部计时器/失误灯 + 序列号铭牌 + 模块仓
  const casing = el('div', { class: 'casing-shell' + (blind ? ' vision-blind' : '') });
  casing.append(el('span', { class: 'screw tl' }), el('span', { class: 'screw tr' }),
    el('span', { class: 'screw bl' }), el('span', { class: 'screw br' }));

  const timerEl = el('span', { class: 'plate-timer', dataset: { role: 'timer' }, text: state.remainingMs !== undefined ? fmtClock(state.remainingMs) : '--:--' });
  const ledRow = el('span', { class: 'plate-leds' }, Array.from({ length: state.maxStrikes || 0 }, (_, i) =>
    el('span', { class: 'plate-led' + (i < (state.strikes || 0) ? ' on' : '') })));
  casing.append(el('div', { class: 'bomb-plate' }, [
      el('div', { class: 'plate-item' }, [
        el('span', { class: 'plate-label', text: '模块' }),
        el('span', { class: 'plate-value', text: `${solvedCount}/${bomb.moduleCount ?? '?'}` }),
      ]),
      el('div', { class: 'plate-item wide' }, [
        el('span', { class: 'plate-label', text: '剩余时间' }),
        timerEl,
      ]),
    el('div', { class: 'plate-item' }, [
      el('span', { class: 'plate-label', text: '失误' }),
      ledRow,
    ]),
  ]));

  const grid = el('div', { class: 'modules bomb-bays' });
  for (const mod of modules) grid.append(renderModule(mod, ctx));
  casing.append(grid);
  casing.append(el('div', { class: 'bomb-foot' }, [
    el('span', { class: 'muted small', text: '把模块上看到的一切念给专家听 —— 颜色、顺序、数字、闪烁的节奏、按钮上的字。' }),
  ]));
  main.append(casing);
}

/**
 * 单独渲染一个模块（给房主的"模块测试台"用）：交互仍然走服务端，
 * 只是把它放在一个独立卡片里，旁边就是同一道题的手册。
 */
export function renderPreviewModule(mod, sendAction, opts = {}) {
  const ctx = { act: (uid, action) => sendAction(uid, action), benchMs: opts.benchMs || 0, blind: !!opts.blind };
  if (ctx.blind) return renderBlindModule({ ...mod, status: 'active' }, ctx);
  return renderModule({ ...mod, status: 'active' }, ctx);
}

/** 单个模块的"盲操版"：只有轮廓，没有任何文字/数字/颜色。 */
function renderBlindModule(mod, ctx) {
  const wrap = el('div', { class: 'module blind-module' + (mod.status === 'solved' ? ' solved' : ''), dataset: { uid: mod.uid } });
  wrap.append(el('div', { class: 'mod-head blind' }, [el('span', { class: 'mh-icon', text: mod.icon })]));
  const body = el('div', { class: 'mod-body blind-body' });
  body.append(blindSilhouette(mod, (action) => ctx.act(mod.uid, action)));
  wrap.append(body);
  return wrap;
}

/**
 * 盲操猴的整屏渲染：只生成形状 + 计时器。
 * 这里**不会**调用任何语义控件（renderWires 之类），所以 DOM 里根本没有
 * 颜色/数字/文字 —— 不是"用 CSS 藏起来"，而是压根不存在。
 */
function renderBlindBomb(main, ctx, modules) {
  const state = ctx.state;
  const casing = el('div', { class: 'casing-shell vision-blind' });
  casing.append(el('span', { class: 'screw tl' }), el('span', { class: 'screw tr' }),
    el('span', { class: 'screw bl' }), el('span', { class: 'screw br' }));

  // 只剩两根"灯条"：上面是倒计时，下面是失误灯（队友需要这些做规则判断）
  casing.append(el('div', { class: 'bomb-plate plate-blind' }, [
    el('div', { class: 'plate-item wide' }, [
      el('span', { class: 'plate-timer', dataset: { role: 'timer' }, text: state.remainingMs !== undefined ? fmtClock(state.remainingMs) : '--:--' }),
    ]),
    el('div', { class: 'plate-item' }, [
      el('span', { class: 'plate-leds' }, Array.from({ length: state.maxStrikes || 0 }, (_, i) =>
        el('span', { class: 'plate-led' + (i < (state.strikes || 0) ? ' on' : '') }))),
    ]),
  ]));

  const grid = el('div', { class: 'modules bomb-bays' });
  for (const mod of modules) {
    const wrap = el('div', { class: 'module blind-module' + (mod.status === 'solved' ? ' solved' : ''), dataset: { uid: mod.uid } });
    // 只放一个模块图标（用来分辨"第几个模块"），不放标题/等级
    wrap.append(el('div', { class: 'mod-head blind' }, [el('span', { class: 'mh-icon', text: mod.icon })]));
    const body = el('div', { class: 'mod-body blind-body' });
    body.append(blindSilhouette(mod, mod.status === 'solved' ? () => {} : (action) => ctx.act(mod.uid, action)));
    wrap.append(body);
    grid.append(wrap);
  }
  casing.append(grid);
  // 把光标位置报给服务端，让"看得见"的队友知道他在点哪里
  trackBlindCursor(grid, ctx);
  casing.append(el('div', { class: 'blind-hint' }, [
    el('span', { text: '🙈 盲操模式：只有白色轮廓，看不见颜色/数字/文字。点上会有白色高亮反馈。' }),
  ]));
  main.append(casing);
}

/** 盲操猴的光标追踪：节流上报给服务端（队友的屏幕上会出现一个圆点）。 */
function trackBlindCursor(grid, ctx) {
  let last = 0;
  let pending = null;
  const send = () => {
    if (!pending) return;
    last = Date.now();
    ctx.act('', { type: 'cursor', ...pending });
    pending = null;
  };
  grid.addEventListener('pointermove', (ev) => {
    const box = typeof grid.getBoundingClientRect === 'function' ? grid.getBoundingClientRect() : null;
    if (!box || !box.width || !box.height) return;
    // 找出光标落在哪个模块卡片上，坐标按卡片内部归一化
    const cards = grid.children || [];
    let target = null;
    for (const card of cards) {
      const r = typeof card.getBoundingClientRect === 'function' ? card.getBoundingClientRect() : null;
      if (r && ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom) { target = { card, r }; break; }
    }
    if (!target) return;
    pending = {
      uid: target.card.dataset ? target.card.dataset.uid : '',
      x: (ev.clientX - target.r.left) / target.r.width,
      y: (ev.clientY - target.r.top) / target.r.height,
    };
    if (Date.now() - last > 150) send();
    else setTimeout(send, 150);
  });
  grid.addEventListener('pointerleave', () => { pending = null; });
}

/**
 * 盲操猴的"轮廓层"：按模块类型画出形状（几条线、几个方块、几个圆），
 * 但不写任何文字、数字、颜色 —— 他只是"摸得到"，看不清。
 * 这一层是绝对定位的盖板，下面的真实控件仍然接收点击（所以还能操作）。
 */
function blindSilhouette(mod, onAction) {
  const layer = el('div', { class: 'blind-outline' });
  const st = mod.state || {};
  const bar = (cls = '') => el('div', { class: 'bo-bar ' + cls });
  const box = (cls = '') => el('div', { class: 'bo-box ' + cls });
  const grid = (n, cls) => el('div', { class: 'bo-grid ' + cls }, Array.from({ length: n }, () => box()));
  switch (mod.id) {
    case 'wires': layer.append(...(st.wires || []).map(() => bar('line'))); break;
    case 'wires2': layer.append(...(st.wires || []).map(() => bar('line'))); break;
    case 'button': layer.append(el('div', { class: 'bo-center' }, [box('big')])); break;
    case 'keypad': layer.append(grid((st.slots || []).length || 6, 'k3')); break;
    case 'simon': layer.append(grid((st.buttons || []).length || 4, 'k2')); break;
    case 'simon2': layer.append(grid((st.buttons || []).length || 5, 'k3')); break;
    case 'memory': layer.append(el('div', { class: 'bo-display' }), grid(4, 'k4')); break;
    case 'morse': layer.append(el('div', { class: 'bo-display' }), el('div', { class: 'bo-grid k2' }, [box(), box()])); break;
    case 'signal': layer.append(el('div', { class: 'bo-grid k3' }, [box(), box(), box()]), el('div', { class: 'bo-grid k2' }, [box(), box()])); break;
    case 'maze': layer.append(el('div', { class: 'bo-center' }, [box('grid')])); break;
    case 'password': layer.append(grid(5, 'k5')); break;
    case 'quiz': layer.append(grid(Math.min((st.options || []).length || 4, 4), 'k1')); break;
    case 'gears': layer.append(el('div', { class: 'bo-row' }, Array.from({ length: (st.gears || []).length || 3 }, () => el('div', { class: 'bo-circle' })))); break;
    case 'balance': layer.append(el('div', { class: 'bo-grid k2' }, [box('tall'), box('tall')])); break;
    case 'decoder': layer.append(el('div', { class: 'bo-display' }), el('div', { class: 'bo-grid k5' }, Array.from({ length: 10 }, () => box()))); break;
    case 'capacitor': layer.append(el('div', { class: 'bo-bar wide' })); break;
    case 'safeknob': layer.append(el('div', { class: 'bo-center' }, [el('div', { class: 'bo-circle big' })])); break;
    case 'letterpad': layer.append(el('div', { class: 'bo-display' }), el('div', { class: 'bo-grid k7' }, Array.from({ length: 21 }, () => box()))); break;
    default: layer.append(el('div', { class: 'bo-center' }, [box('big')]));
  }
  if (onAction) bindBlindActions(mod, layer, onAction);
  return layer;
}

/** 剪影层上的点击 → 模块动作（盲操靠形状的"位置"来操作）。 */
function bindBlindActions(mod, layer, send) {
  const st = mod.state || {};
  const nodes = layer.querySelectorAll ? layer.querySelectorAll('.bo-box, .bo-bar, .bo-circle') : [];
  const list = nodes.length ? [...nodes] : layer.descendants().filter((n) => /bo-(box|bar|circle)/.test(n.className));
  const flash = (n) => { n.classList.add('hit'); setTimeout(() => n.classList.remove('hit'), 260); };
  list.forEach((n, i) => {
    n.classList.add('clickable');
    n.addEventListener('click', () => {
      flash(n);
      switch (mod.id) {
        case 'wires':
        case 'wires2': send({ type: 'cut', index: i }); break;
        case 'button': send({ type: 'press' }); break;
        case 'keypad': send({ type: 'tap', symbol: (st.slots || [])[i] }); break;
        case 'simon':
        case 'simon2': send({ type: 'pressColor', color: (st.buttons || [])[i] }); break;
        case 'memory': send({ type: 'tap', pos: i + 1 }); break;
        case 'morse':
        case 'signal': send({ type: 'tapKey', mark: i === 0 ? 'dot' : 'dash' }); break;
        case 'maze': send({ type: 'move', dir: ['up', 'right', 'down', 'left'][i] || 'up' }); break;
        case 'password': send({ type: 'cycle', index: i, dir: 1 }); break;
        case 'quiz': send({ type: 'choose', index: i }); break;
        case 'gears': send({ type: 'choose', dir: i === 0 ? 'cw' : 'ccw' }); break;
        case 'balance': send({ type: 'add', side: i === 0 ? 0 : 1 }); break;
        case 'decoder': send({ type: 'digit', digit: String(i === 9 ? 0 : i + 1) }); break;
        case 'capacitor': send({ type: 'pull', t: 0 }); break;
        case 'safeknob': send({ type: 'confirm' }); break;
        case 'letterpad': send({ type: 'tapLetter', letter: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[i] || 'A' }); break;
        default: break;
      }
    });
  });
  // 需要"发送/提交"的模块，再给一个不写字的方块当提交键
  if (['morse', 'signal', 'decoder', 'safeknob', 'password', 'balance'].includes(mod.id)) {
    const submit = el('div', { class: 'bo-box submit clickable', title: '' });
    submit.addEventListener('click', () => {
      flash(submit);
      if (mod.id === 'morse' || mod.id === 'signal') send({ type: 'sendLetter', marks: st.entered || [] });
      else if (mod.id === 'decoder') send({ type: 'submit' });
      else if (mod.id === 'safeknob') send({ type: 'confirm' });
      else send({ type: 'submit' });
    });
    layer.append(submit);
  }
}

function renderModule(mod, ctx) {
  const wrap = el('div', { class: 'module' + (mod.status === 'solved' ? ' solved' : ''), dataset: { uid: mod.uid } });
  wrap.append(el('div', { class: 'mod-head' }, [
    el('span', { class: 'mh-icon', text: mod.icon }),
    el('span', { class: 'mh-title', text: mod.title }),
    el('span', { class: 'tier', text: `等级 ${mod.tier}` }),
  ]));

  const body = el('div', { class: 'mod-body' });
  wrap.append(body);
  const solved = mod.status === 'solved';
  const send = (action) => { if (!solved) ctx.act(mod.uid, action); };

  switch (mod.id) {
    case 'wires': renderWires(body, mod, send); break;
    case 'button': renderButton(body, mod, send, ctx); break;
    case 'keypad': renderKeypad(body, mod, send); break;
    case 'simon': renderSimon(body, mod, send); break;
    case 'memory': renderMemory(body, mod, send); break;
    case 'morse': renderMorse(body, mod, send); break;
    case 'maze': renderMaze(body, mod, send); break;
    case 'password': renderPassword(body, mod, send); break;
    case 'quiz': renderQuiz(body, mod, send); break;
    case 'gears': renderGears(body, mod, send); break;
    case 'balance': renderBalance(body, mod, send); break;
    case 'decoder': renderDecoder(body, mod, send); break;
    case 'signal': renderSignal(body, mod, send); break;
    case 'wires2': renderComplexWires(body, mod, send); break;
    case 'capacitor': renderCapacitor(body, mod, send); break;
    case 'safeknob': renderSafeKnob(body, mod, send); break;
    case 'letterpad': renderLetterPad(body, mod, send); break;
    case 'simon2': renderSimonDuo(body, mod, send); break;
    default: body.append(el('div', { class: 'muted', text: `未知模块：${mod.id}` }));
  }

  if (mod.note) wrap.append(el('div', { class: 'mod-note', text: mod.note }));
  return wrap;
}

// --------------------------------------------------------------------- wires
function renderWires(body, mod, send) {
  const list = el('div', { class: 'wires' });
  for (const w of mod.state.wires) {
    const wire = el('div', {
      class: 'wire' + (w.cut ? ' cut' : ''),
      style: { background: COLOR_CSS[w.color] },
      onClick: () => send({ type: 'cut', index: w.i }),
    }, [
      el('span', { class: 'wnum', text: `第 ${w.i + 1} 根 · ${COLOR_NAME[w.color]}` }),
      w.striped ? el('span', { class: 'stripes' }) : null,
    ]);
    if (w.striped) wire.append(el('span', { class: 'wnum', style: { marginLeft: 'auto', zIndex: 2 }, text: '有条纹' }));
    list.append(wire);
  }
  body.append(list);
  body.append(el('div', { class: 'muted small', style: { marginTop: '8px' }, text: '点一下线缆 = 剪断它。剪错会立刻记一次失误。' }));
}

// -------------------------------------------------------------------- button
function renderButton(body, mod, send, ctx) {
  const st = mod.state;
  let holdTimer = null;

  const btn = el('button', {
    class: 'big-button' + (st.holding ? ' holding' : ''),
    style: { background: COLOR_CSS[st.color] },
    text: st.label,
  });
  const strip = el('div', { class: 'strip-bar' });

  // 测试台里没有真炸弹，所以给一个"假计时器"跑起来，让松手时机也能验。
  const benchMs = ctx && ctx.benchMs ? ctx.benchMs : 0;
  const benchDeadline = benchMs ? Date.now() + benchMs : 0;
  let readout = null;
  if (benchMs) {
    readout = el('div', { class: 'bench-timer', text: '0:00' });
    const paint = () => {
      const left = Math.max(0, benchDeadline - Date.now());
      const total = Math.ceil(left / 1000);
      readout.textContent = `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
      if (left <= 0) return;
      requestAnimationFrame(() => setTimeout(paint, 100));
    };
    paint();
  }

  const paintStrip = () => {
    const c = st.strip;
    if (!c) { strip.textContent = '（按住按钮后，这里会显示光条颜色）'; strip.style.background = '#0d131b'; strip.style.color = ''; return; }
    const css = c === 'other' ? '#9ca3af' : COLOR_CSS[c];
    strip.textContent = `光条：${c === 'other' ? '其他颜色' : COLOR_NAME[c]}`;
    strip.style.background = css;
    strip.style.color = 'rgba(0,0,0,.7)';
    strip.style.fontWeight = '700';
  };

  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    btn.dataset.down = '1';
    btn.dataset.t0 = String(Date.now());
    if (st.holding) { send({ type: 'release', benchMs: remainingOf(benchDeadline) }); return; }
    send({ type: 'press' });
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => { send({ type: 'strip' }); }, 300);
  });
  const up = () => {
    if (!btn.dataset.down) return;
    btn.dataset.down = '';
    clearTimeout(holdTimer);
    const held = Date.now() - Number(btn.dataset.t0 || 0);
    setTimeout(() => send({ type: 'release', benchMs: remainingOf(benchDeadline) }), Math.max(0, 220 - held));
  };
  btn.addEventListener('pointerup', up);
  btn.addEventListener('pointerleave', () => { if (btn.dataset.down) up(); });

  body.append(btn, strip);
  if (readout) {
    body.append(el('div', { class: 'bench-timer-row' }, [
      el('span', { class: 'muted small', text: '测试计时器（只有测试台有）' }),
      readout,
    ]));
  }
  body.append(el('div', { class: 'muted small', style: { marginTop: '8px' }, text: '按下 / 按住这个按钮。松开时机由专家查表决定。' }));
  paintStrip();
}

function remainingOf(deadline) {
  return deadline ? Math.max(0, deadline - Date.now()) : undefined;
}

// -------------------------------------------------------------------- keypad
function renderKeypad(body, mod, send) {
  const st = mod.state;
  const grid = el('div', { class: 'keypad' });
  for (const sym of st.slots) {
    const pressed = (st.pressed || []).includes(sym);
    grid.append(el('div', {
      class: 'k' + (pressed ? ' pressed' : ''),
      text: sym,
      title: '按一下',
      onClick: () => send({ type: 'tap', symbol: sym }),
    }));
  }
  body.append(grid);
  body.append(el('div', { class: 'muted small', style: { marginTop: '8px' }, text: `已按 ${(st.pressed || []).length}/4 个符号。按错顺序会重置。` }));
}

// --------------------------------------------------------------------- simon
//
// 动画时钟存在 animClocks 里：key 只跟"序列内容 + 已按对几个"有关，
// 所以服务端每秒的心跳重绘不会把正在播放的闪烁打断。
const animClocks = new Map();

function animClock(key, durationMs, restart = false) {
  const now = Date.now();
  const cur = animClocks.get(key);
  if (!cur || restart || now - cur > durationMs * 12) {
    animClocks.set(key, now);
    return now;
  }
  return cur;
}

/** 把一轮闪烁排成时间轴（毫秒）。纯函数，方便测试。 */
export function buildFlashTimeline(sequence, opts = {}) {
  const lead = opts.lead ?? 700;
  const on = opts.on ?? 420;
  const gap = opts.gap ?? 240;
  const tail = opts.tail ?? 1800;
  const marks = sequence.map((color, i) => {
    const start = lead + i * (on + gap);
    return { color, start, end: start + on, index: i };
  });
  const last = marks.length ? marks[marks.length - 1].end : lead;
  return { marks, lead, on, gap, tail, total: last + tail };
}

/** 给定已经过的时间，返回当前亮起的闪烁下标（没有则 -1）。 */
export function flashStateAt(timeline, elapsed) {
  const m = timeline.marks.find((x) => elapsed >= x.start && elapsed < x.end);
  return m ? m.index : -1;
}

function renderSimon(body, mod, send) {
  const st = mod.state;
  const order = st.buttons;
  const grid = el('div', { class: 'simon' });
  const nodes = {};
  for (const c of order) {
    const node = el('div', {
      class: 's', style: { background: COLOR_CSS[c], color: 'rgba(0,0,0,.7)' },
      text: COLOR_NAME[c],
      onClick: () => send({ type: 'pressColor', color: c }),
    });
    nodes[c] = node;
    grid.append(node);
  }
  body.append(grid);
  const status = el('div', { class: 'muted small', style: { marginTop: '8px' } });
  body.append(status);
  body.append(el('div', { class: 'muted small', text: '看它依次闪哪几个颜色，按手册换算成要按的按钮颜色，再按回去。' }));

  // 要闪的颜色序列（不是答案表，答案表只在专家手册里）
  const playSeq = st.playSeq || [];
  const timeline = buildFlashTimeline(playSeq);
  const total = playSeq.length;
  // 动画时钟只跟"要闪什么"绑定：按对/按错都不重排，否则玩家只会反复看到前两下
  const key = `simon:${mod.uid}:${playSeq.join('')}`;
  const t0 = animClock(key, timeline.total, false);

  let raf = 0;
  let alive = true;
  let everAttached = false;
  const tick = () => {
    if (!alive) return;
    // 注意：renderBomb 是先把 body 交给模块、再把 body 挂到卡片上，
    // 所以第一帧可能"还没接上 DOM"。这里只检查"已经挂上过、后来又被移除"。
    if (everAttached && !document.body.contains(grid)) { alive = false; return; }
    if (!everAttached && document.body.contains(grid)) everAttached = true;
    const cycle = (Date.now() - t0) % timeline.total;
    const idx = flashStateAt(timeline, cycle);
    for (const c of order) nodes[c].classList.remove('lit');
    const done = st.expected || 0;
    if (idx >= 0) {
      nodes[timeline.marks[idx].color].classList.add('lit');
      status.textContent = `▶ 正在闪烁 第 ${idx + 1}/${total} 下 · 已按对 ${done}/${total}`;
    } else if (cycle < timeline.lead) {
      status.textContent = `准备重播… ${((timeline.lead - cycle) / 1000).toFixed(1)}s（已按对 ${done}/${total}）`;
    } else {
      status.textContent = `本轮闪完，马上从头重播 · 已按对 ${done}/${total}`;
    }
    raf = requestAnimationFrame(tick);
  };
  // 延到下一帧再开播，避免"渲染过程中还没挂 DOM"被误判成已移除
  raf = requestAnimationFrame(tick);
  const stopCheck = setInterval(() => {
    if (!alive) { clearInterval(stopCheck); return; }
    if (document.body.contains(grid)) everAttached = true;
    else if (everAttached) { alive = false; cancelAnimationFrame(raf); clearInterval(stopCheck); }
  }, 1500);
}

// -------------------------------------------------------------------- memory
function renderMemory(body, mod, send) {
  const st = mod.state;
  body.append(el('div', { class: 'mem-display', text: String(st.display) }));
  const row = el('div', { class: 'mem-buttons' });
  st.buttons.forEach((label, i) => {
    row.append(el('button', { text: String(label), onClick: () => send({ type: 'tap', pos: i + 1 }) }));
  });
  body.append(row);
  body.append(el('div', { class: 'muted small', style: { marginTop: '8px' }, text: `第 ${st.stage + 1}/5 阶段。按错会让阶段回到 1。` }));
}

// --------------------------------------------------------------------- morse
/**
 * 电报机（摩斯 / 三色电报共用）：
 * 拆弹者看到目标单词，专家把字母翻成点横（和灯带颜色）念给他，他敲进去发报。
 */
function telegraph(body, mod, send, opts = {}) {
  const st = mod.state;
  const word = (st.words && st.words[st.index] && st.words[st.index].word) || '?';
  const total = st.total || 1;
  const withColor = !!opts.withColor;

  // 目标单词：拆弹者唯一"看得见"的文字信息
  const target = el('div', { class: 'tele-target' }, [
    el('span', { class: 'tele-label', text: withColor ? '要发报的单词' : '要发报的单词' }),
    el('span', { class: 'tele-word', text: word }),
    total > 1 ? el('span', { class: 'muted small', text: `（第 ${st.index + 1}/${total} 个）` }) : null,
  ]);
  body.append(target);

  if (withColor) {
    const rows = el('div', { class: 'signal-channels' });
    for (const strip of st.strips || []) rows.append(el('span', { class: 'sig-ch' }, [el('span', { text: `${strip.ch}灯` })]));
    body.append(rows);
  }

  // 已敲入的点横
  const tape = el('div', { class: 'tele-tape' });
  const paintTape = () => {
    clear(tape);
    const marks = st.entered || [];
    if (!marks.length) tape.append(el('span', { class: 'muted small', text: '（还没敲，点下面的 · / — 键盘）' }));
    for (const m of marks) tape.append(el('span', { class: 'tele-mark', text: (m === 'dash' || m === '-') ? '—' : '·' }));
    const sent = st.sentCount || 0;
    if (sent) tape.append(el('span', { class: 'muted small', style: { marginLeft: '8px' }, text: `已发报 ${sent} 个字母` }));
  };
  body.append(el('div', { class: 'tele-row' }, [
    el('span', { class: 'muted small', text: '当前这一串：' }),
    tape,
  ]));
  paintTape();

  const keyRow = el('div', { class: 'telegraph' });
  keyRow.append(el('button', { class: 'tele-key dot', text: '·  点', onClick: () => send({ type: 'tapKey', mark: 'dot' }) }));
  keyRow.append(el('button', { class: 'tele-key dash', text: '—  横', onClick: () => send({ type: 'tapKey', mark: 'dash' }) }));
  body.append(keyRow);

  body.append(el('div', { class: 'tele-row' }, [
    el('button', { class: 'small', text: '清空这一串', onClick: () => send({ type: 'clearKey' }) }),
    el('button', { class: 'primary', text: '发送这个字母', onClick: () => send({ type: 'sendLetter', marks: st.entered || [] }) }),
    total > 1 ? el('button', { class: 'small ghost', text: '换一个单词', onClick: () => send({ type: 'skipWord' }) }) : null,
  ]));

  body.append(el('div', { class: 'muted small', text: withColor
    ? '把单词念给专家；他按手册告诉你"第几个字母、哪条灯带、点横是什么"，你选灯带、敲电码、发送。'
    : '把单词念给专家；他把每个字母翻成点横（一个字母一串）念给你，你敲进去、逐个发送。' }));
  if (withColor) {
    body.append(el('div', { class: 'tele-hint muted small', text: '灯带按红→黄→蓝循环对应第 1、2、3…个字母（回合制：发送时按住对应灯带更直观，这里用颜色提示）。' }));
  }
}
function renderMorse(body, mod, send) {
  telegraph(body, mod, send, { withColor: false });
}

// ---------------------------------------------------------------------- maze
/** 把"相对终点的行列差"说成人话（只报大致方向，不报具体格数）。 */
export function mazeHint(relC, relR) {
  const ns = relR < 0 ? '北' : relR > 0 ? '南' : '';
  const ew = relC > 0 ? '东' : relC < 0 ? '西' : '';
  const name = (ns + ew) || '就在这一格';
  const row = relR === 0 ? '同一行' : relR < 0 ? `还要往上 ${Math.abs(relR)} 行` : `还要往下 ${relR} 行`;
  const col = relC === 0 ? '同一列' : relC < 0 ? `往左 ${Math.abs(relC)} 列` : `往右 ${relC} 列`;
  return { name, detail: `${row}、${col}` };
}

function renderMaze(body, mod, send) {
  const st = mod.state;
  body.append(el('div', { class: 'maze-pos', text: `光点：第 ${st.pos[1] + 1} 行 第 ${st.pos[0] + 1} 列 · 走了 ${st.moves} 步 · 终点在第 ${st.goal[1] + 1} 行 第 ${st.goal[0] + 1} 列` }));
  const hint = mazeHint(st.relC, st.relR);
  body.append(el('div', { class: 'maze-hint', text: `终点在：${hint.name}（${hint.detail}）` }));
  body.append(el('div', { class: 'muted small', text: '墙只有专家的手册上有 —— 把方向念给他，让他指路。' }));
  const dpad = el('div', { class: 'dpad' }, [
    el('button', { class: 'up', text: '↑', onClick: () => send({ type: 'move', dir: 'up' }) }),
    el('button', { class: 'left', text: '←', onClick: () => send({ type: 'move', dir: 'left' }) }),
    el('button', { class: 'down', text: '↓', onClick: () => send({ type: 'move', dir: 'down' }) }),
    el('button', { class: 'right', text: '→', onClick: () => send({ type: 'move', dir: 'right' }) }),
  ]);
  body.append(dpad);
}

// ------------------------------------------------------------------ password
function renderPassword(body, mod, send) {
  const st = mod.state;
  const row = el('div', { class: 'pw-slots' });
  st.slots.forEach((slot, i) => {
    row.append(el('div', { class: 'pw-slot' }, [
      el('button', { text: '▲', onClick: () => send({ type: 'cycle', index: i, dir: -1 }) }),
      el('div', { class: 'pw-letter', text: slot.letters[slot.pos] }),
      el('button', { text: '▼', onClick: () => send({ type: 'cycle', index: i, dir: 1 }) }),
    ]));
  });
  body.append(row);
  body.append(el('div', { class: 'row' }, [
    el('button', { class: 'primary', text: '提交', onClick: () => send({ type: 'submit' }) }),
  ]));
}

// ---------------------------------------------------------------------- quiz
function renderQuiz(body, mod, send) {
  const st = mod.state;
  body.append(el('div', { class: 'quiz-q', text: st.question }));
  const opts = el('div', { class: 'quiz-opts' });
  (st.options || []).forEach((o, i) => {
    opts.append(el('button', {
      class: st.pressed === i ? 'picked' : '',
      text: o,
      onClick: () => send({ type: 'choose', index: i }),
    }));
  });
  body.append(opts);
  body.append(el('div', { class: 'muted small', style: { marginTop: '8px' }, text: '答案要用专家那边的炸弹外壳信息来算。' }));
}

// --------------------------------------------------------------------- gears
function renderGears(body, mod, send) {
  const st = mod.state;
  const row = el('div', { class: 'gears' });
  st.gears.forEach((g, i) => {
    row.append(el('div', { class: 'gear' }, [
      el('div', { class: 'gear-disc', text: '⚙' }),
      el('div', { class: 'gear-teeth', text: `${g.teeth} 齿` }),
      el('div', { class: 'muted small', text: i === 0 ? '起点' : `第 ${i + 1} 个` }),
    ]));
  });
  body.append(row);
  body.append(el('div', { class: 'muted small', style: { marginTop: '8px' }, text: `${st.gears.length} 个齿轮互相咬合联动。第一个齿轮的转向写在下边 —— 把它念给专家。` }));
  body.append(el('div', { class: 'gear-start', text: `第一个齿轮：${st.startDir === 'cw' ? '顺时针 ↻' : '逆时针 ↺'}` }));
  body.append(el('div', { class: 'muted small', text: '你要决定的是最后一个齿轮的转向。' }));
  body.append(el('div', { class: 'row' }, [
    el('button', { class: 'primary', text: '最后一个是顺时针 ↻', onClick: () => send({ type: 'choose', dir: 'cw' }) }),
    el('button', { class: 'primary', text: '最后一个是逆时针 ↺', onClick: () => send({ type: 'choose', dir: 'ccw' }) }),
  ]));
}

// ------------------------------------------------------------------- balance
function renderBalance(body, mod, send) {
  const st = mod.state;
  const beam = el('div', { class: 'balance' });
  st.slots.forEach((slot, i) => {
    const arm = el('div', { class: 'bal-arm' + (slot.correct ? ' ok' : '') }, [
      el('div', { class: 'bal-weight', text: `${slot.weight} 单位` }),
      el('div', { class: 'muted small', text: `距支点 ${slot.dist} 格 · 已放 ${slot.filled}` }),
    ]);
    beam.append(arm);
  });
  body.append(beam);
  body.append(el('div', { class: 'muted small', style: { marginTop: '8px' }, text: `两侧力矩要相等才算平衡：重量 × 格数。目前 ${st.slots[0].filled * st.slots[0].weight * st.slots[0].dist} vs ${st.slots[1].filled * st.slots[1].weight * st.slots[1].dist}。` }));
  body.append(el('div', { class: 'row' }, [
    el('button', { text: '左边加一个', onClick: () => send({ type: 'add', side: 0 }) }),
    el('button', { text: '左边减一个', onClick: () => send({ type: 'remove', side: 0 }) }),
    el('button', { text: '右边加一个', onClick: () => send({ type: 'add', side: 1 }) }),
    el('button', { text: '右边减一个', onClick: () => send({ type: 'remove', side: 1 }) }),
  ]));
  body.append(el('div', { class: 'row' }, [
    el('button', { class: 'primary', text: '确认平衡', onClick: () => send({ type: 'submit' }) }),
  ]));
}

// ------------------------------------------------------------------- decoder
function renderDecoder(body, mod, send) {
  const st = mod.state;
  body.append(el('div', { class: 'decoder-cards' }, [
    el('div', { class: 'code-card', text: st.a }),
    el('div', { class: 'code-op', text: st.op }),
    el('div', { class: 'code-card', text: st.b }),
  ]));
  body.append(el('div', { class: 'muted small', text: `把结果用十进制填进去（当前输入：${st.input || '空'}）` }));
  const pad = el('div', { class: 'numpad' });
  for (const d of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']) {
    pad.append(el('button', { text: d, onClick: () => send({ type: 'digit', digit: d }) }));
  }
  body.append(pad);
  body.append(el('div', { class: 'row' }, [
    el('button', { text: '退格', onClick: () => send({ type: 'back' }) }),
    el('button', { class: 'primary', text: '提交', onClick: () => send({ type: 'submit' }) }),
  ]));
}

// -------------------------------------------------------------------- signal
function renderSignal(body, mod, send) {
  telegraph(body, mod, send, { withColor: true });
}

// ------------------------------------------------------------- 复杂线路
function renderComplexWires(body, mod, send) {
  const list = el('div', { class: 'wires' });
  for (const w of mod.state.wires) {
    list.append(el('div', {
      class: 'wire complex' + (w.cut ? ' cut' : ''),
      style: { background: COLOR_CSS[w.color] },
      onClick: () => send({ type: 'cut', index: w.i }),
    }, [
      el('span', { class: 'wnum', text: `第 ${w.i + 1} 根` }),
      w.striped ? el('span', { class: 'stripes' }) : null,
      el('span', { class: 'wire-tags' }, [
        w.star ? el('span', { class: 'tag star', text: '★' }) : null,
        el('span', { class: 'tag led' + (w.led ? ' on' : ''), text: 'LED' }),
        el('span', { class: 'tag code', text: w.code }),
      ]),
    ]));
  }
  body.append(list);
  body.append(el('div', { class: 'muted small', style: { marginTop: '8px' }, text: '每根线右侧的字母、★、LED 都要念给专家；他说剪哪根就点哪根。' }));
}

// ------------------------------------------------------------- 电容放电
function renderCapacitor(body, mod, send) {
  const st = mod.state;
  const period = st.period || 6;
  const bar = el('div', { class: 'cap-bar' }, [el('div', { class: 'cap-fill' })]);
  const fill = bar.firstChild;
  const clock = el('div', { class: 'cap-clock', text: '0.0s' });
  const ticks = el('div', { class: 'cap-ticks' }, Array.from({ length: 7 }, (_, i) => el('span', { class: 'cap-tick', text: String(i + 1) })));
  body.append(clock, bar, ticks);

  const t0 = Date.now();
  let alive = true;
  const tick = () => {
    if (!alive) return;
    if (!document.body.contains(bar)) { alive = false; return; }
    const elapsed = (Date.now() - t0) / 1000;
    const cycle = elapsed % period;
    if (fill.style) fill.style.width = `${Math.min(100, (cycle / period) * 100)}%`;
    clock.textContent = `本周期 ${cycle.toFixed(1)}s / 共 ${period}s（第 ${Math.floor(elapsed / period) + 1} 个周期）`;
    requestAnimationFrame(() => setTimeout(tick, 80));
  };
  requestAnimationFrame(() => setTimeout(tick, 80));

  body.append(el('div', { class: 'row' }, [
    el('button', {
      class: 'primary big',
      text: '拉下拉杆',
      onClick: () => send({ type: 'pull', t: Number(((Date.now() - t0) / 1000 % period).toFixed(2)) }),
    }),
  ]));
  body.append(el('div', { class: 'muted small', text: '把"指示灯现在亮到第几个刻度"念给专家，他告诉你第几秒拉；看着秒表读秒。' }));
}

// ------------------------------------------------------------- 保险柜旋钮
function renderSafeKnob(body, mod, send) {
  const st = mod.state;
  body.append(el('div', { class: 'safe-dial' }, [el('div', { class: 'safe-value', text: String(st.dial || 0).padStart(2, '0') })]));
  body.append(el('div', { class: 'safe-row' }, [
    el('button', { text: '−10', onClick: () => send({ type: 'setDial', value: Math.max(0, (st.dial || 0) - 10) }) }),
    el('button', { text: '−1', onClick: () => send({ type: 'setDial', value: Math.max(0, (st.dial || 0) - 1) }) }),
    el('button', { text: '+1', onClick: () => send({ type: 'setDial', value: Math.min(99, (st.dial || 0) + 1) }) }),
    el('button', { text: '+10', onClick: () => send({ type: 'setDial', value: Math.min(99, (st.dial || 0) + 10) }) }),
  ]));
  body.append(el('div', { class: 'safe-row' }, [
    el('button', { class: 'primary', text: '确认这一位', onClick: () => send({ type: 'confirm' }) }),
  ]));
  body.append(el('div', { class: 'safe-entered', text: `已输入：${(st.entered || []).join(' / ') || '（还没有）'}` }));
  body.append(el('div', { class: 'muted small', text: '三位密码要按专家算出来的顺序输入，错一位会重置。' }));
}

// ------------------------------------------------------------- 字母键盘
function renderLetterPad(body, mod, send) {
  const st = mod.state;
  body.append(el('div', { class: 'pad-display', text: st.text }));
  body.append(el('div', { class: 'pad-entered', text: `已敲入：${(st.picked || []).join('') || '（空）'}` }));
  const pad = el('div', { class: 'letter-pad' });
  for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')) {
    pad.append(el('button', { text: ch, onClick: () => send({ type: 'tapLetter', letter: ch }) }));
  }
  body.append(pad);
  body.append(el('div', { class: 'muted small', text: '面板上是"移位过的"字母串，专家按手册还原成口令，你再一个字母一个字母敲进去。' }));
}

// ------------------------------------------------------------- 双序列闪光
function renderSimonDuo(body, mod, send) {
  const st = mod.state;
  const order = st.buttons;
  const grid = el('div', { class: 'simon five' });
  const nodes = {};
  for (const c of order) {
    const node = el('div', {
      class: 's', style: { background: COLOR_CSS[c], color: 'rgba(0,0,0,.7)' },
      text: COLOR_NAME[c],
      onClick: () => send({ type: 'pressColor', color: c }),
    });
    nodes[c] = node;
    grid.append(node);
  }
  body.append(grid);
  const status = el('div', { class: 'muted small', style: { marginTop: '8px' } });
  body.append(status);
  body.append(el('div', { class: 'muted small', text: st.note || '' }));

  const segA = buildFlashTimeline(st.playA || [], { lead: 700, on: 460, gap: 300, tail: 2200 });
  const segB = buildFlashTimeline(st.playB || [], { lead: 300, on: 260, gap: 150, tail: 2400 });
  const total = segA.total + segB.total;
  const key = `simon2:${mod.uid}:${(st.playA || []).join('')}:${(st.playB || []).join('')}`;
  const t0 = animClock(key, total, false);
  let alive = true;
  let everAttached = false;

  const tick = () => {
    if (!alive) return;
    if (everAttached && !document.body.contains(grid)) { alive = false; return; }
    if (!everAttached && document.body.contains(grid)) everAttached = true;
    const cycle = (Date.now() - t0) % total;
    for (const c of order) nodes[c].classList.remove('lit');
    const inA = cycle < segA.total;
    const seg = inA ? segA : segB;
    const idx = flashStateAt(seg, inA ? cycle : cycle - segA.total);
    if (idx >= 0) {
      nodes[seg.marks[idx].color].classList.add('lit');
      status.textContent = `${inA ? '第一段（慢）' : '第二段（快）'} 第 ${idx + 1}/${seg.marks.length} 下 · 已按对 ${st.expected || 0}`;
    } else {
      status.textContent = `${inA ? '第一段（慢）' : '第二段（快）'} 间隔中 · 已按对 ${st.expected || 0}`;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
