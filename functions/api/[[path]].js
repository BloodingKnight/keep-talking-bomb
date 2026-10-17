// Pages Functions：把 /api/* 反代到真正的游戏服务端。
//
// 为什么需要它：`*.workers.dev` 在国内被墙（实测 TCP 直接超时），但 `*.pages.dev` 是通的。
// Pages Functions 运行在 Cloudflare 边缘，由它去取 workers.dev 属于机房内部网络，不受影响；
// 于是浏览器只需要访问 pages.dev 这一个域名，游戏就完整可用了。
//
// 目标地址的优先级：
//   1. 环境变量 GAME_ORIGIN（Pages 项目 Settings -> Variables and Secrets 里配）
//   2. 下面的 DEFAULT_ORIGIN
//
// 这个前门指向什么都行：
//   · Cloudflare Worker（wrangler deploy 出来的 https://bombgame.<子域>.workers.dev）
//   · 自己的云主机（https://bomb.mydomain.com）
//   · 甚至家里的电脑 + 内网穿透（只要 CF 边缘能访问到）
const DEFAULT_ORIGIN = 'https://bombgame.example.workers.dev';

const PASS_HEADERS = ['content-type', 'accept', 'x-admin-token'];

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  const origin = (env.GAME_ORIGIN || DEFAULT_ORIGIN).replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(origin)) {
    return json({ error: 'GAME_ORIGIN 没配成一个 http(s) 地址' }, 500);
  }

  const target = `${origin}${url.pathname}${url.search}`;
  const headers = new Headers();
  for (const key of PASS_HEADERS) {
    const v = request.headers.get(key);
    if (v) headers.set(key, v);
  }
  // 把真实来源带上，方便服务端日志/排查
  headers.set('x-forwarded-host', url.host);
  headers.set('x-forwarded-proto', url.protocol.replace(':', ''));

  const isSSE = url.pathname.endsWith('/events');
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';

  const init = {
    method: request.method,
    headers,
    // SSE 必须流式转发，绝不能先 buffer
    redirect: 'manual',
  };
  if (hasBody) {
    init.body = request.body;
    // 流式 body 必须显式声明 duplex，否则 fetch 直接抛
    // "RequestInit: duplex option is required when sending a body."
    init.duplex = 'half';
  }

  let upstream;
  try {
    upstream = await fetch(target, init);
  } catch (e) {
    return json(
      {
        error: '连不上游戏服务端',
        origin,
        detail: String(e && e.message ? e.message : e),
        hint:
          url.pathname.endsWith('/api/rooms')
            ? '如果这是第一次部署：确认 GAME_ORIGIN 指向的 Worker/云主机已经在跑。'
            : undefined,
      },
      502,
    );
  }

  const outHeaders = new Headers();
  const ct = upstream.headers.get('content-type') || 'application/json; charset=utf-8';
  outHeaders.set('content-type', ct);
  outHeaders.set('cache-control', isSSE ? 'no-store' : 'no-store');
  if (isSSE) {
    outHeaders.set('x-accel-buffering', 'no');
    outHeaders.set('connection', 'keep-alive');
  }
  return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
