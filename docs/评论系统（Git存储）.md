# 评论系统（评论存在 Git 仓库里）

一套不依赖任何第三方评论服务的评论系统：**读**走静态 JSON 文件，**写**走 Cloudflare Pages
Function 调 GitHub API，评论数据就是仓库里的文件，`git clone` 即全量备份。

- Function（写）：[`functions/api/comment.js`](../functions/api/comment.js)
- 前端（读 + 提交）：[`static/js/comments.js`](../static/js/comments.js)
- 数据目录：[`static/comments/`](../static/comments/README.md)
- 自测：`node tools/git-comments/test.mjs`

---

## 一、架构与数据流向

```
                 读：GET /comments/posts/xxx.json（纯静态，可缓存，走 Cloudflare CDN）
  ┌──────────────┐ ◄────────────────────────────────────────────┐
  │ 浏览器        │                                              │
  │ comments.js  │ ────────────────────────────────────────────► │
  └──────┬───────┘  写：POST https://wstk.pages.dev/api/comment   │
         │                                                        │
         │ 跨域（GitHub Pages 上跑不了 Function，所以写死 Cloudflare 域名）
         ▼
  ┌──────────────────────────────┐    GitHub Contents API
  │ Cloudflare Pages Function     │ ──────────────────────────►  ┌─────────────────────┐
  │ functions/api/comment.js      │   读文件 / 写文件 / 开 PR      │ WuSiTech.github.io  │
  └──────────────────────────────┘                              │ static/comments/*.json │
                                                                └──────────┬──────────┘
                                                                           │ push 到 main
                                                                           ▼
                                                        GitHub Actions / Cloudflare Pages 构建
                                                        → /comments/*.json 更新（约 1-2 分钟）
```

要点：

- **读不加任何动态接口**：Hugo 把 `static/comments/` 原样发布成 `/comments/`，浏览器直接取 JSON。
  所以评论列表是页面加载后异步渲染的，不参与 SEO。
- **读固定从 Cloudflare 域名取**：同一份代码部署在两个域名上，两边各自构建各自部署，先后必然不一致，
  会出现「一个域名已更新、另一个还是旧数据」——访客换个域名打开就会以为「我的评论没了」。
  所以 `static/js/comments.js` 把数据源写死成 `https://wstk.pages.dev`：
  页面本来就在 `wstk.pages.dev` 上就**同域读** `/comments/<slug>.json`（省一次跨域），
  其它域名（如 `wusitech.github.io`）**跨域读** `${GC_DATA_BASE}/comments/<slug>.json`；
  跨域失败（被拦 / 非 200 / JSON 坏了）时再**回退到同域** `/comments/<slug>.json` 试一次，
  两个来源都失败才显示「还没有评论」。这样两个域名看到的评论永远来自同一份数据。

  跨域能通靠的是 [`static/_headers`](../static/_headers)（Cloudflare Pages 会在**构建产物根目录**
  读这个文件，语法是「路径行顶格 + 响应头缩进两格」）：

  ```
  # 评论数据允许跨域读取：评论组件固定从 https://wstk.pages.dev 取 JSON，
  # 这样两个域名（wstk.pages.dev / wusitech.github.io）看到的评论永远一致。
  /comments/*
    Access-Control-Allow-Origin: *
    Cache-Control: public, max-age=60
  ```

  GitHub Pages **不支持** `_headers`，会忽略它（当作普通静态文件发布，无副作用）——它那侧照样能显示，
  因为数据是从 Cloudflare 跨域读的，而 Cloudflare 已经被这个文件允许了跨域。

  > 本机预览（`hugo server` / `wrangler pages dev`）想读本地那份 JSON，在引入 `comments.js`
  > **之前**加一行覆盖数据源（默认值就是 `https://wstk.pages.dev`）：
  > ```html
  > <script>window.GIT_COMMENTS_DATA_BASE = 'http://localhost:1313';</script>
  > ```
  > 覆盖成当前域名时会自动走同域读，不会因为跨域而多绕一次。
