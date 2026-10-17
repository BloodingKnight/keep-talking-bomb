// 邀请链接 / 邀请二维码。抽成独立模块是为了能直接单测（不依赖 DOM）。
import { encode, toSvg } from './qr.js';

/**
 * 拼邀请地址：优先用服务端探测到的局域网 IP —— 手机扫的是这个才连得上；
 * 拿不到局域网地址时退回当前页面地址（本机自测时就是 localhost）。
 *
 * @param {{network?: {urls?: string[], port?: number}, roomCode: string, origin?: string, port?: string|number}} o
 */
export function inviteUrl(o) {
  const net = (o && o.network) || {};
  const lan = Array.isArray(net.urls) && net.urls.length ? net.urls[0] : null;
  const port = net.port || o.port || 3210;
  const base = lan ? `http://${lan}:${port}` : o.origin || `http://localhost:${port}`;
  return `${base}/?room=${o.roomCode}`;
}

/** 直接给出邀请二维码的 SVG 字符串 */
export function inviteQrSvg(o) {
  const url = inviteUrl(o);
  return { url, svg: toSvg(encode(url), { scale: o.scale || 5, quiet: o.quiet === undefined ? 2 : o.quiet }) };
}
