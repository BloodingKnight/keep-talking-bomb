# 公网部署（想发个链接给异地朋友玩时用这个）
#
#   docker build -t bombsite .
#   docker run -d --name bombsite -p 3210:3210 -e BOMB_ADMIN_TOKEN=换成你的令牌 bombsite
#
# 说明：
#  - 房间状态存在内存里，所以只能跑 1 个实例（多副本之间不共享房间）；
#  - 服务端读 PORT 环境变量，Render / Railway / Fly / Zeabur 这类平台会自动注入；
#  - 平台一般会帮你上 HTTPS，写在反向代理后面时 SSE 也能正常工作（本服务已发 no-cache，
#    并每 1 秒推一次心跳，不会被中间层轻易掐断）。
FROM node:22-alpine

WORKDIR /app

# 只拷贝运行需要的东西（不带测试、工具、打包产物）
COPY package.json README.md ./
COPY server ./server
COPY lib ./lib
COPY client ./client

ENV NODE_ENV=production
EXPOSE 3210

# 建议用 -e BOMB_ADMIN_TOKEN=... 固定管理令牌，否则每次重启都变
CMD ["node", "server/server.js"]
