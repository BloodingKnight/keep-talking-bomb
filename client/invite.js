// 邀请链接 / 邀请二维码。抽成独立模块是为了能直接单测（不依赖 DOM）。
import { encode, toSvg } from './qr.js';

/**
 * 拼邀请地址：
 *   1. 如果当前页面本身就是公网地址（隧道 / 云主机），就用它 —— 这样二维码对异地朋友也有效；
 *   2. 否则优先用服务端探测到的局域网 IP（手机扫这个才连得上）；
 *   3. 都拿不到就退回当前页面地址（本机自测时是 localhost）。
 *
 * @param {{network?: {urls?: string[], port?: number}, roomCode: string, origin?: string, port?: string|number}} o
 */
export function inviteUrl(o) {
  const net = (o && o.network) || {};
  const origin = o.origin || '';
  const lan = Array.isArray(net.urls) && net.urls.length ? net.urls[0] : null;
  const port = net.port || o.port || 3210;

  // 静态托管（EdgeOne / Pages）时，页面所在域不是房主机器，
  // 邀请链接必须把房主地址一起带上，否则朋友打开后连不上。
  const serverParam = o.server ? `&server=${encodeURIComponent(o.server)}` : '';

  if (origin && !isLocalHost(hostOf(origin))) {
    return `${origin}/?room=${o.roomCode}${serverParam}`;
  }
  const base = lan ? `http://${lan}:${port}` : origin || `http://localhost:${port}`;
  return `${base}/?room=${o.roomCode}${serverParam}`;
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function isLocalHost(host) {
  if (!host) return true;
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host)
  );
}

/** 直接给出邀请二维码的 SVG 字符串 */
export function inviteQrSvg(o) {
  const url = inviteUrl(o);
  return { url, svg: toSvg(encode(url), { scale: o.scale || 5, quiet: o.quiet === undefined ? 2 : o.quiet }) };
}
