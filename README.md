# 吾思 梦阁

[![Build and deploy](https://github.com/WuSiTech/WuSiTech.github.io/actions/workflows/hugo.yaml/badge.svg?branch=main)](https://github.com/WuSiTech/WuSiTech.github.io/actions/workflows/hugo.yaml)
[![Tools and config checks](https://github.com/WuSiTech/WuSiTech.github.io/actions/workflows/tools.yml/badge.svg?branch=main)](https://github.com/WuSiTech/WuSiTech.github.io/actions/workflows/tools.yml)

Hugo 静态博客，主题 [reimu](https://github.com/D-Sketon/hugo-theme-reimu) 以 **git submodule** 形式放在
`themes/reimu/`（当前 `246177b`，v0.16.1-2-g246177b）。主题目录里的文件一律不改（升级会被冲掉），
本站所有定制都走**站点级覆盖**：`layouts/`、`config/`、`data/`、`i18n/`、`static/`。

同一份源码同时部署到两个站点，各自有**指向自己域名**的 `sitemap.xml` 与 `robots.txt`：

| 站点 | 地址 | 部署方式 |
| ---- | ---- | -------- |
| GitHub Pages | https://wusitech.github.io/ | `.github/workflows/hugo.yaml`，推送到 `main` 后自动构建部署 |
| Cloudflare Pages | https://wstk.pages.dev/ | Cloudflare Pages 的 Git 集成（构建命令见下），并承载评论提交接口 `functions/api/comment.js` |

原理：Hugo 用 `baseURL` 生成 sitemap / robots.txt / `og:url` 的**绝对地址**，
两个平台的构建各自传入自己的域名即可，源码不需要任何分叉。

## 硬性约束：运行时不请求任何外部资源

站点上跑起来以后**不向任何站外地址发请求**（被墙的、境外的资源一律本地化）。
这条约束由 `tools/check_site.py` 在 CI（`tools.yml` 的 build job）里守，它检查四项：

1. 站内引用（`img` 的 `src`/`data-src`、`a` 的 `href`、`link` 的 `href`）在构建产物里都能找到对应文件（断链）；
2. **会真正发起请求的外部资源**是否越界 —— 白名单只有本站两个域名 + `localhost`，
   正文里的普通外链不算（它们不发起资源请求）；
3. `sitemap.xml` 的每个 `<loc>` 都有对应页面；
4. 首页 `index.html` 的导航链接还在（防止后台改坏配置后静默丢导航）。

干净构建后实测结果是 **`会真正请求的外部资源 = 0`**、`站内断链 = 0`、`RESULT: ALL PASS`。
达成方式：

| 手段 | 位置 |
| ---- | ---- |
| vendor 库全部本地化 | `data/vendor.yml`（**整文件覆盖**主题那份）把 41 个库写成 `local|…`，文件在 `static/resources/`（34 个目录 / 182 个文件）；CI 用 `tools/localize_vendor.py --dry-run --strict` 阻止回退到 CDN |
| 随机封面池换成本站图 | `data/covers.yml` 覆盖主题那份（主题默认那份指向作者服务器 `d-sketon.top`） |
| 徽章本地镜像 | `static/badges/*.svg`，页面引用 `/badges/…`，由 `.github/scripts/fetch_badges.py` 在 CI 构建前刷新 |
| 评论系统自建 | 前端 `static/js/comments.js`，后端 `functions/api/comment.js`，不引入任何第三方评论服务 |
| 后台本体是仓库里的文件 | `static/admin/index.html` + `static/admin/sveltia-cms.js`（本地 bundle，不拉 CDN） |
| 图片灯箱依赖本地化 | `static/vendor/jquery/`、`static/vendor/fancybox/`，由 `config/_default/params.yml` 的 `injector.body_end` 引入 |

按需项：主题的看板娘 `live2d` 默认关闭（`config/_default/params.yml` 里 `live2d.enable = false`）；
一旦打开，资源会去 `fastly.jsdelivr.net` 与 `fghrsh/live2d_api`（国内可能不通），需要时再单独本地化。

## 写作后台（Sveltia CMS）

入口 **https://wusitech.github.io/admin/**（Cloudflare 镜像：https://wstk.pages.dev/admin/）。
内容仍然是仓库里的文件，后台保存 = 直接提交到 `main`，和手动改文件完全等价。

- **登录方式**（两条路线，配置步骤见 [docs/后台与评论部署指南.md](docs/后台与评论部署指南.md)）：
  - **细粒度令牌**：点「使用访问令牌登录」，粘一个只对本站仓库可读写的 GitHub 令牌，零配置；
  - **GitHub OAuth**（推荐）：经自建 Cloudflare Worker 中转，代码在
    `tools/cms-oauth-worker/worker.js`，地址已回填到 `static/admin/config.yml` 的 `backend.base_url`。
    只有仓库 collaborator 能写入，Worker 里另有一层 `ALLOWED_GITHUB_USERS` 白名单。
- **集合（5 个）**：

  | 集合 | 写哪个文件 | 说明 |
  | ---- | ---------- | ---- |
  | 文章 | `content/posts/*.md` | TOML front matter（`format: toml-frontmatter`）：标题 / 日期 / 草稿 / 摘要 / 分类 / 标签 / 封面 / 大图 / 正文 |
  | 页面 | `content/about.md`、`content/friend.md` | 固定页面（关于、友情链接） |
  | 评论 | `static/comments/posts/*.json` | 审核用：取消「隐藏」即发布，也可以删除、以「博主」身份回复 |
  | 站点设置 | `config/_default/params.toml` | 作者信息、菜单、首页分类卡片 |
  | 站点文案 | `i18n/zh-CN.yml` | 导航栏文字表（键 → 显示文字），可**自助加栏目**：先在「站点文案」加一条键值（如 `projects → 项目`），再到「站点设置 → 菜单」加一项、名称填同一个键名 |

- **媒体库**：根目录就是 `static/images`（`media_folder: static/images`、`public_folder: /images`），
  后台「全局资源」里能直接挑现有图片；新上传的落在 `static/images/` 根目录，插入路径自动写成 `/images/…`。
  外链图库（Pexels / Pixabay / Unsplash / Lorem Picsum）已整块关闭（`media_libraries.stock_assets: false`）。
- **上传的图片不在后台转码**：转 WebP 由 `.github/workflows/webp.yml` 在推送之后完成
  （转换 → 改写仓库里的引用 → 删除原图 → 自动提交）。想在本地先转可以用 `tools/img2webp.py`。
- ⚠️ **不要**在 `static/admin/config.yml` 里写 `media_libraries.*.config.transformations`：
  那个写法不符合 Sveltia 0.241.0 的配置 schema，会导致**整个后台打不开**（曾踩过）。

## 评论系统（自建，数据存在 Git 仓库里）

不依赖任何第三方评论服务，评论数据就是仓库里的 JSON，`git clone` 即全量备份。
完整说明见 [docs/评论系统（Git存储）.md](docs/评论系统（Git存储）.md)。

- **数据**：`static/comments/posts/<slug>.json`，一篇文章一个文件，`slug` 是文章 URL 去掉首尾斜杠
  （例：`posts/stm32f4-interrupt`）；目录说明见 [static/comments/README.md](static/comments/README.md)。
- **读取**：走静态文件。`static/js/comments.js` **固定从 `https://wstk.pages.dev` 读**
  `/comments/<slug>.json`（在 Cloudflare 域名上就同域读），失败再回退同域 ——
  这样两个域名看到的评论永远是同一份。跨域读由 [static/_headers](static/_headers) 放行
  （`/comments/*` → `Access-Control-Allow-Origin: *`）。
- **提交**：前端把表单 POST 到 `https://wstk.pages.dev/api/comment`，由 Cloudflare Pages Function
  [functions/api/comment.js](functions/api/comment.js) 调 GitHub Contents API 写进仓库。
  Pages 会自动识别仓库根的 `functions/`（`functions/api/comment.js` → `POST /api/comment`），
  不需要改构建命令；GitHub Pages 那边只托管静态文件、跑不了 Function。
- **审核**：本站部署配置是 `COMMENT_MODE=direct` + `COMMENT_PENDING=true`，新评论**默认待审**：
  照常写进 JSON，但 `hidden: true`，页面不渲染。站长在后台「评论」里取消「隐藏」即发布
  （等一次构建，约 1 分钟）；也可以直接在 GitHub 网页上编辑那个 JSON，或删掉整条。
  （代码里的兜底默认是 `COMMENT_MODE=pr`：新建分支 + 开 PR，合并后才上线；`COMMENT_PENDING` 只对 `direct` 生效。）
- **防刷**：蜜罐字段 `hp`（填了就假成功、不入库）+ 每 IP 60 秒最多 3 条（模块级内存限流，
  实例重启即清零，只是基本防护）+ 正文里 `http` 出现次数不超过 5 + 昵称 ≤ 40 字、正文 ≤ 2000 字。
- **自测**：`node tools/git-comments/test.mjs`（28 项，用假 fetch 跑完整链路，不联网）。
  注意它**不在 CI 里**，属于手动工具。

## 页面底部的「BLOG状态」徽章

放在**页脚**里，由站点级覆盖 [layouts/partials/footer.html](layouts/partials/footer.html) 实现
（`</footer>` 之后那个 `class="wusi-badges"` 的块，内容是小字「BLOG状态」+ 两张徽章图）：

- 图片是 `static/badges/build-and-deploy.svg` 与 `static/badges/tools-and-config-checks.svg`，
  页面上引用 `/badges/…`，**不产生任何外链请求**；
- 这两个文件是 README 顶部那两张 GitHub Actions 徽章的**本地镜像**（同一份 SVG），
  所以视觉一致，状态也是 GitHub 自己算出来的真实结论；
- CI 在 `hugo` 之前跑一次
  `python3 .github/scripts/fetch_badges.py --token "$GITHUB_TOKEN" --out-dir static/badges`
  刷新它们（`if: always()` + `continue-on-error: true`，脚本内部全程兜底、永远 exit 0：
  拿不到就保留仓库里已提交的那份并打 warning，绝不阻塞构建）；
- **改工作流文件名 / 换文件时必须一起改这几处**：README 顶部两条徽章地址、
  `layouts/partials/footer.html` 里的两个 `<a href>`、`.github/scripts/fetch_badges.py` 的
  `BADGES` 地址表（文件名对应 `static/badges/*.svg`）；
- 明细与位置约束见 [docs/构建状态挂件.md](docs/构建状态挂件.md)。

历史遗留：旧的「查 GitHub API → 生成 `/build-status.json` → 前端填字」链路虽然已经停用，
文件还在仓库里 —— `static/js/build-status.js`（已经没有任何地方引用）、
`static/css/build-status.css`（`params.yml` 的 `injector.body_end` 仍会加载它，
而 `footer.html` 里用一行 `<style>.build-status{display:none!important}</style>` 把旧条压掉）。

## 侧边栏 widgets

- 列表在 `config/_default/params.yml` 的 `widgets:`，当前是 `category`、`tagcloud`、`recent_posts`
  （条数上限见同文件的 `category_limits`、`tagcloud_limits`、`recent_posts_limits`）。
- 主题默认**只在非文章页**渲染 widgets；本站用站点级覆盖
  [layouts/partials/sidebar.html](layouts/partials/sidebar.html) 把那行条件去掉
  （与 `themes/reimu/layouts/partials/sidebar.html` **只差这一行**），所以**文章页也显示 widgets**，
  同时文章页的目录（`tocBar`）照旧保留。主题升级时要对照新版重新套上这一行改动。

## 配置分工（容易踩的坑）

| 文件 | 管什么 | 谁在改 |
| ---- | ------ | ------ |
| `config/_default/hugo.yml` | 站点基础：`baseURL` / `title` / `theme` / `mainSections` / `enableRobotsTXT` / 代码高亮 | 手动 |
| `config/_default/params.yml` | 约 720 行的主配置：`widgets`、`injector`（注入 CSS/JS）、`comment`、`footer`、`sidebar`、`live2d` 等全部主题参数 | 手动（**刻意不放进后台**：CMS 保存会按表单字段重写整个文件，没声明的键会被丢掉） |
| `config/_default/params.toml` | 作者信息 / `[[menu]]` / `home_categories`（首页分类卡片） | 后台「站点设置」集合 |
| `i18n/zh-CN.yml` | 导航栏文字（键 → 显示文字） | 后台「站点文案」集合 |
| 仓库根 `hugo.toml` | 与 `config/_default/hugo.yml` 内容重复的一份；**同名键以 `config/_default/` 下的为准**（`hugo config` 可验证），改配置请改 `config/_default/` 里的 | 已冗余，留作历史 |

两个 params 文件 Hugo 会**合并**到同一个 `params` 下，所以：

- `params.toml` 里**表名不要写 `params.` 前缀**：文件本身已经等价于 `params`，
  写 `[menu]` 才是 `params.menu`，写 `[params.menu]` 会变成 `.Site.Params.params.menu`，主题读不到；
- 后台「站点设置」只写 `params.toml`，`params.yml` 的内容在后台看不到是正常的；
- `injector.head_end` / `body_end` 里是**纯文本**（主题用 `| safeHTML` 原样输出），
  Hugo **不执行**其中的 `{{ … }}` 模板语法 —— 写进去只会原样出现在页面源码里。

## 工具脚本（`tools/`）

每条给一句用途 + 一条可在仓库根直接跑的命令（CI 里用 `python3`，Windows 上用 `python`）：

| 脚本 | 用途 | 示例命令 |
| ---- | ---- | -------- |
| `tools/docx2md.py` | Word(.docx) → Markdown（图片导出、表格、上下标、可选 Hugo front matter） | `python tools/docx2md.py 报告.docx -o content/posts/report.md --images-dir static/images/report` |
| `tools/img2webp.py` | 任意图片 → WebP（批量 / 缩放 / `--target-kb` 目标体积 / `--max-dim` 限长边 / `--in-place` 重压），需要 Pillow | `python tools/img2webp.py static/images -r --max-dim 1600 --target-kb 300` |
| `tools/auto_webp.py` | CI 用：把新增/修改的位图转 WebP + 改写引用 + 删原图（**默认 dry-run**）；`--all` 处理存量图（会跳过主题素材） | `python tools/auto_webp.py --files static/images/interrupt-path.jpg`（预演）<br>`python tools/auto_webp.py --apply --range origin/main..HEAD` |
| `tools/rename_image.py` | 图片改名 / 移目录，并同步改写 `content/`、`config/`、`data/`、`static/` 里的引用（**默认 dry-run**，绝不 commit/push） | `python tools/rename_image.py static/images/a.jpg static/images/stm32/a.jpg`（预演，加 `--apply` 落盘） |
| `tools/check_site.py` | 构建产物四项校验（断链 / 未授权外部资源 / sitemap / 首页导航） | `python tools/check_site.py --dir public` |
| `tools/localize_vendor.py` | 把 `data/vendor.yml` 里能本地化的库切到 `local|`；`--strict` 用于 CI 防回退 | `python tools/localize_vendor.py --dry-run --strict` |
| `tools/check_twikoo.py` | 旧的 Twikoo 评论后端体检（地址可达性 / 版本 / CORS / 匿名读）——**当前评论方案不是 Twikoo**，脚本保留备用；没有 argparse，不带参数会打印用法并以退出码 2 结束 | `python tools/check_twikoo.py https://xxx.netlify.app/.netlify/functions/twikoo` |
| `tools/cms-oauth-worker/worker.js` | 后台 GitHub OAuth 登录中转（Cloudflare Worker）；自测在 `tools/cms-oauth-worker/test.mjs`（12 项） | `node tools/cms-oauth-worker/test.mjs` |
| `tools/git-comments/test.mjs` | 自建评论 Function 的自测（28 项，假 fetch，不联网） | `node tools/git-comments/test.mjs` |
| `.github/scripts/fetch_badges.py` | 把 README 顶部两张徽章镜像到 `static/badges/`（CI 构建前跑，本地可带 `--proxy`） | `python .github/scripts/fetch_badges.py --out-dir static/badges` |

## CI 工作流（`.github/workflows/`）

| 文件 | 工作流名 | 触发 | 干什么 |
| ---- | -------- | ---- | ------ |
| `hugo.yaml` | Build and deploy | push 到 `main` / 手动 | 镜像徽章 → 装 Dart Sass 1.104.0 + Hugo Extended 0.166.0 → `hugo --minify --baseURL <Pages URL>` → 上传 artifact → 部署 GitHub Pages |
| `tools.yml` | Tools and config checks | push 到 `main` 且改动命中 `tools/**` `data/**` `config/**` `static/admin/**` `static/badges/**` `static/resources/**` `static/css/**` `static/js/**` `layouts/**` `.github/scripts/**` 或本文件；任意 PR；手动 | 三个 job：**Python 工具自测**（`py_compile` 全仓库 Python 文件、6 个脚本的 `--help` CLI 冒烟、`test_check_twikoo.py`、`test_auto_webp.py`、`localize_vendor.py --dry-run --strict`）、**后台登录中转自测**（`node tools/cms-oauth-worker/test.mjs`）、**Hugo 构建检查**（装 Hugo → 构建 → `python3 tools/check_site.py --dir public`） |
| `webp.yml` | Auto WebP | push 到 `main` 且 `static/images/**` 变更；手动（`range` 填 `all` 或任意 git 范围，处理存量图） | 把本次新增/修改的位图转 WebP、改写引用、删原图，用带 `[skip ci]` 的提交推回，再 `gh workflow run hugo.yaml` 补一次部署（否则 `[skip ci]` 会把部署一起跳过） |

三者关系：`hugo.yaml` 只管构建部署；`tools.yml` 是**护栏**（不部署，专门在改工具 / 配置 / 前端资源时把关）；
`webp.yml` 是图片兜底，跑完主动触发一次 `hugo.yaml`。

两个经验：

- **改脚本就要同步改 workflow 里对它的引用**。`tools.yml` 的语法检查用
  `git ls-files "tools/*.py" ".github/scripts/*.py"` 自动收集（不会留下已删除脚本的清单），
  但 CLI 冒烟和自测步骤是**写死文件名**的 —— 重命名 / 删除脚本时必须同步改 `tools.yml`，否则 CI 直接变红。
- `tools.yml` 的 `paths` 不含 `content/**`：**只改文章的推送不会触发它**（PR 或手动可以）；
  而站点构建部署始终由 `hugo.yaml` 负责（它不过滤路径）。

## 文档索引（`docs/`）

| 文档 | 讲什么 |
| ---- | ------ |
| [后台与评论部署指南.md](docs/后台与评论部署指南.md) | 写作后台（Sveltia CMS）的两条登录路线、Cloudflare Worker 部署、后台维护；**评论部分是旧的 Twikoo + Netlify + MongoDB Atlas 方案**，现已被下面那篇取代 |
| [评论系统（Git存储）.md](docs/评论系统（Git存储）.md) | 当前评论方案：架构与数据流向、一次性部署（令牌 + 环境变量）、本地调试（`wrangler pages dev`）、审核流程、备份与已知限制 |
| [图片与媒体库操作说明.md](docs/图片与媒体库操作说明.md) | 后台媒体库怎么删图 / 「移动」图片为什么必须用脚本 / 图片转 WebP 的三条路径与自查命令 |
| [构建状态挂件.md](docs/构建状态挂件.md) | 页底「BLOG状态」徽章的来源、位置约束、旧链路为什么删掉、本地怎么验证 |
| [随机固定背景.md](docs/随机固定背景.md) | 全站随机固定背景：远端图源 / 本地兜底、文章页 banner 整屏、为什么以前看不见、怎么调参和验证 |
| [升级与维护注意事项.md](docs/升级与维护注意事项.md) | 平时自检三条命令、主题升级要做的事、构建告警逐条说明、版本配套表 |

## 本地开发、构建与自检

需要 Hugo Extended（CI 与 Cloudflare 用 0.166.0，本地 0.168.0 实测可正常构建）+ 拉好主题子模块。
Python 脚本要 Python 3.8+，其中 `tools/img2webp.py`、`tools/auto_webp.py` 需要 **Pillow**（CI 用 venv 装）。

```bash
hugo server -D                                     # 本地预览（含草稿），http://localhost:1313
hugo --minify                                      # 构建到 public/
hugo --minify --baseURL https://wstk.pages.dev/     # 想本地预览 Cloudflare 效果时（评论提交仍指向线上）

# 与 CI 一致的检查（校验务必对着「干净的输出目录」，见下面的坑）
hugo --minify --destination .verify-readme && python tools/check_site.py --dir .verify-readme
python tools/test_check_twikoo.py                   # check_twikoo 的 mock 测试
python tools/test_auto_webp.py                      # auto_webp 的转换 / 跳过 / 改写引用 / 删原图规则
python tools/test_rename_image.py                   # rename_image 的改名 / 移目录 / 引用改写 / 拒绝场景
python tools/localize_vendor.py --dry-run --strict  # vendor 不得回退到外部 CDN（0 条走 CDN 才通过）
node tools/cms-oauth-worker/test.mjs                # 后台登录中转自测（12 项）
node tools/git-comments/test.mjs                    # 评论 Function 自测（28 项）

# 预览构建产物（推荐；直接双击 index.html 会因为站内绝对路径导致样式不加载）
python -m http.server 8799 --directory public
```

也可以直接用仓库根的 `Manage.bat`（新建文章 / 预览 / 构建 / 清理 `public/` / 更新主题子模块 / 查看 git 状态）。

两个坑：

- **校验要对着干净的输出目录**。Hugo 不会清理 `public/` 里**已经不存在**的旧页面
  （比如删过的标签留下的 `tags/xxx/index.html`），直接对残留的 `public/` 跑 `check_site.py`
  会把它们一起扫进去、报出早就没有的外部资源（本机实测：残留的 `public/` 报 28 处，
  换干净目录后 `ALL PASS`）。`.gitignore` 里已有 `/public/` 与 `/.verify*/`。
- **Windows 控制台默认 GBK**，Python 脚本输出的中文在 PowerShell 里可能显示成乱码
  （脚本本身是 UTF-8，功能与退出码都正常）。想让输出可读，先执行
  `$env:PYTHONIOENCODING='utf-8'`（PowerShell）或 `chcp 65001`（cmd）。

## 部署

### GitHub Pages（全自动）

推送到 `main` 触发 `.github/workflows/hugo.yaml`：镜像徽章 → 安装 Hugo Extended 0.166.0 与 Dart Sass →
`hugo --minify --baseURL "<Pages URL>"` → 上传 artifact → 部署。
sitemap 与 robots.txt 自动使用 `https://wusitech.github.io/`。

- `main` 分支不要开「Require a pull request before merging」：后台保存与评论提交都是直接写 `main`，开了会一起失效。
- **构建状态**看顶部这两枚徽章，页面底部的「BLOG状态」显示的是同一张图的本地镜像：
  `passing` = 最近一次 `main` 构建并部署成功；`failing` 就点徽章进
  [Actions 日志](https://github.com/WuSiTech/WuSiTech.github.io/actions/workflows/hugo.yaml)
  排查（常见原因：Front Matter 语法、主题子模块没拉下来、Hugo 版本变更）。

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
- **环境变量**：`HUGO_VERSION = 0.166.0`、`TZ = Asia/Shanghai`；
  评论功能还要 `GITHUB_TOKEN`（必填，细粒度：Contents 读写 + Pull requests 读写）以及可选的
  `COMMENT_MODE`（本站用 `direct`）、`COMMENT_PENDING`（默认 `true` 即待审）、`GITHUB_REPO`、
  `GITHUB_BRANCH`、`ALLOWED_ORIGINS`
- `functions/` 不用配置：Pages 自动识别仓库根目录的 `functions/`，
  `functions/api/comment.js` → `POST /api/comment`

这样 Cloudflare 上的 `sitemap.xml` / `robots.txt` 会自动使用 `https://wstk.pages.dev/`。

## sitemap 与搜索引擎收录

- `sitemap.xml`：Hugo 内建生成，每次构建自动更新，包含所有页面（草稿自动排除）和 `<lastmod>`。
- `robots.txt`：由 [layouts/robots.txt](layouts/robots.txt) 生成，`Sitemap:` 行用 `absURL`，
  因此自动跟随当前站点的域名。
- 站点验证文件：[static/BingSiteAuth.xml](static/BingSiteAuth.xml)（Bing Webmaster）。
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
- `content/posts/_index.md`：栏目首页（`/posts/`），配合站点级 `layouts/posts/section.html`
- `content/about.md`、`content/friend.md`、`content/archives/_index.md`：固定页面
- `config/_default/hugo.yml`、`params.yml`、`params.toml`：见上「配置分工」
- `i18n/zh-CN.yml`：导航栏文案（后台「站点文案」集合）
- `layouts/partials/footer.html`、`layouts/partials/sidebar.html`：站点级覆盖（页脚徽章 / 文章页 widget）
- `layouts/posts/section.html`：`/posts/` 栏目列表页（主题没有通用 section 模板）
- `layouts/_default/_markup/render-image.html`：文章图片渲染（懒加载 + 灯箱）
- `layouts/robots.txt`：robots.txt 模板
- `functions/api/comment.js`：评论提交接口（Cloudflare Pages Function）
- `static/comments/`：评论数据（每篇文章一个 JSON，另有 `README.md` 说明）
- `static/images/`：图片资源（后台媒体库根目录）
- `static/avatar/`、`static/badges/`、`static/css/`、`static/js/`、`static/vendor/`
- `static/admin/`：写作后台（Sveltia CMS，入口 `/admin/`）
- `static/resources/`：主题 vendor 库的本地副本（**必须保留跟踪**）
- `static/_headers`：Cloudflare Pages 响应头（评论跨域）
- `data/vendor.yml`、`data/covers.yml`、`data/friends.yml`：覆盖主题的 data 文件（**整文件覆盖**，不是深合并）
- `docs/`：文档（见上索引）
- `tools/`：脚本（见上表格）
- `public/`、`resources/`、`.verify*/`、`.hugo_build.lock`：构建产物，已在 `.gitignore` 中忽略

## 注意事项与已知限制

- **覆盖了主题模板**：`layouts/partials/footer.html`（页脚 + BLOG状态徽章）、
  `layouts/partials/sidebar.html`（文章页也显示 widgets），另外还补了 `layouts/posts/section.html`
  （`/posts/` 栏目列表页）和 `layouts/_default/_markup/render-image.html`（懒加载 + Fancybox 灯箱）。
  主题升级后要逐个对照新版同步，否则这几处改动会"失效"回主题默认行为。
- 主题是 **git submodule**，不要直接改 `themes/reimu/` 里的文件；一律用站点级覆盖。
- `static/js/comments.js` 的行为：优先用页面的 `og:url` 推导文章 slug，评论块插到 `.article-entry`
  之后；如果页面上已经有主题内置评论区且有内容，它会**直接不做事**（避免出现两套评论区）。
  本地调试可用 `window.GIT_COMMENTS_DATA_BASE` / `window.GIT_COMMENTS_ENDPOINT` 覆盖数据源与提交地址。
- **后台重写文件会丢注释**：`config/_default/params.toml`、`i18n/zh-CN.yml`、`static/comments/posts/*.json`
  被 CMS 保存时都是整文件重写，文件里的注释会消失；`params.toml` 里没在 `static/admin/config.yml`
  声明过的键会被丢掉（所以那三块之外的 params 键不要往里加）。评论 JSON 的字段必须与
  `static/admin/config.yml` 里 comments 集合声明的 9 个键完全一致。
- `data/*.yml` 是主题那份的**整文件副本**（Hugo 对 data 文件不做深合并），构建时会看到
  `data from 'covers.yml' / 'friends.yml' overridden by higher precedence` 的 WARN，属正常。
  主题升级后建议：重新复制主题那份 → 再跑一次 `python tools/localize_vendor.py` 本地化。
- 目前构建固定有 **3 条非阻塞 WARN**：`covers.yml` 与 `friends.yml` 的数据覆盖提示，
  外加主题使用已弃用的 libsass（升级 Hugo 前要留意主题有没有切到 dart sass）。
- **`public/` 里的陈旧页面不会被自动清理**（见上文「本地开发」的坑），校验请用干净目录。
- `.gitattributes` 统一 `* text=auto eol=lf`（`*.bat` / `*.cmd` 保持 CRLF），
  Windows 上提交会出现 `CRLF will be replaced by LF` 提示，属正常现象。
