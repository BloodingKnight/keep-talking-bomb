// Expert-side manual view: rule tables, bomb casing facts, split-manual slices.

import { el, clear } from './dom.js';

export function renderManual(main, ctx) {
  const { state } = ctx;
  clear(main);
  const manual = state.manual;
  if (!manual) {
    main.append(el('div', { class: 'panel', text: '手册还没生成。' }));
    return;
  }

  const solvedUids = new Set((state.bomb?.moduleStates || []).filter((m) => m.status === 'solved').map((m) => m.uid));

  // --- bomb casing reference (this is the part the defuser cannot see)
  const casing = manual.casing || {};
  const caseRow = el('div', { class: 'casing' }, [
    chip('序列号', casing.serial),
    chip('电池', `${casing.batteries} 个${casing.batteryTypes?.length ? `（${casing.batteryTypes.join(' / ')}）` : ''}`),
    chip('亮着的指示灯', casing.indicators?.length ? casing.indicators.join(' · ') : '无'),
    chip('端口', casing.ports?.length ? casing.ports.join(' / ') : '无'),
    chip('失误', `${state.strikes}/${state.maxStrikes}`),
  ]);

  main.append(el('div', { class: 'panel' }, [
    el('div', { class: 'mod-head' }, [
      el('span', { class: 'mh-icon', text: '📖' }),
      el('span', { class: 'mh-title', text: '专家手册' }),
      el('span', { class: 'tier', text: `${manual.sections.length} 个模块 · 手册模式：${manual.mode === 'partial' ? '拆分' : '完整'}` }),
    ]),
    el('div', { class: 'muted small', text: '这些是炸弹外壳上的信息。拆弹者看不到它们 —— 你需要主动问，或者把答案算好再告诉他。' }),
    caseRow,
    el('div', { class: 'legend' }, (manual.colorLegend || []).map((c) => el('div', { class: 'lg' }, [
      el('span', { class: 'sw', style: { background: c.css } }),
      el('span', { text: c.name }),
    ]))),
  ]));

  const searchBox = el('input', { placeholder: '搜索模块名或规则关键字…', onInput: () => applyFilter() });
  main.append(el('div', { class: 'panel', style: { marginTop: '12px' } }, [
    el('div', { class: 'manual-search' }, [searchBox]),
    el('div', { class: 'muted small', text: manual.mode === 'partial'
      ? '⚠ 你手上只有一部分条目，其他专家拿到的是另外一些。把关键的那几行念出来，互相补全。'
      : '按模块逐个对照拆弹者的描述。' }),
  ]));

  const wrap = el('div', { class: 'manual-sections', style: { marginTop: '12px' } });
  manual.sections.forEach((sec) => {
    const card = el('div', { class: 'manual-card' + (solvedUids.has(sec.uid) ? ' solved' : ''), dataset: { search: searchText(sec) } });
    card.append(el('div', { class: 'mc-head' }, [
      el('span', { class: 'mh-icon', text: sec.icon }),
      el('span', { class: 'mc-title', text: sec.title }),
      el('span', { class: 'mc-tag', text: `等级 ${sec.tier}` }),
      sec.status === 'solved' ? el('span', { class: 'mc-tag', style: { color: '#7dffa8', borderColor: '#2b6b42' }, text: '已拆除' }) : null,
    ]));
    if (sec.partial) {
      card.append(el('div', { class: 'split-warn', text: '这一节属于拆分手册：你只看到其中一部分条目。' }));
    }
    for (const g of sec.groups) card.append(renderGroup(g));
    if (sec.asks && sec.asks.length) {
      card.append(el('div', { class: 'asks' }, [el('span', { text: '要问拆弹者：' })].concat(sec.asks.map((a) => el('span', { text: a })))));
    }
    wrap.append(card);
  });
  main.append(wrap);

  function applyFilter() {
    const q = searchBox.value.trim().toLowerCase();
    for (const card of wrap.children) {
      const hit = !q || (card.dataset.search || '').includes(q);
      card.classList.toggle('hidden', !hit);
    }
  }

  function renderGroup(g) {
    const box = el('div');
    if (g.kind === 'note') {
      box.append(el('div', { class: 'note-block', text: g.title }));
    } else if (g.kind === 'table') {
      if (g.title) box.append(el('div', { class: 'note-block', style: { fontWeight: '600' }, text: g.title }));
      if (!g.rows.length) {
        box.append(el('div', { class: 'muted small', text: '（这一部分不在你的手册里 —— 问问其他专家）' }));
        return box;
      }
      const table = el('table', { class: 'mtable' });
      if (g.head) {
        table.append(el('tr', {}, g.head.map((h) => el('th', { text: h }))));
      }
      for (const r of g.rows) {
        table.append(el('tr', {}, [
          el('td', { text: r.label || '' }),
          el('td', { class: 'act', text: r.action || '' }),
        ]));
      }
      box.append(table);
    } else if (g.kind === 'maze') {
      box.append(el('div', { class: 'note-block', style: { fontWeight: '600' }, text: g.title }));
      box.append(renderMazeGrid(g));
    }
    return box;
  }
}

function chip(key, value) {
  return el('div', { class: 'c' }, [el('span', { class: 'muted', text: `${key}：` }), el('b', { text: String(value) }), ]);
}

function renderMazeGrid(g) {
  const n = g.n;
  const grid = el('div', { class: 'maze-grid', style: { gridTemplateColumns: `repeat(${n}, 26px)` } });
  const BITS = { N: 1, E: 2, S: 4, W: 8 };
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const w = g.walls[r * n + c];
      const cell = el('div', { class: 'maze-cell', title: `第 ${r + 1} 行 第 ${c + 1} 列` });
      if (w & BITS.N) cell.append(el('div', { class: 'wall-n' }));
      if (w & BITS.E) cell.append(el('div', { class: 'wall-e' }));
      if (w & BITS.S) cell.append(el('div', { class: 'wall-s' }));
      if (w & BITS.W) cell.append(el('div', { class: 'wall-w' }));
      grid.append(cell);
    }
  }
  return grid;
}

function searchText(sec) {
  const parts = [sec.title, ...(sec.asks || [])];
  for (const g of sec.groups) {
    parts.push(g.title || '');
    for (const r of g.rows || []) parts.push(r.label || '', r.action || '');
  }
  return parts.join(' ').toLowerCase();
}
