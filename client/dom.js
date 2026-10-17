// Tiny DOM helpers used by every client view.

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }
export function $(sel, root = document) { return root.querySelector(sel); }

export function fmtClock(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function toast(text, ms = 1800) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = text;
  t.classList.remove('hidden');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => t.classList.add('hidden'), ms);
}

/** Deterministic PRNG so per-module animations look stable across re-renders. */
export function seededRandom(seedStr) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seedStr.length; i++) { h ^= seedStr.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return function next() {
    h ^= h << 13; h >>>= 0;
    h ^= h >>> 17;
    h ^= h << 5; h >>>= 0;
    return h / 0x100000000;
  };
}

export const COLOR_CSS = {
  red: '#e5484d', blue: '#3b82f6', yellow: '#eab308', green: '#22c55e',
  white: '#f4f4f5', black: '#27272a', orange: '#f97316', purple: '#a855f7',
};
export const COLOR_NAME = {
  red: '红', blue: '蓝', yellow: '黄', green: '绿', white: '白', black: '黑', orange: '橙', purple: '紫',
};
