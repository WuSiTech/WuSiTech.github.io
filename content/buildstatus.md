---
# 这个页面不在网站上以 HTML 形式出现，只用来触发 /build-status.json 的生成。
# 说明见 docs/构建状态挂件.md：
#   - outputs 触发 config/_default/hugo.yml 里定义的 buildstatus 输出格式
#   - build.list: never 让它不出现在首页 / 归档 / RSS 等列表里
#     （Hugo 0.145+ 用 build，旧写法 _build 已移除）
#   - url 指定产物路径（输出格式的 baseName 决定文件名 build-status.json）
title: Build status data
private: true
sitemap:
  disable: true
outputs:
  - buildstatus
build:
  render: always
  list: never
url: /build-status.json
---
