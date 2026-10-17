import {
  DIFFICULTIES,
  DIFFICULTY_ORDER,
  ROLE_INFO,
  EXTRA_EXPERT_ROLES,
  ROLE_PRESETS,
} from '../../lib/vocab.js';

export { RoomDurableObject } from './room-do.js';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉易混淆的 I O 0 1
const CODE_LEN = 4;

function newCode() {
  const bytes = new Uint8Array(CODE_LEN);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += CODE_CHARS[b % CODE_CHARS.length];
  return out;
}

/** 跨域头：静态客户端可以放在 Pages / EdgeOne / 任何 CDN 上，API 打到这里 */
function corsHeaders(origin) {
  if (!origin) return {};
  return {
    'access-control-allow-origin': origin,
    vary: 'Origin',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
  };
}

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
  });
}

function roomCodeOf(url, body) {
  return String(body?.room || url.searchParams.get('room') || '').toUpperCase();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('origin');
    const CORS = corsHeaders(origin);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const path = url.pathname;

    // ---------------- 目录（难度/角色/预置）：纯静态数据，不会过期
    if (path === '/api/rooms') {
      return json(
        {
          rooms: [], // Workers 是无状态的，房间分散在各个 DO 里；列表可留空，加入用房间号
          difficulties: DIFFICULTY_ORDER.map((d) => ({ id: d, ...DIFFICULTIES[d] })),
          roles: Object.values(ROLE_INFO).concat(EXTRA_EXPERT_ROLES),
          presets: ROLE_PRESETS,
          network: { port: 443, urls: [url.hostname] },
        },
        200,
        CORS,
      );
    }

    // ---------------- 建房：先分配房间号，再交给对应的 DO
    if (path === '/api/create') {
      const body = await request.json().catch(() => ({}));
      for (let attempt = 0; attempt < 6; attempt++) {
        const code = newCode();
        const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
        const res = await stub.fetch(`https://room/create?code=${code}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (res.status === 409) continue; // 撞号了，换一个
        const data = await res.json().catch(() => ({}));
        return json(data, res.status, CORS);
      }
      return json({ error: '房间号分配失败，请重试' }, 503, CORS);
    }

    // ---------------- 其余 /api/* 全部转给对应的房间 DO
    if (path.startsWith('/api/')) {
      let body = null;
      if (request.method === 'POST') {
        body = await request.json().catch(() => ({}));
      }
      const code = roomCodeOf(url, body);
      if (!code) return json({ error: '缺少房间号' }, 400, CORS);

      const route = path.slice('/api/'.length); // join / state / action / events
      const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
      const target = `https://room/${route}?room=${encodeURIComponent(code)}`;
      const init = {
        method: request.method,
        headers: { 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      };
      const res = await stub.fetch(target, init);

      // SSE 要原样透传流，不能先读成文本
      if ((res.headers.get('content-type') || '').includes('text/event-stream')) {
        const headers = new Headers(res.headers);
        for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
        return new Response(res.body, { status: res.status, headers });
      }

      const text = await res.text();
      return new Response(text, {
        status: res.status,
        headers: { 'content-type': res.headers.get('content-type') || 'application/json', 'cache-control': 'no-store', ...CORS },
      });
    }

    // ---------------- 其它请求交给静态资源（wrangler 的 [assets] 绑定）
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return json(
      {
        error: '静态资源没有绑定',
        hint: '先跑 node tools/build-static-site.mjs 生成 site/，再在 wrangler.toml 里配置 [assets] directory = "../site"',
      },
      404,
    );
  },
};
