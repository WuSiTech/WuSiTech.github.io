# 评论系统（评论存在 Git 仓库里）

一套不依赖任何第三方评论服务的评论系统：**读**走静态 JSON 文件，**写**走 Cloudflare Pages
Function 调 GitHub API，评论数据就是仓库里的文件，`git clone` 即全量备份。

| 角色 | 文件 / 地址 | 说明 |
| --- | --- | --- |
| 前端（读 + 提交） | [`static/js/comments.js`](../static/js/comments.js) | 渲染、嵌套回复、分页、提交 |
| 写入接口 | [`functions/api/comment.js`](../functions/api/comment.js) | 访客提交评论（免登录） |
| 管理接口 | [`functions/api/admin.js`](../functions/api/admin.js) | 列表 / 放行 / 隐藏 / 删除 / 博主回复（要密码） |
| 管理页 | [`static/comments/admin.html`](../static/comments/admin.html) → <https://wstk.pages.dev/comments/admin.html> | 日常审核用这个，别再用 CMS 逐条点 |
| 数据目录 | [`static/comments/`](../static/comments/README.md) | 每篇文章一个 JSON |
| 自测 | `node tools/git-comments/test.mjs`<br>`node tools/git-comments/test-admin.mjs`<br>`node tools/git-comments/test-frontend.mjs` | 假的 GitHub / 假 DOM，不需要网络和浏览器 |

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
- **读取顺序：同源优先，跨域回落**：先读自己域名下的 `/comments/<slug>.json`；取不到（404 / 跨域被拦 /
  JSON 坏了）才去 `https://wstk.pages.dev/comments/<slug>.json`（数据源 `GC_DATA_BASE`）。
  `github.io` 随 push 即时构建、`wstk.pages.dev` 只在定时任务里构建，所以各站先看自己那份最新的，
  再回落到对方那份。想固定只读 Cloudflare 那份，把 `GC_DATA_BASE` 改成当前域名即可。
  > 历史说明：早期版本是「固定跨域读 wstk」，但那样 github.io 会一直显示 wstk 那份可能滞后两小时的旧数据，
  > 所以改成了现在这样。两种做法都需要 [`static/_headers`](../static/_headers) 给 `/comments/*` 放行跨域。

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

- **管理也走同一套 Git 写入**：`/api/admin`（[`functions/api/admin.js`](../functions/api/admin.js)）提供
  `list / setHidden / delete / reply / health`，配套页面是 `/comments/admin.html`。它用独立的
  `ADMIN_TOKEN` 密码保护、仍然用 `GITHUB_TOKEN` 提交到仓库——审核 / 删除 / 博主回复同样是一次 commit，
  等一次构建后生效。详见「三、评论管理页」。
- **嵌套回复靠 `replyTo`**：评论在 JSON 里是**扁平数组**，父子关系靠每条评论的 `replyTo`（父评论 id）。
  `replyTo` 为空字符串 = 顶层评论；前端按它递归渲染成任意深度。手工改 JSON 时别删了父评论却留着子评论
  （管理页删除时会自动把整串回复一起处理）。

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

> 令牌过期后评论会开始报 502「GitHub ... 401 Bad credentials」。好消息是评论管理页会提前 14 天提示
> 剩余天数；轮换步骤见「四、令牌过期与轮换」。

### 2. 在 Cloudflare Pages 项目里加环境变量

打开 Cloudflare 控制台 → **Workers & Pages** → 选中本站的 Pages 项目（`wstk`）→
**Settings** → **Environment variables**（Production 和 Preview 都加上，或至少 Production）：

| 名称 | 类型 | 值 | 必填 |
| --- | --- | --- | --- |
| `GITHUB_TOKEN` | **Secret**（加密） | 第 1 步的令牌 | 是 |
| `ADMIN_TOKEN` | **Secret**（加密） | 评论管理页的密码。建议 32 位以上随机串，**不要和 `GITHUB_TOKEN` 混用** | 是（用管理页就必填） |
| `ADMIN_NAME` | Text | 博主回复时显示的昵称，默认 `博主` | 否 |
| `COMMENT_MODE` | Text | `pr` 或 `direct`（默认 `pr`） | 否 |
| `COMMENT_PENDING` | Text | `true` / `false`，默认 `true`；**只在 `COMMENT_MODE=direct` 时生效** | 否 |
| `GITHUB_REPO` | Text | 默认 `WuSiTech/WuSiTech.github.io` | 否 |
| `GITHUB_BRANCH` | Text | 默认 `main` | 否 |
| `ALLOWED_ORIGINS` | Text | 默认 `https://wstek.win,https://www.wstek.win,https://wusitech.github.io,https://wstk.pages.dev` | 否 |
| `ADMIN_ALLOWED_ORIGINS` | Text | 允许调用 `/api/admin` 的来源，默认复用 `ALLOWED_ORIGINS` | 否 |

