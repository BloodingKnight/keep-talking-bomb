// 二维码编码器测试（不需要浏览器、不需要服务端）。
//
//   node tests/qr.mjs                              只跑编码器结构检查
//   node tests/qr.mjs http://127.0.0.1:3210 tok    额外检查 /api/rooms 的 network 信息
//
// 真正的"能不能扫"由 tools/verify-qr.mjs 用 jsqr 解码验证；这里锁定的是结构正确性 + 回归。
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const BASE = process.argv[2] || '';
const TOKEN = process.argv[3] || '';

const { encode, toSvg } = await import(pathToFileURL(path.join(ROOT, 'client', 'qr.js')).href);

let failures = 0;
const ok = (m) => console.log('  ✓ ' + m);
const fail = (m) => {
  failures++;
  console.log('  ✗ ' + m);
};

// ---------------------------------------------------------------- 结构检查
function checkStructure(text) {
  const qr = encode(text);
  const size = qr.size;
  const m = qr.modules;

  if (size === qr.version * 4 + 17) ok(`「${text.slice(0, 24)}」v${qr.version} 尺寸 = ${size}`);
  else fail(`尺寸不对：version ${qr.version} 应有 ${qr.version * 4 + 17}，实际 ${size}`);

  // 三个定位图案：7x7 外框深色、内 3x3 深色、中间一圈浅色
  const finderOk = (r0, c0) => {
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 7; c++) {
        const ring = r === 0 || r === 6 || c === 0 || c === 6;
        const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        const want = ring || core ? 1 : 0;
        if (m[r0 + r][c0 + c] !== want) return `(${r0 + r},${c0 + c})`;
      }
    }
    return null;
  };
  const bad = finderOk(0, 0) || finderOk(0, size - 7) || finderOk(size - 7, 0);
  if (!bad) ok('三个定位图案正确');
  else fail(`定位图案不对，首个错位 ${bad}`);

  // 定时图案：第 6 行/列交替
  let timingBad = 0;
  for (let i = 8; i < size - 8; i++) {
    if (m[6][i] !== (i % 2 === 0 ? 1 : 0)) timingBad++;
    if (m[i][6] !== (i % 2 === 0 ? 1 : 0)) timingBad++;
  }
  if (!timingBad) ok('定时图案交替正确');
  else fail(`定时图案有 ${timingBad} 个点不对`);

  // 固定深色模块
  if (m[size - 8][8] === 1) ok('固定深色模块存在');
  else fail('固定深色模块缺失');

  // 格式信息：两处副本一致、BCH 校验通过、掩码与纠错级别可解析
  const readFormat = () => {
    const bits = new Array(15).fill(0);
    for (let i = 0; i <= 5; i++) bits[i] = m[i][8];
    bits[6] = m[7][8];
    bits[7] = m[8][8];
    bits[8] = m[8][7];
    for (let i = 9; i < 15; i++) bits[i] = m[8][14 - i];
    return bits.reduce((acc, b, i) => acc | (b << i), 0);
  };
  const readFormat2 = () => {
    const bits = new Array(15).fill(0);
    for (let i = 0; i < 8; i++) bits[i] = m[8][size - 1 - i];
    for (let i = 8; i < 15; i++) bits[i] = m[size - 15 + i][8];
    return bits.reduce((acc, b, i) => acc | (b << i), 0);
  };
  const f1 = readFormat();
  const f2 = readFormat2();
  if (f1 === f2) ok('两处格式信息一致');
  else fail(`两处格式信息不一致：${f1.toString(2)} vs ${f2.toString(2)}`);

  // BCH(15,5) 校验：把 15 位码字对 0x537 做多项式长除，余数必须为 0
  let rem = f1 ^ 0x5412;
  for (let i = 14; i >= 10; i--) {
    if ((rem >>> i) & 1) rem ^= 0x537 << (i - 10);
  }
  if ((rem & 0x3ff) === 0) ok('格式信息 BCH 校验通过');
  else fail(`格式信息 BCH 校验失败（余数 ${(rem & 0x3ff).toString(2)}）`);
  const data = (f1 ^ 0x5412) >>> 10;
  const mask = data & 0b111;
  const ecl = (data >> 3) & 0b11;
  if (ecl === 0) ok(`纠错级别 = M，掩码 = ${mask}`);
  else fail(`纠错级别应为 M(0)，实际 ${ecl}`);
  return qr;
}

console.log('— 编码器结构 —');
checkStructure('http://192.168.31.49:3210/?room=ABCD');
checkStructure('http://localhost:3210');
checkStructure('A');
checkStructure('中文邀请 http://192.168.1.5:3210/?room=TEST');

// ---------------------------------------------------------------- 回归快照
console.log('\n— 回归快照（"HELLO" 的 v1 矩阵，逐行）—');
const GOLDEN = [
  '#######.##.#..#######',
  '#.....#..##.#.#.....#',
  '#.###.#..####.#.###.#',
  '#.###.#.#..#..#.###.#',
  '#.###.#.#...#.#.###.#',
  '#.....#.#.##..#.....#',
  '#######.#.#.#.#######',
  '........#####........',
  '#...#.######.#####..#',
  '...###..#.###..#.####',
  '#.##..#.#.##..###..#.',
  '###..#...#...##.#....',
  '..#.###..#..###...##.',
  '........###.###..#.##',
  '#######.##..##...#.#.',
  '#.....#....##..#...#.',
  '#.###.#.#..#..###.#.#',
  '#.###.#....##....#.##',
  '#.###.#..###..####...',
  '#.....#..#...##......',
  '#######.#...#####.#.#',
];
{
  const qr = encode('HELLO');
  const got = qr.modules.map((r) => r.map((v) => (v ? '#' : '.')).join(''));
  if (got.length === GOLDEN.length && got.every((row, i) => row === GOLDEN[i])) ok('「HELLO」矩阵与基线一致');
  else {
    fail('「HELLO」矩阵和基线不一致（编码逻辑被改动过）');
    for (let i = 0; i < Math.max(got.length, GOLDEN.length); i++) {
      if (got[i] !== GOLDEN[i]) console.log(`      第 ${i} 行\n      现在 ${got[i] || '(缺)'}\n      基线 ${GOLDEN[i] || '(缺)'}`);
    }
  }
}

