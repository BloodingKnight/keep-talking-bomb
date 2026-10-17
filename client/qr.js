// 极简二维码编码器（字节模式 / 纠错级别 M / 版本 1~10）。
//
// 为什么自己写：本项目零第三方依赖，而且 exe 要能离线用，不能依赖在线二维码服务。
// 正确性由 tools/verify-qr.mjs 用 jsqr（开发期依赖）真的解码回来验证。
//
// 用法：
//   const m = encode('http://192.168.1.5:3210/?room=ABCD');
//   const svg = toSvg(m, { scale: 6, quiet: 4 });
'use strict';

  // 纠错级别 M（约 15% 容错），版本 1..10 的两张表
  const ECC_PER_BLOCK = [10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
  const NUM_BLOCKS = [1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
  const MAX_VERSION = 10;
  const ECL_M = 0; // 格式信息里 M 的记录值是 0b00

  // ------------------------------------------------------------ GF(256)
  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  (function () {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();

  const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

  function genPoly(deg) {
    let g = [1];
    for (let i = 0; i < deg; i++) {
      const next = new Array(g.length + 1).fill(0);
      for (let j = 0; j < g.length; j++) {
        next[j] ^= g[j];
        next[j + 1] ^= mul(g[j], EXP[i]);
      }
      g = next;
    }
    return g; // 降幂排列，g[0] === 1
  }

  function eccFor(data, deg) {
    const g = genPoly(deg);
    const rem = new Uint8Array(deg);
    for (let k = 0; k < data.length; k++) {
      const factor = data[k] ^ rem[0];
      rem.copyWithin(0, 1);
      rem[deg - 1] = 0;
      for (let i = 0; i < deg; i++) rem[i] ^= mul(g[i + 1], factor);
    }
    return rem;
  }

  // ------------------------------------------------------------ 容量
  function rawModules(ver) {
    let result = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      const numAlign = Math.floor(ver / 7) + 2;
      result -= (25 * numAlign - 10) * numAlign - 55;
      if (ver >= 7) result -= 36;
    }
    return result;
  }

  const rawCodewords = (ver) => Math.floor(rawModules(ver) / 8);
  const dataCodewords = (ver) => rawCodewords(ver) - ECC_PER_BLOCK[ver - 1] * NUM_BLOCKS[ver - 1];

  function utf8Bytes(text) {
    const out = [];
    for (const ch of String(text)) {
      let cp = ch.codePointAt(0);
      if (cp < 0x80) out.push(cp);
      else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
      else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
      else
        out.push(
          0xf0 | (cp >> 18),
          0x80 | ((cp >> 12) & 63),
          0x80 | ((cp >> 6) & 63),
          0x80 | (cp & 63),
        );
    }
    return out;
  }

  function pickVersion(byteLen) {
    for (let v = 1; v <= MAX_VERSION; v++) {
      const countBits = v <= 9 ? 8 : 16;
      const need = 4 + countBits + byteLen * 8;
      if (need <= dataCodewords(v) * 8) return v;
    }
    throw new Error('内容太长，二维码放不下（最多 ' + MAX_VERSION + ' 版本）: ' + byteLen + ' 字节');
  }

  // ------------------------------------------------------------ 码字
  function buildCodewords(bytes, ver) {
    const bits = [];
    const push = (val, len) => {
      for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
    };
    push(0b0100, 4); // 字节模式
    push(bytes.length, ver <= 9 ? 8 : 16);
    for (const b of bytes) push(b, 8);

    const capacity = dataCodewords(ver) * 8;
    push(0, Math.min(4, capacity - bits.length)); // 终止符
    while (bits.length % 8 !== 0) bits.push(0);
    for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);

    const data = new Uint8Array(bits.length / 8);
    for (let i = 0; i < bits.length; i++) if (bits[i]) data[i >>> 3] |= 0x80 >>> (i & 7);

    const numBlocks = NUM_BLOCKS[ver - 1];
    const eccLen = ECC_PER_BLOCK[ver - 1];
    const raw = rawCodewords(ver);
    const numShortBlocks = numBlocks - (raw % numBlocks);
    const shortBlockLen = Math.floor(raw / numBlocks);

    const blocks = [];
    let offset = 0;
    for (let i = 0; i < numBlocks; i++) {
      const dataLen = shortBlockLen - eccLen + (i < numShortBlocks ? 0 : 1);
      const chunk = data.slice(offset, offset + dataLen);
      offset += dataLen;
      blocks.push({ data: chunk, ecc: eccFor(chunk, eccLen) });
    }

    // 交错
    const out = [];
    const maxData = Math.max(...blocks.map((b) => b.data.length));
    for (let i = 0; i < maxData; i++) for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
    for (let i = 0; i < eccLen; i++) for (const b of blocks) out.push(b.ecc[i]);
    return out;
  }

  // ------------------------------------------------------------ 矩阵
  function alignmentPositions(ver, size) {
    if (ver === 1) return [];
    const numAlign = Math.floor(ver / 7) + 2;
    const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
    const result = [6];
    for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
    return result;
  }

  function bchFormat(data) {
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    return ((data << 10) | rem) ^ 0x5412;
  }

  function bchVersion(ver) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    return (ver << 12) | rem;
  }

  const MASKS = [
    (r, c) => (r + c) % 2 === 0,
    (r) => r % 2 === 0,
    (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
  ];

  function penalty(m, size) {
    let score = 0;
    // 规则 1：连续同色
    for (let r = 0; r < size; r++) {
      let run = 1;
      for (let c = 1; c < size; c++) {
        if (m[r][c] === m[r][c - 1]) run++;
        else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
        }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
    for (let c = 0; c < size; c++) {
      let run = 1;
      for (let r = 1; r < size; r++) {
        if (m[r][c] === m[r - 1][c]) run++;
        else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
        }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
    // 规则 2：2x2 同色块
    for (let r = 0; r < size - 1; r++) {
      for (let c = 0; c < size - 1; c++) {
        const v = m[r][c];
        if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
      }
    }
    // 规则 3：类定位图案 1:1:3:1:1
    const pat = [1, 0, 1, 1, 1, 0, 1];
    const check = (get) => {
      for (let i = 0; i < size - 6; i++) {
        let hit = true;
        for (let k = 0; k < 7; k++)
          if (get(i + k) !== pat[k]) {
            hit = false;
            break;
          }
        if (hit) {
          const before = i >= 4 ? [i - 4, i - 1].every((j) => get(j) === 0) : true;
          const after = i + 10 < size ? [i + 7, i + 10].every((j) => get(j) === 0) : true;
          if (before || after) score += 40;
        }
      }
    };
    for (let r = 0; r < size; r++) check((i) => m[r][i]);
    for (let c = 0; c < size; c++) check((i) => m[i][c]);
    // 规则 4：深色比例
    let dark = 0;
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (m[r][c]) dark++;
    const ratio = (dark * 100) / (size * size);
    score += Math.floor(Math.abs(ratio - 50) / 5) * 10;
    return score;
  }

  function buildMatrix(ver, codewords) {
    const size = ver * 4 + 17;
    const m = [];
    const fn = [];
    for (let r = 0; r < size; r++) {
      m.push(new Uint8Array(size));
      fn.push(new Uint8Array(size));
    }
    const set = (r, c, dark) => {
      m[r][c] = dark ? 1 : 0;
      fn[r][c] = 1;
    };

    // 定位图案 + 分隔符
    const finder = (r0, c0) => {
      for (let r = -1; r <= 7; r++) {
        for (let c = -1; c <= 7; c++) {
          const rr = r0 + r;
          const cc = c0 + c;
          if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
          const inner = r >= 0 && r <= 6 && c >= 0 && c <= 6;
          const dark =
            inner && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
          set(rr, cc, dark);
        }
      }
    };
    finder(0, 0);
    finder(0, size - 7);
    finder(size - 7, 0);

    // 定时图案
    for (let i = 8; i < size - 8; i++) {
      set(6, i, i % 2 === 0);
      set(i, 6, i % 2 === 0);
    }

    // 校正图案
    const align = alignmentPositions(ver, size);
    for (let i = 0; i < align.length; i++) {
      for (let j = 0; j < align.length; j++) {
        const r0 = align[i];
        const c0 = align[j];
        // 跳过与定位图案重叠的三个角
        if ((r0 === 6 && c0 === 6) || (r0 === 6 && c0 === size - 7) || (r0 === size - 7 && c0 === 6)) continue;
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
            set(r0 + dr, c0 + dc, dark);
          }
        }
      }
    }

    // 预留格式信息区（先占位，最后填真值）
    for (let i = 0; i <= 8; i++) {
      if (!fn[8][i]) set(8, i, false);
      if (!fn[i][8]) set(i, 8, false);
    }
    for (let i = 0; i < 8; i++) set(8, size - 1 - i, false);
    for (let i = 8; i < 15; i++) set(size - 15 + i, 8, false);
    set(size - 8, 8, true); // 固定的深色模块

    // 版本信息（v7+）
    if (ver >= 7) {
      const bits = bchVersion(ver);
      for (let i = 0; i < 18; i++) {
        const dark = ((bits >>> i) & 1) === 1;
        const a = size - 11 + (i % 3);
        const b = Math.floor(i / 3);
        set(b, a, dark);
        set(a, b, dark);
      }
    }

    // 数据区（Z 字形）
    let idx = 0;
    const totalBits = codewords.length * 8;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const c = right - j;
          const upward = ((right + 1) & 2) === 0;
          const r = upward ? size - 1 - vert : vert;
          if (fn[r][c]) continue;
          let dark = 0;
          if (idx < totalBits) dark = (codewords[idx >>> 3] >>> (7 - (idx & 7))) & 1;
          idx++;
          m[r][c] = dark;
        }
      }
    }

    // 选掩码
    let bestMask = 0;
    let bestScore = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      const trial = m.map((row) => Array.from(row));
      for (let r = 0; r < size; r++)
        for (let c = 0; c < size; c++) if (!fn[r][c] && MASKS[mask](r, c)) trial[r][c] ^= 1;
      // 格式信息参与评分，所以先写进去
      writeFormat(trial, size, mask);
      const s = penalty(trial, size);
      if (s < bestScore) {
        bestScore = s;
        bestMask = mask;
      }
    }
    for (let r = 0; r < size; r++)
      for (let c = 0; c < size; c++) if (!fn[r][c] && MASKS[bestMask](r, c)) m[r][c] ^= 1;
    writeFormat(m, size, bestMask);

    return { version: ver, size, modules: m.map((row) => Array.from(row)) };
  }

  function writeFormat(m, size, mask) {
    const bits = bchFormat((ECL_M << 3) | mask);
    const bit = (i) => ((bits >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) m[i][8] = bit(i) ? 1 : 0;
    m[7][8] = bit(6) ? 1 : 0;
    m[8][8] = bit(7) ? 1 : 0;
    m[8][7] = bit(8) ? 1 : 0;
    for (let i = 9; i < 15; i++) m[8][14 - i] = bit(i) ? 1 : 0;
    for (let i = 0; i < 8; i++) m[8][size - 1 - i] = bit(i) ? 1 : 0;
    for (let i = 8; i < 15; i++) m[size - 15 + i][8] = bit(i) ? 1 : 0;
    m[size - 8][8] = 1;
  }

  // ------------------------------------------------------------ 对外接口
  function encode(text) {
    const bytes = utf8Bytes(text);
    const ver = pickVersion(bytes.length);
    const codewords = buildCodewords(bytes, ver);
    return buildMatrix(ver, codewords);
  }

  /** 生成 SVG 字符串（不依赖 DOM，方便测试） */
  function toSvg(qr, opts) {
    const o = opts || {};
    const scale = o.scale || 6;
    const quiet = o.quiet === undefined ? 4 : o.quiet;
    const size = (qr.size + quiet * 2) * scale;
    const dark = o.dark || '#0b0f14';
    const light = o.light || '#ffffff';
    let path = '';
    for (let r = 0; r < qr.size; r++) {
      for (let c = 0; c < qr.size; c++) {
        if (!qr.modules[r][c]) continue;
        const x = (c + quiet) * scale;
        const y = (r + quiet) * scale;
        path += 'M' + x + ' ' + y + 'h' + scale + 'v' + scale + 'h-' + scale + 'z';
      }
    }
    return (
      '<svg xmlns="http://www.w3.org/2000/svg" width="' +
      size +
      '" height="' +
      size +
      '" viewBox="0 0 ' +
      size +
      ' ' +
      size +
      '" shape-rendering="crispEdges" role="img" aria-label="加入房间的二维码">' +
      '<rect width="100%" height="100%" fill="' +
      light +
      '"/>' +
      '<path d="' +
      path +
      '" fill="' +
      dark +
      '"/></svg>'
    );
  }

  export { encode, toSvg };
