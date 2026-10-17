import fs from 'node:fs';
import zlib from 'node:zlib';

const p = process.argv[2];
const outPath = process.argv[3] || 'tools/manual-text.txt';
const buf = fs.readFileSync(p);
const s = buf.toString('latin1');

const objRe = /(\d+)\s+(\d+)\s+obj\b/g;
const objs = new Map();
let m;
while ((m = objRe.exec(s))) {
  const num = +m[1];
  const bodyStart = m.index + m[0].length;
  const endIdx = s.indexOf('endobj', bodyStart);
  objs.set(num, { start: bodyStart, end: endIdx < 0 ? s.length : endIdx });
}
function rawStreamText(num) {
  const o = objs.get(num);
  if (!o) return null;
  const slice = s.slice(o.start, o.end);
  const si = slice.indexOf('stream');
  if (si < 0) return null;
  let dataStart = o.start + si + 6;
  if (s[dataStart] === '\r') dataStart++;
  if (s[dataStart] === '\n') dataStart++;
  const eIdx = s.indexOf('endstream', dataStart);
  const raw = buf.subarray(dataStart, eIdx);
  let out;
  try { out = zlib.inflateSync(raw); }
  catch { try { out = zlib.inflateRawSync(raw); } catch { return null; } }
  return out.toString('utf8');
}

// ---------- fonts: object -> cid map
const fontCidMap = new Map();
const fontCodeBytes = new Map();
for (const [num, o] of objs) {
  const slice = s.slice(o.start, o.end);
  if (!/\/Type\s*\/Font/.test(slice)) continue;
  const tu = /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(slice);
  const map = new Map();
  // bytes per code, derived from the CMap codespacerange
  let nBytes = 2;
  if (tu) {
    const txt = rawStreamText(+tu[1]);
    if (txt) {
      const csr = /begincodespacerange\s*<([0-9A-Fa-f]+)>/.exec(txt);
      if (csr) nBytes = Math.max(1, Math.ceil(csr[1].length / 2));
      for (const blk of txt.match(/beginbfchar([\s\S]*?)endbfchar/g) || []) {
        for (const c of blk.match(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g) || []) {
          const mm = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/.exec(c);
          let dst = '';
          for (let i = 0; i < mm[2].length; i += 4) dst += String.fromCharCode(parseInt(mm[2].substr(i, 4), 16));
          map.set(parseInt(mm[1], 16), dst);
        }
      }
      for (const blk of txt.match(/beginbfrange([\s\S]*?)endbfrange/g) || []) {
        for (const c of blk.match(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g) || []) {
          const mm = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/.exec(c);
          const lo = parseInt(mm[1], 16), hi = parseInt(mm[2], 16), d0 = parseInt(mm[3], 16);
          for (let k = lo; k <= hi; k++) map.set(k, String.fromCharCode(d0 + (k - lo)));
        }
      }
    }
  }
  fontCidMap.set(num, map);
  fontCodeBytes.set(num, nBytes);
}

// ---------- pages in doc order via /Kids
function pageOrder() {
  const kids = s.match(/\/Kids\s*\[[^\]]*\]/g) || [];
  const seen = [];
  for (const k of kids) {
    for (const r of k.match(/(\d+)\s+\d+\s+R/g) || []) seen.push(+(/(\d+)/.exec(r)[1]));
  }
  if (seen.length) return seen;
  const out = [];
  for (const [num, o] of objs) {
    const slice = s.slice(o.start, o.end);
    if (/\/Type\s*\/Page[^s]/.test(slice)) out.push(num);
  }
  return out;
}

function decodeText(hex, fontObj) {
  const map = fontCidMap.get(fontObj);
  const nb = (fontCodeBytes.get(fontObj) || 2) * 2;
  let str = '';
  for (let i = 0; i + nb <= hex.length; i += nb) {
    const cid = parseInt(hex.substr(i, nb), 16);
    str += map && map.has(cid) ? map.get(cid) : `\uFFFD${cid.toString(16)}`;
  }
  return str;
}

