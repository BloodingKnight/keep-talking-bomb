import fs from 'node:fs';
import zlib from 'node:zlib';

const p = process.argv[2];
const buf = fs.readFileSync(p);
const s = buf.toString('latin1');
console.log('len', buf.length, 'pages', (s.match(/\/Type\s*\/Page[^s]/g) || []).length);
console.log('images', (s.match(/\/Subtype\s*\/Image/g) || []).length);
console.log('fonts', (s.match(/\/Type\s*\/Font/g) || []).length);
console.log('contents', (s.match(/\/Contents/g) || []).length);

// Try to find text-bearing streams
const re = /stream\r?\n/g;
let m, i = 0, textStreams = 0, shown = 0;
while ((m = re.exec(s))) {
  const start = m.index + m[0].length;
  const end = s.indexOf('endstream', start);
  if (end < 0) continue;
  let raw = buf.subarray(start, end);
  let out = null;
  try { out = zlib.inflateSync(raw); } catch { try { out = zlib.inflateRawSync(raw); } catch { out = null; } }
  if (!out) continue;
  const t = out.toString('latin1');
  if (/BT[\s\S]{0,2000}?Tj/.test(t) || /\/F\d+/.test(t)) {
    textStreams++;
    if (shown < 3) {
      console.log('=== stream', i, 'len', out.length, '===');
      console.log(t.slice(0, 1200));
      shown++;
    }
  }
  i++;
}
console.log('inflated streams', i, 'text-ish streams', textStreams);
