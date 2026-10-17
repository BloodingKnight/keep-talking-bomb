// 跨域（CORS）测试：静态托管版的客户端会从别的域直接调这些接口。
//
//   node tests/cors.mjs http://127.0.0.1:3210
//
// 检查点：
//   1. OPTIONS 预检返回 204，且带 Access-Control-Allow-* 头
//   2. POST /api/create 带 Origin 时能成功，并且回显 ACAO
//   3. GET /api/events（SSE）带 Origin 时也能带 ACAO（否则浏览器里订阅会被拦）
import path from 'node:path';

const BASE = process.argv[2] || 'http://127.0.0.1:3210';
const ORIGIN = 'https://demo.edgeone.app';

let failures = 0;
const ok = (m) => console.log('  ✓ ' + m);
const fail = (m) => {
  failures++;
  console.log('  ✗ ' + m);
};

console.log(`— 跨域检查 ${BASE}（假装页面在 ${ORIGIN}）—`);

// 1) 预检
{
  const res = await fetch(`${BASE}/api/create`, {
    method: 'OPTIONS',
    headers: { origin: ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
  });
  const acao = res.headers.get('access-control-allow-origin');
  const acam = res.headers.get('access-control-allow-methods') || '';
  if (res.status === 204) ok('OPTIONS 预检返回 204');
  else fail(`预检状态码应为 204，实际 ${res.status}`);
  if (acao === ORIGIN) ok(`回显 Access-Control-Allow-Origin: ${acao}`);
  else fail(`Access-Control-Allow-Origin 不对：${acao}`);
  if (/POST/.test(acam)) ok(`允许 POST（${acam}）`);
  else fail(`Access-Control-Allow-Methods 里没有 POST：${acam}`);
}

// 2) 真实 POST
{
  const res = await fetch(`${BASE}/api/create`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'CORS 房主' }),
  });
  const j = await res.json().catch(() => ({}));
  if (res.ok && j.roomCode && j.playerId) ok(`POST /api/create 成功（房间 ${j.roomCode}）`);
  else fail(`POST /api/create 失败：${res.status} ${JSON.stringify(j)}`);
  if (res.headers.get('access-control-allow-origin') === ORIGIN) ok('POST 响应带 ACAO（浏览器才会放行）');
  else fail('POST 响应没有 ACAO，浏览器会拦掉');

  // 3) SSE
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 4000);
  try {
    const es = await fetch(
      `${BASE}/api/events?room=${encodeURIComponent(j.roomCode)}&player=${encodeURIComponent(j.playerId)}`,
      { headers: { origin: ORIGIN, accept: 'text/event-stream' }, signal: ac.signal },
    );
    const ct = es.headers.get('content-type') || '';
    const acao = es.headers.get('access-control-allow-origin');
    if (es.ok && /event-stream/.test(ct)) ok(`SSE 返回 ${ct}`);
    else fail(`SSE 返回不对：${es.status} ${ct}`);
    if (acao === ORIGIN) ok('SSE 响应带 ACAO（跨域也能订阅）');
    else fail('SSE 响应没有 ACAO，跨域订阅会被拦');
  } catch (e) {
    if (String(e.name) === 'AbortError') ok('SSE 已连上（4 秒后主动断开，符合预期）');
    else fail(`SSE 连接失败：${e.message}`);
  } finally {
    clearTimeout(timer);
  }
}

console.log(`\n失败 ${failures} 项`);
process.exitCode = failures ? 1 : 0;