`COMMENT_PENDING` 的解析规则（`functions/api/comment.js` 里的 `pendingEnabled()`）：

- 取值大小写不敏感：`true` / `TRUE` / `True` 都算「开」，`false` / `FALSE` / `False` 都算「关」。
- 未设置、空字符串、或写成别的值（`yes`、`1`、拼错的值……）一律**按默认值 `true` 处理**——
  拿不准时宁可先隐藏，也不要让垃圾评论直接上线。
- 想「提交即公开」就必须**明确写 `false`**。

> 站长推荐配置：`COMMENT_MODE=direct` + `COMMENT_PENDING=true`（或不设，本来就是默认）。
> 效果是「别人发评论 → 直接进仓库 → 他在后台看到 → 他决定是否展示」。

加完变量后**重新部署一次**（Deployments → 最新一次 → Retry deployment），变量才会生效。

> ⚠️ **wstk 项目现在不跟随 push 自动构建**：它只在 GitHub Actions 的定时任务（每 2 小时）里通过
> Cloudflare Deploy Hook 触发一次构建，见 [`.github/workflows/hugo.yaml`](../.github/workflows/hugo.yaml)。
> 所以**改完 `functions/` 或环境变量，必须去 Cloudflare 面板手动 Redeploy 一次**，否则线上还是旧代码 /
> 旧变量（症状：新接口 404、403 来源不符、401 令牌失效等）。需要立即上线时也可以让 Actions 手动跑一次
> workflow，但它只在 `schedule` 事件里触发 Deploy Hook，手动 run 不会触发 Cloudflare，最省事还是面板 Redeploy。

### 3. 关于 `functions/` 目录

Cloudflare Pages 会**自动识别仓库根目录的 `functions/`**，把里面每个 `.js` 当成一个路由：

```
functions/api/comment.js   →   /api/comment   （访客提交）
functions/api/admin.js     →   /api/admin     （管理页接口：列表 / 审核 / 删除 / 回复 / 体检）
```

**不需要改构建命令，也不需要改输出目录。**
（如果 Pages 项目里配置了「构建输出目录」是 `public`，`functions/` 仍然从仓库根读取，两者互不影响。）

### 4. GitHub Pages 那边不用管

`wusitech.github.io` 只能托管静态文件、跑不了 Functions，所以：

- 评论列表：先读自己同域的 `/comments/xxx.json`（github.io 随 push 构建，最新），
  取不到再**跨域回落** `https://wstk.pages.dev/comments/xxx.json`（见第一节）。
- 评论提交 / 管理：跨域 `POST` 到 `https://wstk.pages.dev/api/comment` 和 `/api/admin`
  （`static/js/comments.js`、`static/comments/admin.html` 里写死的默认值，可用 `window.GIT_COMMENTS_*` 覆盖）。

Function 的 CORS 白名单里已经包含 `https://wusitech.github.io`，所以跨域 POST 能通；
而评论数据的跨域读由 [`static/_headers`](../static/_headers) 放行（`/comments/*` → `Access-Control-Allow-Origin: *`）。
如果你换了 Cloudflare 域名，改四处：

1. `functions/api/comment.js` 里 `DEFAULT_ALLOWED_ORIGINS`，或在 Pages 环境变量里设 `ALLOWED_ORIGINS`；
   管理接口同理可用 `ADMIN_ALLOWED_ORIGINS`
2. 页面里在引入 `comments.js` **之前**加一行覆盖提交地址：
   ```html
   <script>window.GIT_COMMENTS_ENDPOINT = 'https://你的域名/api/comment';</script>
   ```