- **写只有一条路径**：Function 里带着一个细粒度 GitHub 令牌，调 Contents API 提交到仓库。
- **三种运行方式**（环境变量 `COMMENT_MODE` + `COMMENT_PENDING`，两者组合决定行为）：

  | `COMMENT_MODE` | `COMMENT_PENDING` | 新评论怎么进仓库 | 新评论何时显示 | 适合 |
  | --- | --- | --- | --- | --- |
  | `pr`（默认） | 不生效 | 新建分支 `comment/<slug>-<时间戳>` → 在分支上写文件 → 开 PR | 你在 GitHub 上合并 PR 后，等一次构建 | 想在 GitHub 上先审一遍再公开 |
  | `direct` | `true`（默认） | **直接写 `main`**，但评论的 `hidden` 落成 `true` | 你在后台 `/admin/` 把「隐藏」关掉并保存后，等约 1 分钟构建 | **推荐**：不想碰 PR，但想自己决定哪条展示 |
  | `direct` | `false` | 直接写 `main`，`hidden: false` | 等约 1 分钟构建 | 完全自动、提交即公开 |

  也就是说：**`COMMENT_PENDING` 只对 `direct` 有意义**。`pr` 模式下评论根本还没进 `main`，
  PR 本身就是「待审核」状态，所以 `COMMENT_PENDING` 对它没有任何影响（写出来的评论始终 `hidden: false`，
  等你合并 PR 后自然可见）。

---

## 二、一次性部署

### 1. 建一个细粒度 GitHub 令牌

1. GitHub → 右上头像 → **Settings** → **Developer settings** →
   **Personal access tokens** → **Fine-grained tokens** → **Generate new token**
2. **Repository access** → `Only select repositories` → 只勾 **`WuSiTech.github.io`**
3. **Permissions** → Repository permissions：
   - **Contents** → `Read and write`（读旧文件 + 写新文件）
   - **Pull requests** → `Read and write`（只有 `COMMENT_MODE=pr` 需要）
   - Metadata 会自动带上 `Read`
4. **Expiration** 建议 90 天～1 年 → 生成后**立刻复制**（只显示一次）

> 令牌过期后评论会开始报 502「GitHub ... 401」，届时重新生成一个、更新 Cloudflare 环境变量即可。

### 2. 在 Cloudflare Pages 项目里加环境变量

打开 Cloudflare 控制台 → **Workers & Pages** → 选中本站的 Pages 项目（`wstk`）→
**Settings** → **Environment variables**（Production 和 Preview 都加上，或至少 Production）：

| 名称 | 类型 | 值 | 必填 |
| --- | --- | --- | --- |
| `GITHUB_TOKEN` | **Secret**（加密） | 第 1 步的令牌 | 是 |
| `COMMENT_MODE` | Text | `pr` 或 `direct`（默认 `pr`） | 否 |
| `COMMENT_PENDING` | Text | `true` / `false`，默认 `true`；**只在 `COMMENT_MODE=direct` 时生效** | 否 |
| `GITHUB_REPO` | Text | 默认 `WuSiTech/WuSiTech.github.io` | 否 |
| `GITHUB_BRANCH` | Text | 默认 `main` | 否 |
| `ALLOWED_ORIGINS` | Text | 默认 `https://wusitech.github.io,https://wstk.pages.dev` | 否 |

`COMMENT_PENDING` 的解析规则（`functions/api/comment.js` 里的 `pendingEnabled()`）：

- 取值大小写不敏感：`true` / `TRUE` / `True` 都算「开」，`false` / `FALSE` / `False` 都算「关」。
- 未设置、空字符串、或写成别的值（`yes`、`1`、拼错的值……）一律**按默认值 `true` 处理**——
  拿不准时宁可先隐藏，也不要让垃圾评论直接上线。
- 想「提交即公开」就必须**明确写 `false`**。

> 站长推荐配置：`COMMENT_MODE=direct` + `COMMENT_PENDING=true`（或不设，本来就是默认）。
> 效果是「别人发评论 → 直接进仓库 → 他在后台看到 → 他决定是否展示」。

加完变量后**重新部署一次**（Deployments → 最新一次 → Retry deployment），变量才会生效。

### 3. 关于 `functions/` 目录

Cloudflare Pages 会**自动识别仓库根目录的 `functions/`**，把里面每个 `.js` 当成一个路由：

```
functions/api/comment.js   →   POST /api/comment
```

**不需要改构建命令，也不需要改输出目录。**
（如果 Pages 项目里配置了「构建输出目录」是 `public`，`functions/` 仍然从仓库根读取，两者互不影响。）

### 4. GitHub Pages 那边不用管

`wusitech.github.io` 只能托管静态文件、跑不了 Functions，所以：

- 评论列表：**跨域从 `https://wstk.pages.dev/comments/xxx.json` 读**（数据源固定，见第一节），
  这样 GitHub Pages 与 Cloudflare Pages 看到的评论永远一致；跨域失败会自动回退到同域
  `/comments/xxx.json`（GitHub Pages 上也有这份文件，只是可能比 Cloudflare 那边旧）
- 评论提交：跨域 `POST` 到 `https://wstk.pages.dev/api/comment`（这是 `static/js/comments.js` 里写死的默认值）

