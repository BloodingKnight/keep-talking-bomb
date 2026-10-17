// 用 jsqr 真解码一遍，验证 client/qr.js 编出来的码是能被扫的（开发期校验，玩家不需要）。
//   node tools/verify-qr.mjs
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..');
const jsQR = require(path.join(ROOT, '.build', 'node_modules', 'jsqr', 'dist', 'jsQR.js'));

// 在 Node 里直接 import（client/qr.js 是标准 ES module，浏览器和 Node 都能用）
const QR = await import(pathToFileURL(path.join(ROOT, 'client', 'qr.js')).href);

const samples = [
  'http://192.168.31.49:3210/?room=ABCD',
  'http://localhost:3210',
  'http://10.0.0.7:3210/tutorial',
  'http://192.168.1.100:8080/?room=Z7K2&name=%E5%B0%8F%E6%98%8E',
  'https://bomb.example.com/?room=QWER',
  'A',
  'x'.repeat(60),
  'x'.repeat(90),
  'x'.repeat(120),
  '中文房间邀请 http://192.168.1.5:3210/?room=TEST', // 非 ASCII：字节模式要按 UTF-8 编码
  'x'.repeat(180),
];

let pass = 0;
let fail = 0;

for (const text of samples) {
  const qr = QR.encode(text);
  const scale = 4;
  const quiet = 4;
  const dim = (qr.size + quiet * 2) * scale;

  // 渲染成 RGBA 像素给 jsqr
  const data = new Uint8ClampedArray(dim * dim * 4).fill(255);
  for (let r = 0; r < qr.size; r++) {
    for (let c = 0; c < qr.size; c++) {
      if (!qr.modules[r][c]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const x = (c + quiet) * scale + dx;
          const y = (r + quiet) * scale + dy;
          const o = (y * dim + x) * 4;
          data[o] = 0;
          data[o + 1] = 0;
          data[o + 2] = 0;
        }
      }
    }
  }

  const decoded = jsQR(data, dim, dim);
  const label = text.length > 34 ? text.slice(0, 31) + '…' : text;
  if (decoded && decoded.data === text) {
    console.log(`  ✓ v${qr.version} ${qr.size}x${qr.size}  ${label}`);
    pass++;
  } else {
    console.log(`  ✗ v${qr.version} ${qr.size}x${qr.size}  ${label}`);
    console.log(`      解出: ${decoded ? JSON.stringify(decoded.data) : '(解不出)'}`);
    fail++;
  }
}

console.log(`\n通过 ${pass} / ${pass + fail}，失败 ${fail}`);
process.exitCode = fail === 0 ? 0 : 1;