// ---------------------------------------------------------------- SVG 输出
console.log('\n— SVG 输出 —');
{
  const qr = encode('http://192.168.1.5:3210/?room=ABCD');
  const svg = toSvg(qr, { scale: 5, quiet: 4 });
  const side = (qr.size + 8) * 5;
  if (svg.startsWith('<svg') && svg.includes(`width="${side}"`) && svg.includes(`viewBox="0 0 ${side} ${side}"`)) {
    ok(`SVG 尺寸正确（${side}px，含 4 格安静区）`);
  } else {
    fail(`SVG 尺寸不对，应为 ${side}px`);
  }
  const dark = qr.modules.flat().filter(Boolean).length;
  const rects = (svg.match(/M\d+ \d+h5v5h-5z/g) || []).length;
  if (rects === dark) ok(`SVG 里画了 ${dark} 个深色模块，和矩阵一致`);
  else fail(`SVG 模块数不对：画了 ${rects}，应为 ${dark}`);
}

// ---------------------------------------------------------------- 容量边界
console.log('\n— 容量边界 —');
{
  let threw = false;
  try {
    encode('x'.repeat(400));
  } catch (e) {
    threw = true;
    if (/太长/.test(e.message)) ok('超长内容会明确报错');
    else fail(`报错信息不清楚：${e.message}`);
  }
  if (!threw) fail('超长内容居然编码成功了（可能悄悄截断，很危险）');
}

// ---------------------------------------------------------------- 邀请链接 / 二维码
console.log('\n— 邀请链接 —');
{
  const invite = await import(pathToFileURL(path.join(ROOT, 'client', 'invite.js')).href);

  const lan = invite.inviteUrl({
    network: { urls: ['192.168.1.7'], port: 3210 },
    roomCode: 'ABCD',
    origin: 'http://localhost:3210',
  });
  if (lan === 'http://192.168.1.7:3210/?room=ABCD') ok(`有局域网地址时优先用它：${lan}`);
  else fail(`邀请链接没优先用局域网 IP：${lan}`);

  const local = invite.inviteUrl({
    network: { urls: [], port: 3210 },
    roomCode: 'ABCD',
    origin: 'http://localhost:3210',
  });
  if (local === 'http://localhost:3210/?room=ABCD') ok(`没有局域网地址时退回页面地址：${local}`);
  else fail(`退路不对：${local}`);

  const bare = invite.inviteUrl({ roomCode: 'ZZZZ', origin: 'http://example.com:9' });
  if (bare === 'http://example.com:9/?room=ZZZZ') ok('缺少 network 字段时也不崩');
  else fail(`缺 network 时结果不对：${bare}`);

  const { url, svg } = invite.inviteQrSvg({
    network: { urls: ['10.0.0.5'], port: 8080 },
    roomCode: 'WXYZ',
  });
  if (url === 'http://10.0.0.5:8080/?room=WXYZ' && svg.startsWith('<svg')) ok(`邀请二维码用的就是邀请地址：${url}`);
  else fail(`邀请二维码地址不对：${url}`);
  const qr = encode(url);
  ok(`这个邀请地址能编码（v${qr.version}，${qr.size}x${qr.size}）`);

  // 用隧道/公网地址打开时，二维码必须是公网地址（否则异地朋友扫了连不上）
  const publicOrigin = invite.inviteUrl({
    network: { urls: ['192.168.1.7'], port: 3210 },
    roomCode: 'ABCD',
    origin: 'https://silly-cats-jump-here.trycloudflare.com',
  });
  if (publicOrigin === 'https://silly-cats-jump-here.trycloudflare.com/?room=ABCD') {
    ok(`用公网地址打开时，邀请用公网地址：${publicOrigin}`);
  } else {
    fail(`公网打开时邀请地址不对（会给出局域网地址，异地朋友连不上）：${publicOrigin}`);
  }

  const lanStill = invite.inviteUrl({
    network: { urls: ['192.168.1.7'], port: 3210 },
    roomCode: 'ABCD',
    origin: 'http://localhost:3210',
  });
  if (lanStill === 'http://192.168.1.7:3210/?room=ABCD') ok('本地打开时仍然优先局域网 IP（手机扫得到）');
  else fail(`本地打开时没有优先局域网 IP：${lanStill}`);
}

// ---------------------------------------------------------------- 服务端 network 信息
if (BASE) {
  console.log('\n— 服务端给的邀请信息 —');
  const res = await fetch(`${BASE}/api/rooms`);
  const j = await res.json();
  if (j.network && Array.isArray(j.network.urls) && typeof j.network.port === 'number') {
    ok(`/api/rooms 带 network：端口 ${j.network.port}，局域网地址 ${j.network.urls.length} 个`);
    const host = j.network.urls[0] || 'localhost';
    const url = `http://${host}:${j.network.port}/?room=ABCD`;
    const qr = encode(url);
    ok(`邀请地址能编码成二维码（v${qr.version}）：${url}`);
  } else {
    fail('/api/rooms 缺少 network 字段，客户端凑不出邀请二维码');
  }
}

console.log(`\n失败 ${failures} 项`);
process.exitCode = failures ? 1 : 0;