Function 的 CORS 白名单里已经包含 `https://wusitech.github.io`，所以跨域 POST 能通；
而评论数据的跨域读由 [`static/_headers`](../static/_headers) 放行（`/comments/*` → `Access-Control-Allow-Origin: *`）。
如果你换了 Cloudflare 域名，改三处：

1. `functions/api/comment.js` 里 `DEFAULT_ALLOWED_ORIGINS`，或在 Pages 环境变量里设 `ALLOWED_ORIGINS`
2. 页面里在引入 `comments.js` **之前**加一行覆盖提交地址：
   ```html
   <script>window.GIT_COMMENTS_ENDPOINT = 'https://你的域名/api/comment';</script>
   ```
3. 同一处再覆盖数据源（否则列表还是去读老的 `wstk.pages.dev`）：
   ```html
   <script>window.GIT_COMMENTS_DATA_BASE = 'https://你的域名';</script>
   ```
   同时记得 `static/_headers` 是跟着域名走的，无需改动（它按路径匹配）。

### 5. 验证部署成功

```bash
curl -i -X OPTIONS https://wstk.pages.dev/api/comment \
  -H "Origin: https://wusitech.github.io" \
  -H "Access-Control-Request-Method: POST"
```

看到 `204` 且带 `access-control-allow-origin: https://wusitech.github.io` 就说明 Function 已经上线。
再打开任意文章页，页面底部应该出现评论区。

---

## 三、本地调试

需要 Node 和 wrangler（网络受限时可以跳过这一节，直接部署到 Cloudflare 上试）：

```bash
# 1. 先构建出 public/
hugo --minify

# 2. 在仓库根目录启动 Pages 本地模拟器（会同时跑 functions/）
npx wrangler pages dev public \
  --binding COMMENT_MODE=pr \
  --binding GITHUB_REPO=WuSiTech/WuSiTech.github.io \
  --binding GITHUB_BRANCH=main \
  --binding ALLOWED_ORIGINS=http://localhost:8788 \
  --binding GITHUB_TOKEN=<你的令牌>
```

> 想本地试「直接提交 + 默认隐藏（待站长审核）」，把 `--binding COMMENT_MODE=pr` 换成
> `--binding COMMENT_MODE=direct --binding COMMENT_PENDING=true`（`COMMENT_PENDING` 不写也是默认 true）。

然后：

- 打开 `http://localhost:8788/posts/stm32f4-interrupt/` 提交一条评论
- 因为 `ALLOWED_ORIGINS` 里加的是 `http://localhost:8788`，同源提交不会被 403
- **注意**：本地调试时 `comments.js` 默认仍然往 `https://wstk.pages.dev/api/comment` 提交。
  想在本地走本地 Function，就在浏览器控制台先执行：
  ```js
  window.GIT_COMMENTS_ENDPOINT = 'http://localhost:8788/api/comment';
  ```
  然后刷新页面（`comments.js` 是 `defer` 加载的，必须在它执行前设置）。
- **评论列表同理**：默认从 `https://wstk.pages.dev` 读（数据源固定，见第一节），所以在本地看到的
  是线上那份评论。想读本地构建出来的 `public/comments/*.json`，同样在刷新前覆盖数据源：
  ```js
  window.GIT_COMMENTS_DATA_BASE = 'http://localhost:8788';
  ```
  覆盖成当前域名（`localhost:8788`）后会走同域读，不再跨域。`hugo server` 也一样，把它设成
  `http://localhost:1313` 即可（记得先让页面加载完静态文件，再在控制台设置并刷新）。

不启 wrangler 也能测逻辑——直接跑测试脚本，它用假的 fetch 顶替 GitHub：

```bash
node tools/git-comments/test.mjs
```

---

## 四、日常审核流程

### A. `direct` + `COMMENT_PENDING=true`（推荐给不想合并 PR 的人）

这就是「**直接提交但默认隐藏（待站长审核）**」：评论立刻进仓库，但对访客不可见，
站长在后台点一下才放行。

1. 有人提交评论后，访客那边看到「评论已提交，待站长审核后显示」。
   与此同时这条评论**已经写进** `static/comments/<slug>.json` 了，只是 `hidden: true`。
   前端 `static/js/comments.js` 会把 `hidden === true` 的评论**过滤掉不渲染**
   （数据保留在 JSON 里，随时可以改回来或删除）。
2. 站长打开后台 **`https://wstk.pages.dev/admin/`**（Decap CMS，GitHub 登录）。
3. 左侧选 **「评论」**（comments）集合 → 找到**对应文章**的那一份条目 →
   逐条看昵称 / 内容 / 时间（`hidden` 开着的那条就是新评论）。