3. 同一处再覆盖数据源（否则回落地址还是老的 `wstk.pages.dev`）：
   ```html
   <script>window.GIT_COMMENTS_DATA_BASE = 'https://你的域名';</script>
   ```
4. 管理页（`static/comments/admin.html`）里改默认的 `DEFAULT_ENDPOINT`，或在打开时加 `?api=https://你的域名/api/admin`。
   `static/_headers` 跟着域名走、按路径匹配，无需改动。

### 5. 验证部署成功

```bash
# 1) 提交接口上线 + CORS 正常
curl -i -X OPTIONS https://wstk.pages.dev/api/comment \
  -H "Origin: https://wusitech.github.io" \
  -H "Access-Control-Request-Method: POST"

# 2) 前端能取到当前模式
curl -s https://wstk.pages.dev/api/comment?config=1      # → {"ok":true,"mode":"direct","pending":false}

# 3) 管理接口上线 + 令牌健康（把 <密码> 换成 ADMIN_TOKEN）
curl -s -H "x-admin-token: <密码>" "https://wstk.pages.dev/api/admin?action=health"
```

看到 `204` + `access-control-allow-origin: https://wusitech.github.io` 就说明提交 Function 已经上线；
`/api/comment?config=1` 返回 JSON 说明 GET 路由正常；`/api/admin?action=health` 返回 `tokenDaysLeft`
说明管理接口和令牌都正常。再打开任意文章页，页面底部应该出现评论区。

---

## 三、评论管理页（日常审核首选）

地址：<https://wstk.pages.dev/comments/admin.html>
（源文件 [`static/comments/admin.html`](../static/comments/admin.html)，纯静态、无框架、无外部依赖）

**第一次使用前**（只需做一次）：

1. Cloudflare → Workers & Pages → `wstk` → Settings → Environment variables → Production：
   - 加 `ADMIN_TOKEN`，类型 **Secret**，值用 32 位以上随机串，**不要和 `GITHUB_TOKEN` 相同**；
   - 可选加 `ADMIN_NAME`（博主回复的昵称，默认「博主」）。
2. **Deployments → 最新一次 → Redeploy**。不重新部署的话 `/api/admin` 这个 Function 根本不存在，
   页面会报 503 / 404。
3. 打开 <https://wstk.pages.dev/comments/admin.html>，输入 `ADMIN_TOKEN` 进入。

**能做什么**

- **列表**：所有页面（文章 + 关于 / 友链 / 下载等固定页）的评论都在一屏里，按页面分组、线程缩进；
  顶部是「全部 / 待审核 / 已通过 / 博主」筛选 + 搜索框（昵称 / 正文 / id / 页面路径都能搜）。
- **放行 / 隐藏**：待审核的评论点「通过」→ `hidden` 置 `false`；「隐藏」反向。
  一次操作一个 commit，等一次构建部署后页面上生效。也可以「全部通过（N）」批量处理一整页。
- **删除**：二次确认。默认**连它下面所有回复一起删**；也可以选「只删这条（回复挂到上一层）」，
  把它的回复接到它的父评论上，不会留下一堆孤儿回复。
- **博主回复**：以 `ADMIN_NAME` 身份回复任意一条，写出来的是 `author: true` 的评论（页面上有「博主」徽章），
  嵌套关系自动正确。
- **令牌体检**：顶部显示 `GITHUB_TOKEN` 的有效期和剩余天数；≤14 天变黄、已过期变红。
  排查「401 Bad credentials」先看这里。

**安全说明**

- 密码只存在浏览器 `sessionStorage`（关掉标签页即失效），每次请求放在 `x-admin-token` 请求头里，
  不进 URL、不写仓库；管理接口对密码做常量时间比较，同一 IP 10 分钟内错 12 次会被 429。
- 管理接口只能读写 `static/comments/**.json`，路径和评论 id 都有白名单校验。
- 页面本身是公开的（静态文件），但没有密码什么也做不了；`ADMIN_TOKEN` 泄露等于评论数据管理权泄露，
  发现泄露就在 Cloudflare 改掉并重新部署。

**本地调试管理页**：`npx wrangler pages dev public --binding ADMIN_TOKEN=test ...`（其余变量见第五节），
然后打开 `http://localhost:8788/comments/admin.html?api=http://localhost:8788/api/admin`；
并把 `http://localhost:8788` 加进 `ADMIN_ALLOWED_ORIGINS` / `ALLOWED_ORIGINS`。

