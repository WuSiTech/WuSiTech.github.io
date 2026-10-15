# 吾思 梦阁

[![Build and deploy](https://github.com/WuSiTech/WuSiTech.github.io/actions/workflows/hugo.yaml/badge.svg?branch=main)](https://github.com/WuSiTech/WuSiTech.github.io/actions/workflows/hugo.yaml)

Hugo + [reimu](https://github.com/D-Sketon/hugo-theme-reimu) 主题的个人博客。

同一份源码同时部署到两个站点，各自有**指向自己域名**的 `sitemap.xml` 与 `robots.txt`：

| 站点 | 地址 | 部署方式 |
| ---- | ---- | -------- |
| GitHub Pages | https://wusitech.github.io/ | `.github/workflows/hugo.yaml`，推送到 `main` 后自动构建部署 |
| Cloudflare Pages | https://wstk.pages.dev/ | Cloudflare Pages 的 Git 集成（构建命令见下） |

原理：Hugo 用 `baseURL` 生成 sitemap / robots.txt / `og:url` 的**绝对地址**，
两个平台的构建各自传入自己的域名即可，源码不需要任何分叉。

## 后台与评论

- **写作后台**：https://wusitech.github.io/admin/ —— Sveltia CMS，用 GitHub 账号登录，
  手机上也能写；保存即提交到 `main` 并自动构建部署，文章仍然是仓库里的 Markdown。
  - 想**马上用**：点「使用访问令牌登录」，粘一个只对该仓库可读写的 GitHub 令牌即可（零配置，2 分钟）
  - 想**长期省事**：按部署指南配一个免费的 Cloudflare Worker 登录中转，之后点一下按钮就登录
- **评论**：Twikoo（前端已自托管在 `static/resources/`，不请求任何第三方 CDN）。
- 两者的完整配置步骤（GitHub OAuth App、Cloudflare Worker、Netlify + MongoDB Atlas）见
  [docs/后台与评论部署指南.md](docs/后台与评论部署指南.md)。
- 站点配置（菜单、首页分类、主题参数）**不在后台内**，仍直接编辑
  `config/_default/params.yml`（原因见部署指南）。

## 首次克隆（必须带上子模块）

主题是 git submodule，**不拉子模块会构建失败**（报 `shortcode "friendsLink" not found`）：

```bash
git clone --recurse-submodules https://github.com/WuSiTech/WuSiTech.github.io.git

# 已经克隆过、但 themes/reimu 是空目录的话：
git submodule update --init --recursive
```

## 本地开发与构建

```bash
hugo server -D                 # 本地预览（含草稿），http://localhost:1313
hugo --minify                  # 构建到 public/，使用 hugo.toml 里的 baseURL
hugo --minify --baseURL https://wstk.pages.dev/     # 想本地预览 Cloudflare 效果时
```

也可以直接用仓库里的 `Manage.bat`（新建文章 / 预览 / 构建 / 推送）。

## 部署

### GitHub Pages（全自动）

推送到 `main` 触发 `.github/workflows/hugo.yaml`：安装 Hugo Extended →
`hugo --minify --baseURL "<Pages URL>"` → 上传 artifact → 部署。
sitemap 与 robots.txt 自动使用 `https://wusitech.github.io/`。

**构建状态**看顶部那枚徽章：

- `passing`：最近一次 `main` 构建并部署成功；
- `failing`：点徽章进 [Actions 日志](https://github.com/WuSiTech/WuSiTech.github.io/actions/workflows/hugo.yaml)
  排查（常见原因：Front Matter 语法、主题子模块没拉下来、Hugo 版本变更）。

徽章对应的地址是
`https://github.com/WuSiTech/WuSiTech.github.io/actions/workflows/hugo.yaml/badge.svg?branch=main`，
工作流改名或换文件后记得一起改。

### Cloudflare Pages

Cloudflare Dashboard → Workers & Pages → 该项目 → Settings → Builds & deployments：

- **Build command**（自己装 Hugo Extended，版本与 CI 保持一致）：

  ```bash
  curl -sfL -o /tmp/hugo.tar.gz https://github.com/gohugoio/hugo/releases/download/v0.166.0/hugo_extended_0.166.0_linux-amd64.tar.gz \
    && tar -xzf /tmp/hugo.tar.gz -C /tmp hugo \
    && git submodule update --init --recursive \
    && /tmp/hugo --minify --baseURL https://wstk.pages.dev/
  ```

  如果 Cloudflare 的构建镜像已经自带 Extended Hugo，可简化为：

  ```bash
  git submodule update --init --recursive && hugo --minify --baseURL https://wstk.pages.dev/
  ```

- **Build output directory**：`public`
- **环境变量（可选）**：`HUGO_VERSION = 0.166.0`、`TZ = Asia/Shanghai`

这样 Cloudflare 上的 `sitemap.xml` / `robots.txt` 会自动使用 `https://wstk.pages.dev/`。

## sitemap 与搜索引擎收录

- `sitemap.xml`：Hugo 内建生成，每次构建自动更新，包含所有页面（草稿自动排除）和 `<lastmod>`。
- `robots.txt`：由 [`layouts/robots.txt`](layouts/robots.txt) 生成，`Sitemap:` 行用 `absURL`，
  因此自动跟随当前站点的域名。
- 收录：在两个域名各自提交一次 sitemap 即可（Google Search Console / Bing Webmaster Tools / 百度搜索资源平台），
  之后每次部署都会自动更新，无需再手动操作。
- 两个域名内容相同（互为镜像），搜索引擎会各自独立收录；如果只想让其中一个被索引，
  可在 Cloudflare 侧加 `static/_headers`：

  ```
  /*
    X-Robots-Tag: noindex
  ```

## 目录约定

- `content/posts/`：文章（`mainSections = ["posts"]`）
- `config/_default/params.yml`：主题参数（菜单、代码高亮、注入的样式/脚本等）
- `layouts/_default/_markup/render-image.html`：文章图片渲染（懒加载 + 灯箱）
- `layouts/robots.txt`：robots.txt 模板
- `static/images/`、`static/avatar/`：图片资源
- `static/admin/`：写作后台页面（Sveltia CMS，入口 `/admin/`）
- `static/resources/`：主题 vendor 库的本地副本（twikoo 评论前端、lazysizes、photoswipe 等 41 个）
- `data/vendor.yml`：vendor 库走 CDN 还是本地（**整文件覆盖主题那份**）。
  现在已全部切成本地（`local|`），页面不请求任何第三方 CDN；
  主题升级后建议：重新复制主题那份 → 跑 `python tools/localize_vendor.py` 一键再本地化。
- `data/covers.yml`：随机封面池（覆盖主题默认那份，主题默认指向 `d-sketon.top` 外链，已换成本站图片）
- `docs/`：部署指南等文档
- `tools/`：docx→Markdown、图片转 WebP、后台登录中转 Worker、vendor 本地化脚本
- `public/`、`resources/`、`.verify*/` 均为构建产物，已在 `.gitignore` 中忽略