4. 要展示：把该条的 **「隐藏」开关关掉** → **保存**。
   保存相当于往 `main` 提交一次修改。
5. 等一次构建部署（**约 1 分钟**）→ 刷新页面，这条评论就出现了。
6. 不想展示：**什么都不用做**（一直留着 `hidden` 开着，页面上永远看不到）。
   想彻底删掉就在同一个界面删除该条并保存。

> 小提示：评论框下方那句固定说明（「评论提交后需站长审核，通过后才会显示在这里」）是写在
> `static/js/comments.js` 里的静态文案（`gc-tip`），只有**提交后的提示**（`data.message`）才会跟着模式变。
> 也就是说 `direct` 模式下提交成功时会明确显示「待站长审核后显示」或「约 1 分钟后显示」，
> 而框下面那行说明可以按自己的模式改一改（改 `comments.js` 里 `gc-tip` 那段）。
>
> 后台一次保存会把整个 `comments` 数组写回 JSON（2 空格缩进 + 末尾换行），
> 字段集合和 Function 写出来的完全一致（恰好 9 个：`id, name, email, website, body, ts, ua, hidden, author`），
> 所以两边来回改都不会互相弄丢字段。

### B. `COMMENT_MODE=pr`（在 GitHub 上审 PR）

1. 有人提交评论后，仓库里会出现一个 PR，标题形如：
   ```
   💬 新评论：访客昵称 于 posts/stm32f4-interrupt
   ```
   正文就是评论内容（附带邮箱、网址、UA、时间、页面路径）——**看标题和正文就能判断是不是垃圾**，
   不需要点进 Files changed。
2. **要保留**：点 **Merge pull request** → 等构建（约 1-2 分钟）→ 刷新页面就能看到。
3. **要删掉**：点 **Close pull request** → 再点 **Delete branch**。
   因为 `pr` 模式下评论只存在于那个分支上，**关掉 PR 就等于删除评论**，`main` 上什么都不用改。
4. 想一次合并多条评论时：每条评论一个独立分支和 PR，互不冲突，可以分别合并。

### 批量处理

GitHub 的 PR 列表可以按 `comment/` 前缀搜分支名筛选：

```
https://github.com/WuSiTech/WuSiTech.github.io/pulls?q=is%3Apr+is%3Aopen+head%3Acomment%2F
```

### 怎么切换这三种方式

Cloudflare Pages → Settings → Environment variables → 改 `COMMENT_MODE` / `COMMENT_PENDING`
→ **重新部署一次**（变量才会生效）。改完只影响**之后**提交的评论，已经写进仓库的评论不受影响。

| 想要的效果 | `COMMENT_MODE` | `COMMENT_PENDING` |
| --- | --- | --- |
| 直接进仓库 + 默认隐藏，站长在后台放行（**推荐**） | `direct` | `true`（或删除这个变量） |
| 直接进仓库 + 提交即公开（全自动） | `direct` | `false` |
| 开 PR 审核合并（回到老流程） | `pr` | 随便（不生效） |

> `direct` + `COMMENT_PENDING=false` 时没有审核环节，垃圾评论会被直接提交到仓库并立刻公开。至少确认：
> 蜜罐字段、限流、链接数量限制都还在生效（它们对三种方式都起作用）。
> `direct` + `COMMENT_PENDING=true`（推荐）下，垃圾评论虽然也会进仓库，但**不会出现在页面上**，
> 你在后台忽略它即可（想清理再删除条目）。

---

## 五、备份与手工编辑

**备份**：数据就在 Git 里。

```bash
git clone https://github.com/WuSiTech/WuSiTech.github.io.git
```

克隆下来就拿到了全部评论（`static/comments/**/*.json`）。也可以随时打包：

```bash
git archive --format=zip -o comments-backup.zip HEAD static/comments
```

**删除 / 修改某条评论**：直接在 GitHub 上编辑对应的 JSON 文件，删掉 `comments` 数组里那一个
`{...}` 对象，提交即可。格式说明见 [`static/comments/README.md`](../static/comments/README.md)。

**注意**：手工编辑时如果有人正好在提交评论，会撞车（Function 里会自动重试 3 次，
最终以仓库里的版本为准）。所以要么你先提交、要么让评论先落库，别同时动手。

---

## 六、已知限制

