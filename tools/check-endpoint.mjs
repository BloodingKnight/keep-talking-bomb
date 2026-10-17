// 判断一个地址到底是"服务没起来"还是"网络/域名被拦"。
//
//   node tools/check-endpoint.mjs https://bombgame.xxx.workers.dev
//   node tools/check-endpoint.mjs https://xxx.pages.dev https://bombgame.xxx.workers.dev
//
// 会分别报告：DNS 解析、TCP 连接、TLS 握手、HTTP 响应两个阶段各自的耗时与错误，
// 这样就能区分「域名解析不了 / 连不上 / 握手被打断 / 服务返回 5xx」。
import dns from 'node:dns/promises';
import tls from 'node:tls';
import net from 'node:net';

const urls = process.argv.slice(2);
if (!urls.length) {
  console.error('用法: node tools/check-endpoint.mjs <url> [url...]');
  process.exit(1);
}

const ms = (t0) => `${Math.round(performance.now() - t0)} ms`;

async function checkOne(raw) {
  const url = new URL(raw);
  const host = url.hostname;
  console.log(`\n=== ${url.host} ===`);

  let t0 = performance.now();
  let addrs = [];
  try {
    addrs = await dns.lookup(host, { all: true });
    console.log(`  DNS      ok   ${ms(t0)}  -> ${addrs.map((a) => a.address).join(', ')}`);
  } catch (e) {
    console.log(`  DNS      失败 ${ms(t0)}  ${e.code || e.message}（域名解析不了，多半被污染/不存在）`);
    return;
  }

  const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);

  t0 = performance.now();
  const tcpOk = await new Promise((resolve) => {
    const sock = net.connect({ host: addrs[0].address, port });
    const done = (v) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(5000, () => done('timeout'));
    sock.once('connect', () => done(true));
    sock.once('error', (e) => done(e.code || 'error'));
  });
  if (tcpOk !== true) {
    console.log(`  TCP      失败 ${ms(t0)}  ${tcpOk}（连不上：典型的"被丢包/重置"）`);
    return;
  }
  console.log(`  TCP      ok   ${ms(t0)}`);

  if (url.protocol === 'https:') {
    t0 = performance.now();
    const tlsOk = await new Promise((resolve) => {
      const sock = tls.connect({ host, servername: host, port, timeout: 6000 }, () => resolve(true));
      sock.once('error', (e) => resolve(e.code || e.message));
      sock.once('timeout', () => resolve('timeout'));
      sock.once('close', () => resolve('closed'));
    });
    if (tlsOk !== true) {
      console.log(`  TLS      失败 ${ms(t0)}  ${tlsOk}（握手被打断：SNI 级封锁的典型表现）`);
      return;
    }
    console.log(`  TLS      ok   ${ms(t0)}`);
  }

  t0 = performance.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const body = await res.text();
    console.log(`  HTTP     ${res.status} ${ms(t0)}  ${body.length} 字节`);
    if (res.ok) console.log('  结论：这个地址从当前网络**可以访问**');
  } catch (e) {
    console.log(`  HTTP     失败 ${ms(t0)}  ${e.code || e.message}`);
  }
}

for (const u of urls) await checkOne(u);