function decodePage(pageNum) {
  const o = objs.get(pageNum);
  const slice = s.slice(o.start, o.end);
  const fontRes = new Map();
  const fontBlock = /\/Font\s*<<([\s\S]*?)>>/.exec(slice);
  if (fontBlock) {
    for (const f of fontBlock[1].match(/\/([A-Za-z0-9]+)\s+(\d+)\s+\d+\s+R/g) || []) {
      const mm = /\/([A-Za-z0-9]+)\s+(\d+)\s+\d+\s+R/.exec(f);
      fontRes.set(mm[1], +mm[2]);
    }
  }
  const cm = /\/Contents\s+(\d+)\s+\d+\s+R/.exec(slice);
  if (!cm) return [];
  const txt = rawStreamText(+cm[1]);
  if (!txt) return [];

  // lex the content stream
  const lex = /\[|\]|<[0-9A-Fa-f\s]*>|\/([A-Za-z0-9_.+-]+)|(-?\d*\.?\d+)|([A-Za-z'"*]+)/g;
  const items = [];
  const stack = [];
  let curFont = null;
  let tm = [1, 0, 0, 1, 0, 0];
  let tlm = [1, 0, 0, 1, 0, 0];
  let leading = 0;
  let lastText = '';
  for (const tok of txt.match(lex) || []) {
    if (/^-?\d*\.?\d+$/.test(tok)) { stack.push(parseFloat(tok)); continue; }
    if (tok.startsWith('/')) { stack.push({ name: tok.slice(1) }); continue; }
    if (tok === '[' || tok === ']') { stack.push(tok); continue; }
    if (tok.startsWith('<')) {
      const h = tok.slice(1, -1).replace(/\s+/g, '');
      stack.push({ hex: h });
      // if last pushed was a TJ array element, it stays in order
      continue;
    }
    // operator
    const op = tok;
    const nums = () => stack.filter((v) => typeof v === 'number');
    if (op === 'Tf') {
      const nm = [...stack].reverse().find((v) => v && v.name);
      const sz = [...stack].reverse().find((v) => typeof v === 'number');
      if (nm) curFont = nm.name;
      if (sz) leading = leading; // ignore
    } else if (op === 'Tm') {
      const n = nums();
      if (n.length >= 6) { tm = n.slice(-6); tlm = tm.slice(); }
    } else if (op === 'Td') {
      const n = nums();
      if (n.length >= 2) {
        const [tx, ty] = n.slice(-2);
        tlm = [tlm[0], tlm[1], tlm[2], tlm[3], tlm[4] + tx * tlm[0] + ty * tlm[2], tlm[5] + tx * tlm[1] + ty * tlm[3]];
        tm = tlm.slice();
      }
    } else if (op === 'TD') {
      const n = nums();
      if (n.length >= 2) {
        const [tx, ty] = n.slice(-2);
        leading = -ty;
        tlm = [tlm[0], tlm[1], tlm[2], tlm[3], tlm[4] + tx * tlm[0] + ty * tlm[2], tlm[5] + tx * tlm[1] + ty * tlm[3]];
        tm = tlm.slice();
      }
    } else if (op === 'T*') {
      tlm = [tlm[0], tlm[1], tlm[2], tlm[3], tlm[4] - leading * tlm[2], tlm[5] - leading * tlm[3]];
      tm = tlm.slice();
    } else if (op === 'Tj' || op === 'TJ' || op === "'" || op === '"') {
      let chunks = [];
      if (op === 'TJ') {
        for (const v of stack) if (v && v.hex !== undefined) chunks.push(v.hex);
      } else {
        const h = [...stack].reverse().find((v) => v && v.hex !== undefined);
        if (h) chunks.push(h.hex);
      }
      const fobj = fontRes.get(curFont);
      let str = '';
      for (const c of chunks) str += decodeText(c, fobj);
      if (str) items.push({ x: tm[4], y: tm[5], text: str });
      lastText = str;
    } else if (op === 'BI') { /* inline image: skip to EI */ }
    stack.length = 0;
  }
  // group into lines by y (rounded), keeping x order
  const map2 = new Map();
  for (const it of items) {
    const key = Math.round(it.y * 2) / 2;
    if (!map2.has(key)) map2.set(key, []);
    map2.get(key).push(it);
  }
  const lines = [];
  for (const [key, arr] of [...map2.entries()].sort((a, b) => b[0] - a[0])) {
    arr.sort((a, b) => a.x - b.x);
    let line = '';
    let prevEnd = null;
    for (const it of arr) {
      if (prevEnd !== null && it.x - prevEnd > 6) line += '  ';
      line += it.text;
      prevEnd = it.x + it.text.length * 4;
    }
    if (line.trim()) lines.push({ y: key, text: line });
  }
  return lines;
}

const pages = pageOrder();
const out = [];
pages.forEach((pn, i) => {
  out.push(`\n########## PAGE ${i + 1} ##########`);
  for (const l of decodePage(pn)) out.push(l.text);
});
fs.writeFileSync(outPath, out.join('\n'), 'utf8');
console.log('pages', pages.length, 'lines', out.length, '->', outPath, fs.statSync(outPath).size);