---

## 四、令牌过期与轮换（最常见故障）

`GITHUB_TOKEN` 是 Fine-grained PAT，**有有效期**（当初生成时选的 90 天 / 1 年）。过期后所有写入都会变成
`502 … HTTP 401 Bad credentials`。这是本系统最常见的故障，处理流程是固定的：

1. **先确认**：
   - 打开管理页看顶部「令牌还有 N 天」（负数 = 已过期）；或
   - `curl -i "https://wstk.pages.dev/api/admin?action=health" -H "x-admin-token: <密码>"`
     → `meta.tokenDaysLeft` 为负数，或 `code: GITHUB_TOKEN_INVALID`。
2. **生成新令牌**：GitHub → 头像 → Settings → Developer settings → Personal access tokens →
   Fine-grained tokens → 找到当前那个看 Expiration → Generate new token：
   - Repository access：Only select repositories → 只勾 `WuSiTech.github.io`
   - Permissions → Contents：`Read and write`；Pull requests：`Read and write`（只有 pr 模式需要）
   - Expiration 建议 1 年（管理页会在到期前 14 天提醒）
3. **更新 Cloudflare 变量**：`wstk` → Settings → Environment variables → `GITHUB_TOKEN` →
   Edit → 粘贴新令牌（Secret 只能覆盖、看不到旧值）→ Save。
4. **重新部署**：Deployments → 最新一次 → Redeploy。
   **不重新部署新令牌不会生效**（每次部署会固化一份环境变量快照）。
5. **验证**：
   - 管理页顶部显示新的到期日、不再报红；
   - 在任意文章页发一条测试评论 → 返回 200 → 管理页刷新能看到（不用等构建）→ 删掉它；
   - 顺手在 GitHub 上把旧令牌 **Revoke**。
6. 同一套步骤也适用于 `ADMIN_TOKEN`（改了密码后管理页要重新登录）。

> 为什么不能全自动轮换：GitHub 不支持用旧令牌换新令牌（没有 refresh token），新令牌只能人工生成。
> 所以能自动化的只有「提前发现」——管理页的体检横幅 + `/api/admin?action=health` 就是干这个的。

---

## 五、本地调试

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
  --binding ADMIN_ALLOWED_ORIGINS=http://localhost:8788 \
  --binding ADMIN_TOKEN=test-admin \
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
- **评论列表同理**：默认先读同域、失败才回落 `https://wstk.pages.dev`（见第一节）。
  想确认读的是本地构建出来的 `public/comments/*.json`，把数据源也指到本地：
  ```js
  window.GIT_COMMENTS_DATA_BASE = 'http://localhost:8788';
  ```
  覆盖成当前域名（`localhost:8788`）后会直接走同域读。`hugo server` 也一样，把它设成
  `http://localhost:1313` 即可（记得先让页面加载完静态文件，再在控制台设置并刷新）。
- **管理页**：打开 `http://localhost:8788/comments/admin.html?api=http://localhost:8788/api/admin`，
  密码填 `test-admin`（上面的 `ADMIN_TOKEN`）。

不启 wrangler 也能测逻辑——三个脚本都用假的 GitHub / 假 DOM，不需要网络和浏览器：

```bash
node tools/git-comments/test.mjs          # 提交接口：校验、限流、嵌套 replyTo、两种模式…
node tools/git-comments/test-admin.mjs    # 管理接口：鉴权、列表、审核、删除、回复、令牌体检…
node tools/git-comments/test-frontend.mjs # 前端：嵌套渲染、回复 payload 带 replyTo、分页、@前缀…
```

---

## 六、日常审核流程（备用：Sveltia 后台 / PR）

> **日常审核请优先用「三、评论管理页」**：一屏看全部、点一下放行、能直接回复和删除，不用逐条展开 JSON。
> 下面两种是它上线之前的旧流程，仍然可用，适合「只想在 GitHub 上处理 PR」或管理页正好不可用的时候。

### A. `direct` + `COMMENT_PENDING=true`（推荐给不想合并 PR 的人）

这就是「**直接提交但默认隐藏（待站长审核）**」：评论立刻进仓库，但对访客不可见，
站长点一下才放行。

