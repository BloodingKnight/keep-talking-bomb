// 生成 Tauri 用的应用图标（src-tauri/logo.png，512x512）。
// 自己写 PNG，不引入任何图片库。
//
//   node tools/make-icon.mjs
//
// CI 里随后会跑 `cargo tauri icon logo.png`，由它派生 32/128/256 和 .ico/.icns。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'src-tauri', 'logo.png');
const S = 512;
const px = Buffer.alloc(S * S * 4);

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix = (a, b, t) => Math.round(a + (b - a) * clamp01(t));

function set(x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  const o = (y * S + x) * 4;
  const inv = 1 - a / 255;
  px[o] = mix(px[o], r, a / 255);
  px[o + 1] = mix(px[o + 1], g, a / 255);
  px[o + 2] = mix(px[o + 2], b, a / 255);
  px[o + 3] = Math.max(px[o + 3], a);
  if (inv === 1) px[o + 3] = 0;
}

// 带抗锯齿的圆：返回覆盖率
function circleCov(x, y, cx, cy, r) {
  const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
  return clamp01(r + 0.5 - d);
}

function fillCircle(cx, cy, r, color) {
  for (let y = Math.floor(cy - r - 2); y <= Math.ceil(cy + r + 2); y++) {
    for (let x = Math.floor(cx - r - 2); x <= Math.ceil(cx + r + 2); x++) {
      const c = circleCov(x, y, cx, cy, r);
      if (c > 0) set(x, y, color[0], color[1], color[2], Math.round(255 * c));
    }
  }
}

// 粗线段（用来画引线）
function thickLine(x1, y1, x2, y2, w, color) {
  const minX = Math.floor(Math.min(x1, x2) - w - 2);
  const maxX = Math.ceil(Math.max(x1, x2) + w + 2);
  const minY = Math.floor(Math.min(y1, y2) - w - 2);
  const maxY = Math.ceil(Math.max(y1, y2) + w + 2);
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      // 点到线段距离
      const dx = x2 - x1;
      const dy = y2 - y1;
      const len2 = dx * dx + dy * dy || 1;
      let t = ((x - x1) * dx + (y - y1) * dy) / len2;
      t = clamp01(t);
      const d = Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
      const cov = clamp01(w / 2 + 0.5 - d);
      if (cov > 0) set(x, y, color[0], color[1], color[2], Math.round(255 * cov));
    }
  }
}

// 背景：深色 + 中心微亮
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const d = Math.hypot(x - S / 2, y - S / 2) / (S / 2);
    const t = clamp01(1 - d);
    set(x, y, mix(8, 26, t), mix(12, 34, t), mix(18, 48, t), 255);
  }
}

// 炸弹本体
fillCircle(256, 300, 150, [44, 54, 70]);
fillCircle(256, 300, 140, [30, 38, 52]);
// 高光
fillCircle(206, 250, 42, [72, 86, 108]);
// 引线
thickLine(330, 190, 386, 120, 16, [120, 92, 46]);
thickLine(330, 190, 386, 120, 8, [217, 161, 59]);
// 火花
fillCircle(392, 112, 26, [255, 176, 66]);
fillCircle(392, 112, 14, [255, 226, 150]);
// 引信座
thickLine(316, 168, 350, 202, 22, [58, 70, 88]);

// ---------------- PNG 编码
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 最近邻缩放（图标这种几何图形足够用，不引入任何依赖） */
function resize(src, from, to) {
  const out = Buffer.alloc(to * to * 4);
  const ratio = from / to;
  for (let y = 0; y < to; y++) {
    for (let x = 0; x < to; x++) {
      const sx = Math.min(from - 1, Math.floor((x + 0.5) * ratio));
      const sy = Math.min(from - 1, Math.floor((y + 0.5) * ratio));
      const s = (sy * from + sx) * 4;
      const d = (y * to + x) * 4;
      out[d] = src[s];
      out[d + 1] = src[s + 1];
      out[d + 2] = src[s + 2];
      out[d + 3] = src[s + 3];
    }
  }
  return out;
}

const targets = [
  { file: OUT, size: S }, // Tauri 图标源图
  { file: path.join(ROOT, 'client', 'icon-512.png'), size: 512 }, // PWA / 主屏幕图标
  { file: path.join(ROOT, 'client', 'icon-192.png'), size: 192 },
  { file: path.join(ROOT, 'docs', 'icon-192.png'), size: 192 }, // Pages 页面的小图标
];

for (const t of targets) {
  const rgba = t.size === S ? px : resize(px, S, t.size);
  const png = encodePng(t.size, t.size, rgba);
  fs.mkdirSync(path.dirname(t.file), { recursive: true });
  fs.writeFileSync(t.file, png);
  console.log(`[icon] ${path.relative(ROOT, t.file)}  ${t.size}x${t.size}  ${(png.length / 1024).toFixed(0)} KB`);
}
