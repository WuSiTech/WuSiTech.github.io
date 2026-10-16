# 吾思 梦阁

[![Build and deploy](https://github.com/WuSiTech/WuSiTech.github.io/actions/workflows/hugo.yaml/badge.svg?branch=main)](https://github.com/WuSiTech/WuSiTech.github.io/actions/workflows/hugo.yaml)
[![Tools and config checks](https://github.com/WuSiTech/WuSiTech.github.io/actions/workflows/tools.yml/badge.svg?branch=main)](https://github.com/WuSiTech/WuSiTech.github.io/actions/workflows/tools.yml)

Hugo + [reimu](https://github.com/D-Sketon/hugo-theme-reimu) 主题的个人博客。

同一份源码同时部署到两个站点，各自有**指向自己域名**的 `sitemap.xml` 与 `robots.txt`：

| 站点 | 地址 | 部署方式 |
| ---- | ---- | -------- |
| GitHub Pages | https://wusitech.github.io/ | `.github/workflows/hugo.yaml`，推送到 `main` 后自动构建部署 |
| Cloudflare Pages | https://wstk.pages.dev/ | Cloudflare Pages 的 Git 集成（构建命令见下），并承载评论提交接口 |

原理：Hugo 用 `baseURL` 生成 sitemap / robots.txt / `og:url` 的**绝对地址**，两个平台的构建各自传入自己的域名即可，源码不需要任何分叉。

## 硬性约束：运行时不请求任何外部资源

页面里不出现任何境外/第三方资源请求（被墙即整块功能失效）。这条约束由 CI 里的 `tools/check_site.py` 守住，它检查四项：

1. 站内引用是否存在（断链）
2. **会真正请求的外部资源**（必须为 0）
3. sitemap 是否指向不存在的页面
4. 首页导航链接是否缺失

达成方式：

- 主题 vendor 库全部本地化（`data/vendor.yml` 全部 `local|`，副本在 `static/resources/`，共 41 个）
- 随机封面池 `data/covers.yml` 用本站图片（主题默认指向作者服务器）
- 页面底部的「BLOG状态」徽章用 `static/badges/*.svg` 本地镜像，而不是外链 GitHub 图片
- 图中/正文里的第三方图片一律下载进 `static/images/` 后引用

## 写作后台（Sveltia CMS）

入口：https://wusitech.github.io/admin/

- **登录**：GitHub OAuth（中转服务在 `tools/cms-oauth-worker/`，部署在 Cloudflare Worker 上）；也支持「访问令牌登录」（细粒度令牌，零配置）
- **集合**：
  - 文章 / 页面：`content/` 下的 Markdown，保存即提交 `main` 并自动部署
  - 评论：管理已发布的评论（隐藏 / 删除 / 以「博主」身份回复）
  - 站点设置：作者信息、菜单、首页分类卡片（对应 `config/_default/params.toml`）
  - 站点文案：导航文案（i18n 键值），可自助增加栏目
- **媒体库**：根目录 `static/images`，插入路径自动写成 `/images/...`；外链图库（Pexels / Pixabay / Unsplash / Lorem Picsum）已全部关闭
- **图片转 WebP**：后台上传后由 `.github/workflows/webp.yml` 自动转换（含改写引用、删除原图）；本地也可用 `tools/img2webp.py` 先转再传
- ⚠️ **不要**在 `static/admin/config.yml` 里写 `media_libraries.*.config.transformations`：写法不符 schema 会导致**整个后台打不开**（曾踩过）

配置步骤见 [docs/后台与评论部署指南.md](docs/后台与评论部署指南.md)。

## 评论（自建，数据存在 Git 仓库里）

不用第三方评论服务，评论数据就是仓库里的 JSON：

- **数据**：`static/comments/posts/<文章路径>.json`（每篇文章一个文件，Git 历史即版本记录，`git clone` 即全量备份）
- **读取**：页面读静态文件，默认固定从 `https://wstk.pages.dev` 取（两个域名显示一致），取不到时回退同域
- **提交**：Cloudflare Pages Function `functions/api/comment.js`（跑在 `wstk.pages.dev`），跨域由 `static/_headers` 给 `/comments/*` 加 CORS 头
- **审核**：默认写入 `hidden: true`（待审），页面不显示；站长在后台「评论」里取消「隐藏」即发布（也可以直接改 JSON）
- **防刷**：隐藏字段蜜罐 + 同 IP 频率限制 + 正文链接数上限；被文章引用的图片不允许删除
- 细节与故障排查见 [docs/评论系统（Git存储）.md](docs/评论系统（Git存储）.md)

## 页面底部的「BLOG状态」徽章

放在**页脚**里（站点级覆盖 `layouts/partials/footer.html`），内容是「BLOG状态」加两张徽章图：

- 图片是 `static/badges/*.svg`，从 GitHub 官方徽章**镜像**而来 → 视觉与 README 顶部一致，但不产生外链请求
- 每次构建前由 `.github/scripts/fetch_badges.py` 重新下载刷新（失败不影响构建，用仓库里那份）
- 改工作流文件名后，这几处要一起改：`static/badges/` 的两个文件名、`.github/scripts/fetch_badges.py`、`layouts/partials/footer.html`、README 顶部徽章
- 明细见 [docs/构建状态挂件.md](docs/构建状态挂件.md)

## 侧边栏

- widget 列表在 `config/_default/params.yml` 的 `widgets:`（当前：`category`、`tagcloud`、`recent_posts`）
- 主题默认只在非文章页渲染 widget；本站用站点级覆盖 `layouts/partials/sidebar.html` 让**文章页也显示**，同时保留目录
- 相关参数：`tagcloud_limits`、`category_limits`、`recent_posts_limits`

## 首次克隆（必须带上子模块）

主题是 git submodule，**不拉子模块会构建失败**（报 `shortcode "friendsLink" not found`）：

```bash
git clone --recurse-submodules https://github.com/WuSiTech/WuSiTech.github.io.git

# 已经克隆过、但 themes/reimu 是空目录的话：
git submodule update --init --recursive
```

## 本地开发、构建与自检

```bash
hugo server -D                                     # 本地预览（含草稿），http://localhost:1313
hugo --minify                                      # 构建到 public/
hugo --minify --baseURL https://wstk.pages.dev/     # 预览 Cloudflare 域名下的效果

# 与 CI 一致的检查
python tools/check_site.py --dir public             # 断链 / 外部资源 / sitemap / 首页导航
python tools/test_auto_webp.py                      # 图片转 WebP 的规则自测
python tools/test_rename_image.py                   # 改名/移动并改写引用的自测

# 预览产物（推荐；直接双击 index.html 会因为绝对路径导致样式不加载）
python -m http.server 8799 --directory public
```

也可以直接用仓库里的 `Manage.bat`（新建文章 / 预览 / 构建 / 推送）。

## 部署

### GitHub Pages（全自动）

推送到 `main` 触发 `.github/workflows/hugo.yaml`：镜像徽章 → 安装 Hugo Extended → `hugo --minify --baseURL "<Pages URL>"` → 上传 artifact → 部署。
`main` 分支不要开「Require a pull request before merging」：后台与评论提交都是直接写 `main`，开了会一起失效。

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
- **环境变量**：`HUGO_VERSION = 0.166.0`、`TZ = Asia/Shanghai`、`GITHUB_TOKEN`（评论提交用，细粒度：Contents 读写 + Pull requests 读写）、`COMMENT_MODE`（`direct` 即"直接提交 + 默认待审"）、`COMMENT_PENDING`（留空即待审）
- `functions/` 目录会被 Cloudflare Pages 自动识别为 Functions，构建命令不用额外处理

## CI 工作流

| 工作流 | 做什么 |
| ------ | ------ |
| `.github/workflows/hugo.yaml` | 镜像徽章（`fetch_badges.py`）→ Hugo 构建 → 部署 GitHub Pages |
| `.github/workflows/tools.yml` | Python 工具语法检查与 `--help` 冒烟、mock 自测、vendor 不得回退外部 CDN、Hugo 构建产物四项校验、OAuth Worker 自测 |
| `.github/workflows/webp.yml` | `static/images/**` 有新增位图时，自动转 WebP、改写引用、删除原图并提交（带 `[skip ci]`，会自己补一次部署） |

经验：工作流里**点名引用的每个脚本都必须存在**。删改脚本时同步检查三个 workflow 的引用（曾多次因为残留引用让 CI 变红）。

## 工具脚本（`tools/`）

| 脚本 | 用途 |
| ---- | ---- |
| `tools/docx2md.py` | Word → Markdown |
| `tools/img2webp.py` | 图片转 WebP / 压缩（`-q`、`--target-kb`、`--max-dim`、`--inplace`） |
| `tools/auto_webp.py` | CI 用：把新增位图转 WebP 并改写引用；`--all` 可处理存量图片（会跳过主题素材） |
| `tools/rename_image.py` | 图片改名 / 移目录，并同步改写文章、配置、data 里的引用（**默认 dry-run**，需 `--apply`） |
| `tools/check_site.py` | 构建产物校验（断链 / 外部资源 / sitemap / 首页导航），CI 与本地都用它 |
| `tools/check_twikoo.py` | 评论后端体检（非当前方案，保留备用） |
| `tools/localize_vendor.py` | vendor 本地化：把 `data/vendor.yml` 的 CDN 项改成本地路径（`--dry-run`、`--strict`） |
| `tools/cms-oauth-worker/worker.js` | 后台 GitHub OAuth 登录中转（Cloudflare Worker），自测在 `test.mjs` |

示例：

```bash
python tools/img2webp.py 图片目录 -r -q 78 --max-dim 1600     # 批量压缩转 WebP
python tools/auto_webp.py --all                                # 存量图片一次性转 WebP（dry-run，加 --apply 落盘）
python tools/rename_image.py static/images/a.png static/images/sub/a.webp --apply
python tools/localize_vendor.py --dry-run --strict             # 检查有没有 vendor 回退到外部 CDN
```

## 配置分工（容易踩的坑）

- `config/_default/params.yml`：主配置（菜单、代码高亮、`injector`、评论开关等）
- `config/_default/params.toml`：Hugo 会把两者**合并**到同一个 `params` 下；后台「站点设置」只写这个文件
  - ⚠️ TOML 里表名**不要写 `params.` 前缀**：文件本身已等价于 `params`，写 `[menu]` 才是 `params.menu`
- `injector.body_begin` / `injector.body_end` 里是**纯文本**，Hugo **不执行**其中的 `{{ ... }}` 模板语法（需要动态内容要用 output format 或 partial）

## 目录约定

- `content/posts/`：文章（`mainSections = ["posts"]`）
- `content/posts/_index.md`：栏目首页（`/posts/`），配合站点级 `layouts/posts/section.html`
- `config/_default/params.yml`、`params.toml`：见上「配置分工」
- `layouts/partials/footer.html`、`layouts/partials/sidebar.html`：站点级覆盖（徽章 / 文章页 widget）
- `layouts/_default/_markup/render-image.html`：文章图片渲染（懒加载 + 灯箱）
- `layouts/robots.txt`：robots.txt 模板
- `functions/api/comment.js`：评论提交接口（Cloudflare Pages Function）
- `static/comments/`：评论数据（每篇文章一个 JSON）
- `static/images/`：图片资源（后台媒体库根目录）
- `static/badges/`：GitHub 徽章的本地镜像
- `static/admin/`：写作后台（Sveltia CMS，入口 `/admin/`）
- `static/resources/`：主题 vendor 库的本地副本
- `data/vendor.yml`、`data/covers.yml`：覆盖主题的 vendor 表与随机封面池（**整文件覆盖**，不是深合并）
- `docs/`：文档（见下）
- `tools/`：脚本（见上）
- `public/`、`resources/`、`.verify*/`：构建产物，已在 `.gitignore` 中忽略

## 文档索引

| 文档 | 内容 |
| ---- | ---- |
| [docs/后台与评论部署指南.md](docs/后台与评论部署指南.md) | 后台登录（OAuth Worker / 令牌）、评论后端、常见故障 |
| [docs/评论系统（Git存储）.md](docs/评论系统（Git存储）.md) | 自建评论的架构、三种模式、后台放行流程、备份与排查 |
| [docs/图片与媒体库操作说明.md](docs/图片与媒体库操作说明.md) | 删图 / 改名移目录 / 三种转 WebP 方式 / 已知限制 |
| [docs/构建状态挂件.md](docs/构建状态挂件.md) | 页脚徽章的实现、CI 刷新、踩坑记录 |
| [docs/升级与维护注意事项.md](docs/升级与维护注意事项.md) | 主题升级、构建告警说明、版本矩阵 |

## 注意事项与已知限制

- **覆盖了主题模板**（`layouts/partials/footer.html`、`layouts/partials/sidebar.html`、`layouts/posts/section.html`）：主题升级后这些文件可能需要跟着同步
- 后台保存会**重写整个文件**（`params.toml`、评论 JSON）：CMS 不保留注释，属正常现象；评论字段必须与 `static/admin/config.yml` 声明一致
- `.gitattributes` 统一为 LF，Windows 上提交会看到 `CRLF will be replaced by LF` 提示，属正常
- Windows 控制台默认 GBK，脚本输出的中文可能显示乱码，但功能与退出码正常
- 已知的非阻塞告警（构建时 3 条）：`covers.yml` / `friends.yml` 数据覆盖提示、主题使用已弃用的 libsass
- 主题的看板娘 `live2d` 默认关闭；若打开，资源来自 `fastly.jsdelivr.net`，国内可能不通（需要时再单独本地化）