1. 有人提交评论后，访客那边看到「评论已提交，待站长审核后显示」。
   与此同时这条评论**已经写进** `static/comments/<slug>.json` 了，只是 `hidden: true`。
   前端 `static/js/comments.js` 会把 `hidden === true` 的评论**过滤掉不渲染**
   （数据保留在 JSON 里，随时可以改回来或删除）。
2. 站长打开 **`https://wstk.pages.dev/comments/admin.html`**（需要 `ADMIN_TOKEN`），
   「待审核」筛选里就能看到它；点 **通过** 即可。
   （旧方式：`https://wstk.pages.dev/admin/` →「评论」集合 → 找到对应文章 → 关掉「隐藏」→ 保存。）
3. 通过后等一次构建部署（github.io 约 1~2 分钟；wstk 只在定时任务里构建，最长 2 小时，
   要立刻生效就去 Cloudflare 面板 Redeploy / 让 Actions 手动跑一次）→ 刷新页面就出现了。
4. 不想展示：**什么都不用做**（一直留着 `hidden` 开着，页面上永远看不到）。
   想彻底删掉：管理页点「删除」（默认连它的回复一起删）。

> 小提示：评论框下方那句固定说明（「评论提交后需站长审核，通过后才会显示在这里」）是写在
> `static/js/comments.js` 里的静态文案（`gc-tip`），只有**提交后的提示**（`data.message`）才会跟着模式变。
> 也就是说 `direct` 模式下提交成功时会明确显示「待站长审核后显示」或「约 1 分钟后显示」，
> 而框下面那行说明可以按自己的模式改一改（改 `comments.js` 里 `gc-tip` 那段）。
>
> 管理页 / 后台保存都会把整个 `comments` 数组写回 JSON（2 空格缩进 + 末尾换行），
> 字段集合和 Function 写出来的完全一致（恰好 10 个：
> `id, replyTo, name, email, website, body, ts, ua, hidden, author`），
> 所以两边来回改都不会互相弄丢字段（`replyTo` 是嵌套回复的父子指针，两个 CMS 集合里都已声明）。

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
> 你在管理页忽略它即可（想清理再点删除）。

---

## 七、备份与手工编辑

**备份**：数据就在 Git 里。

```bash
git clone https://github.com/WuSiTech/WuSiTech.github.io.git
```

克隆下来就拿到了全部评论（`static/comments/**/*.json`）。也可以随时打包：

```bash
git archive --format=zip -o comments-backup.zip HEAD static/comments
```

**删除 / 修改某条评论**：优先用管理页（点删除会自动处理它的回复）；
也可以直接在 GitHub 上编辑对应的 JSON 文件。手工删父评论时要注意：**它的回复不会自动消失**，
会变成 `replyTo` 指向不存在 id 的「孤儿」，前端会把它当顶层评论显示。
格式说明见 [`static/comments/README.md`](../static/comments/README.md)。

**注意**：手工编辑时如果有人正好在提交评论，会撞车（Function 里会自动重试 3 次，
最终以仓库里的版本为准）。所以要么你先提交、要么让评论先落库，别同时动手。

---

## 八、已知限制

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
| wstk 不跟随 push 构建 | Cloudflare Pages 项目只在 GitHub Actions 的**定时任务**（每 2 小时）里被 Deploy Hook 触发。改了 `functions/`、环境变量、`static/js/**` 后，想让 wstk 立刻生效必须**面板 Redeploy**；github.io 那边 push 即构建（约 1~2 分钟） |
| 嵌套回复依赖 `replyTo` | 评论在 JSON 里是扁平数组，父子关系完全靠 `replyTo`。v15 之前的旧前端提交回复时没带这个字段，所以那段时期的「回复」都存成了顶层评论（无法自动还原，需要手工补 `replyTo`） |
| 管理页需要额外配置 | `/api/admin` 需要环境变量 `ADMIN_TOKEN`，没配置时返回 503；配置/修改后必须重新部署 |
| 管理页密码忘了 | 在 Cloudflare 覆盖 `ADMIN_TOKEN` 再 Redeploy；旧密码立刻失效，已登录的浏览器标签页需要重新登录 |

---

## 九、常见故障排查