| 限制 | 说明 |
| --- | --- |
| 评论不参与 SEO | 列表是页面加载后 `fetch` JSON 再渲染的；搜索引擎抓不到，**禁用 JS 时也看不到评论** |
| 提交后有延迟 | `pr` 模式要等你合并 PR + 构建（约 1-2 分钟）；`direct` 模式也要等一次构建部署；`direct` + `COMMENT_PENDING=true`（默认）还要**再等你在后台放行**，放行后约 1 分钟才出现 |
| 新评论默认不可见 | `direct` + `COMMENT_PENDING=true`（默认）时，新评论会带 `hidden: true` 写进 JSON 并被前端过滤掉——**这是设计如此，不是数据丢了**，在后台把「隐藏」关掉就显示 |
| 限流是内存级的 | 同一 IP 60 秒最多 3 条，但用的是 Function 实例内的 Map，**实例重启或请求落到别的实例就清零**；只能挡基本刷屏。要严格限流得上 KV / Durable Objects |
| 提交是匿名的 | 没有登录，昵称随便填；只靠蜜罐 + 限流 + 链接数 + 人工审核（`pr` 模式审 PR，或 `direct`+`COMMENT_PENDING=true` 在后台放行）防垃圾 |
| 并发提交会撞车 | 两个人同时评论同一篇文章时，GitHub 会返回 409/422，Function 会重新读文件合并重试，最多 3 次；仍失败会提示「并发冲突，请稍后再提交一次」 |
| 令牌有权限范围 | 令牌只对这一个仓库有 Contents + Pull requests 权限；泄露的影响面限于该仓库。**令牌只存在 Cloudflare 环境变量里，绝不会下发到浏览器** |
| GitHub API 配额 | 细粒度令牌是 5000 请求/小时（每仓库）。正常博客访问量下远远够用；一次提交大约消耗 2-4 个请求 |
| 邮箱是公开的 | `email` 会写进 JSON（仓库是公开的），前端提示也写明了「会随评论一起公开」。如果介意隐私，就别填邮箱 |
| 修改历史不可掩盖 | 评论写进 Git 后，即使后续删除，历史提交里仍然能看到（除非改写历史） |
| PR 标题带 emoji | 生成的 PR 标题形如 `💬 新评论：...`。如果某些终端/工具处理不了 emoji，可以把 `functions/api/comment.js` 里 `openPullRequest()` 的标题前缀删掉 |

---

## 七、常见故障排查

| 现象 | 原因与处理 |
| --- | --- |
| 页面完全没有评论区 | ① 这个页面本来就是列表页/首页（`slug` 为空，脚本直接退出）② 主题自带的评论区已有内容，脚本会主动跳过（避免两套评论并存）③ `comments.js` 没被加载：确认 `config/_default/params.yml` 的 `injector.body_end` 里有那行 `<script src="/js/comments.js" defer></script>` |
| 提交报 403「来源不在白名单内」 | 你从别的域名（比如 `http://localhost:1313`）打开的页面。把该来源加进 `ALLOWED_ORIGINS` |
| 提交报 502「GitHub ... 401 Bad credentials」 | 令牌失效/过期/权限不够。重新生成并更新 `GITHUB_TOKEN` |
| 提交报 502「GitHub ... 403」 | 令牌权限不足（缺 Contents 或 Pull requests 写权限），或 API 配额用完 |
| 提交报 502「GitHub ... 404」 | `GITHUB_REPO` 写错了，或令牌没勾这个仓库 |
| 提交报 409「并发冲突」 | 同一时刻有别人在提交同一篇文章，稍后再试一次 |
| 提示「评论已提交」但页面上一直没有 | **`direct` + `COMMENT_PENDING=true`（默认）：先去后台看这条评论的「隐藏」开关是不是还开着**（见上一行）。`pr` 模式：去 PR 列表看看是不是还没合并。都不是：看仓库的 Actions / Cloudflare 构建是不是失败了 |
| 新评论一直不显示（最常见原因） | ① 后台 `/admin/` →「评论」里对应文章的这条**还开着「隐藏」**——关掉并保存，等约 1 分钟 ② 刚放行不到 1 分钟，构建还没跑完 ③ 浏览器缓存：强制刷新（Ctrl+F5） ④ 构建失败（Cloudflare Pages → Deployments 看最新一次） |
| 后台改完「隐藏」还是不显示 | 确认后台保存真的提交了（GitHub 上能看到一次 `Update …json` 提交）；再确认前端 `comments.js` 已加载、且该条评论的 `ts`/`body` 没被手改坏（JSON 坏掉时前端会整份放弃渲染） |
| PR 列表里一堆垃圾 | 直接在 GitHub 上批量 Close，`pr` 模式下关掉即等于删除 |
