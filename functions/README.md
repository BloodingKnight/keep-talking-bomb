# Pages Functions：/api/* 反代到游戏服务端（见 functions/api/[[path]].js）
#
# 部署方式（Cloudflare Pages 连 GitHub）：
#   构建命令: node tools/build-static-site.mjs
#   输出目录: site
#   然后在 Pages 项目的 Settings -> Variables and Secrets 里加（可选）：
#     GAME_ORIGIN = https://bomb.mifan.eu.cc
#   不配也行 —— 代码里的 DEFAULT_ORIGIN 已经默认指向 https://bomb.mifan.eu.cc
#
# 这样浏览器只访问 <项目>.pages.dev 一个域名：
#   · 静态页面由 Pages 提供
#   · /api/* 由 Pages Function 在边缘反代到真正的服务端（国内直连 workers.dev 会被墙，
#     但边缘机房之间不受影响）
#
# 若你的 Pages 项目需要绑定其它资源（KV/D1），可在此文件里补充 bindings。