| 现象 | 原因与处理 |
| --- | --- |
| 页面完全没有评论区 | ① 这个页面本来就是列表页/首页（`slug` 为空，脚本直接退出）② 主题自带的评论区已有内容，脚本会主动跳过（避免两套评论并存）③ `comments.js` 没被加载：确认 `config/_default/params.yml` 的 `injector.body_end` 里有那行 `<script src="/js/comments.js" defer></script>` |
| 两个域名看到的评论不一致 / 换个域名评论就「没了」 | 读取顺序是「同源优先、跨域回落 wstk」（见第一节），两个域名构建时间不同就会短暂不一致（wstk 最多滞后 2 小时）。处理：① 检查 `https://wstk.pages.dev/comments/posts/<slug>.json` 响应头有没有 `access-control-allow-origin: *`（没有就是 `static/_headers` 没生效）② 需要立刻一致就去 Cloudflare 面板 Redeploy ③ 强制刷新（Ctrl+F5） |
| 提交报 403「来源不在白名单内」 | 你从别的域名（比如 `http://localhost:1313`）打开的页面。把该来源加进 `ALLOWED_ORIGINS`/`ADMIN_ALLOWED_ORIGINS` 并重新部署 |
| 提交报 502「GitHub ... 401 Bad credentials」 | **最常见**：`GITHUB_TOKEN` 过期。先在管理页顶部 / `curl "/api/admin?action=health"` 看剩余天数，再按「四、令牌过期与轮换」换令牌 + **重新部署** |
| 提交报 502「GitHub ... 403」 | 令牌权限不足（缺 Contents 或 Pull requests 写权限），或 API 配额用完 |
| 提交报 502「GitHub ... 404」 | `GITHUB_REPO` 写错了，或令牌没勾这个仓库 |
| 提交报 409「并发冲突」 | 同一时刻有别人在提交同一篇文章，稍后再试一次 |
| 回复提交成功，但刷新后变成顶层评论 | ① 前端 `comments.js` 还是旧缓存（v15 才开始提交 `replyTo`）：Ctrl+F5 / 等缓存过期 ② Cloudflare 上 `/api/comment` 还是旧 Function：面板 Redeploy ③ 数据是 v15 之前写下的（当年就没存 `replyTo`），只能手工补 |
| 连点几条评论的「回复」后，正文里 @昵称 越堆越多 | 旧前端 bug，v15 已修；强刷拿新 JS |
| 分页按钮没有边框 / 样式怪 | 旧 CSS 变量名写错（`--gc-border`），v15 已修 |
| 管理页报 503 ADMIN_DISABLED | 还没配 `ADMIN_TOKEN`，或配了但没重新部署：见「三、评论管理页」 |
| 管理页提示「管理密码不正确」 | 输入的不是 `ADMIN_TOKEN`；注意 Production / Preview 是两套环境变量，页面跑在哪个环境就改哪个 |
| 管理页提示 GITHUB_TOKEN_INVALID | 管理密码对了，但 GitHub 令牌过期：按「四、令牌过期与轮换」处理 |
| 管理页能进但列表是空的 | ① 确实还没有评论 ② `GITHUB_REPO` / `GITHUB_BRANCH` 写错 ③ 某个 JSON 坏了：管理页会把坏文件单独列出来（带错误信息），去 GitHub 修 |
| 管理页操作报「并发冲突」 | 同一时刻有人在发评论，函数会自动重读重试 3 次；仍失败就再点一次 |
| 提示「评论已提交」但页面上一直没有 | ① `COMMENT_PENDING=true`（默认）：去管理页「待审核」里点通过 ② 构建还没跑完（github.io 约 1~2 分钟；wstk 最长 2 小时，急的话面板 Redeploy）③ 浏览器缓存：Ctrl+F5 ④ 构建失败（Cloudflare Pages → Deployments） |
| 新评论一直不显示（最常见原因） | ① 管理页里这条还开着「待审核」→ 点通过 ② 刚通过不到 1 分钟，构建还没跑完 ③ wstk 上要等定时构建 → 面板 Redeploy ④ 强刷 |
| 改了 `functions/` 或环境变量但线上没变化 | wstk 不跟随 push 自动构建，必须去 Cloudflare 面板 Redeploy（见第二节） |
| PR 列表里一堆垃圾 | 直接在 GitHub 上批量 Close，`pr` 模式下关掉即等于删除 |
