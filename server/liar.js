// 骗子酒馆的服务端实例：房间号 / 玩家 id 用 Node 的加密随机数生成，
// 规则状态机在 lib/liars.js（零依赖，Cloudflare / 测试也能直接用）。
//
// HTTP 路由和 SSE 广播放在 server/server.js，和拆弹游戏共用同一个端口。

import crypto from 'node:crypto';
import { LiarGame, LIAR_RULES } from '../lib/liars.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉易混淆的 I O 0 1

function makeCode(len = 4) {
  let out = '';
  const bytes = crypto.randomBytes(len);
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

export const liarGame = new LiarGame({
  makeId: () => crypto.randomBytes(9).toString('base64url'),
  makeCode,
});

export { LIAR_RULES };
