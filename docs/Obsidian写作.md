# 用 Obsidian 写文章（完整操作说明）

这篇文档只回答一件事：**怎么在 Obsidian 里写一篇博客、贴图、提交推送，然后让站点自动更新**。

所有配置都已经写进仓库了（`.obsidian/`、`_templates/`、`layouts/_default/_markup/render-image.html`、
`docs/obsidian-push.bat`），你不需要重新配置，照着本文走一遍即可。

> 一句话流程：**Open folder as vault → 建笔记（Ctrl+N）→ 套模板（Ctrl+Alt+T）→ 写 → 粘图 →
> Ctrl+Shift+G（或双击 `docs/obsidian-push.bat`）→ 推送后 1~2 分钟站点自动更新。**

---

## 一、这套东西现在帮你配好了什么

| 项目 | 现状 | 说明 |
| --- | --- | --- |
| Vault 目录 | `C:\Users\wang-\Desktop\WuSi_Blog` | 整个仓库就是一个 vault |
| 新建笔记位置 | `content/posts/` | `Ctrl+N` 新建的笔记直接落在这里 |
| 粘贴图片位置 | `static/images/obsidian/` | 粘贴/拖拽的图片自动存这里 |
| 图片链接格式 | `![](static/images/obsidian/Pasted%20image%2020261018140500.png)` | Obsidian 用「绝对路径（vault 根）」，站点端的渲染钩子会自动把 `static/` 前缀去掉 |
| 文章模板 | `_templates/文章.md` | 与现有文章的 TOML front matter 一致，快捷键 `Ctrl+Alt+T` |
| 图片渲染钩子 | `layouts/_default/_markup/render-image.html` | 自动剥 `static/` 前缀、相对路径补根、裸文件名兜底、加 `loading=lazy` |
| Git 插件 | `obsidian-git` 2.41.1，已随仓库提交 | 首次打开 Obsidian 时开启社区插件即可用，无需联网安装 |
| 一键推送脚本 | `docs/obsidian-push.bat` | 构建自检 + 只提交文章和图片 + 走代理推送 |
| Git 代理 | 仓库本地 `http.proxy = http://127.0.0.1:7890` | 终端 `git push` 和 Obsidian 插件（它调用系统 git）都会走代理 |
| 忽略文件 | `.obsidian/workspace*.json`、插件 `data.json`、`未命名.md` | 这些是本机状态，不进仓库 |

### 这次改了什么（对照上一版）

- `newLinkFormat: shortest → absolute`。改成 absolute 之后粘贴图片生成的链接才是
  `static/images/obsidian/xxx.png` 这种带目录的形式（shortest 只会写一个裸文件名，站点端就找不到图），
  这跟你要的「正文链接形如 `![](static/images/obsidian/xxx.png)`」一致。
- `layouts/_default/_markup/render-image.html` 重写：除了 `static/` 前缀，还能吃
  `/static/...`、`../../static/...`、`/images/...`、裸文件名、URL 转义（`%20`）几种写法，全部能正确出图。
- 新装 Git 插件（`main.js` / `manifest.json` / `styles.css` 随仓库提交），预设：手动提交推送（不自动）、
  提交前先 pull、状态栏显示分支、提交信息模板 `更新文章: {{date}}`；
  快捷键 `Ctrl+Shift+G` = Commit-and-sync。
- 新增 `docs/obsidian-push.bat` 一键推送脚本（见第五节）。
- `.gitignore` 增加 `content/posts/未命名.md`、`content/posts/Untitled.md`，避免把临时空白笔记推上线。

---

## 二、第一次打开（只做一次）

1. 开始菜单搜索 **Obsidian** → 打开。
2. 启动页选 **Open folder as vault（打开文件夹作为仓库）** →
   选 `C:\Users\wang-\Desktop\WuSi_Blog` → 打开 → 弹「是否信任此仓库的作者」选 **信任 / Trust author**。
3. 关掉安全模式，启用社区插件：
   - `Ctrl+,` 打开设置 → 左侧 **第三方插件 / Community plugins** →
   - 点 **启用社区插件 / Turn on community plugins**（会再确认一次）。
4. 在 **已安装插件** 列表里确认 **Git**（作者 Vinzent）已经是开启状态。
   插件文件已经在 `.obsidian/plugins/obsidian-git/` 里，不用去插件市场下载。
5. 建议顺手确认两个设置（都已在 `app.json` 里配好，一般不用动）：
   - 设置 → **文件与链接** → 新建笔记的存放位置 = `content/posts`，附件默认位置 = `static/images/obsidian`，
     新链接格式 = **绝对路径（vault 根）/ Absolute path in vault**，**使用 Markdown 链接** = 开。

> **重要提示**：本仓库的文章用 **TOML front matter**（`+++`），而 Obsidian 的「属性」面板只认 YAML（`---`）。
> 所以文章顶部的 `title / date / ...` 在 Obsidian 里会显示成**纯文本**，直接在文本里改就行，
> 不影响 Hugo 渲染和发布。

---

## 三、写一篇新文章

1. 左侧文件列表进入 `content/posts` → 右键 **新建笔记**，或直接 `Ctrl+N`。
2. **先把文件名改掉**：用英文/拼音，不要中文和空格（例如 `stm32f4-interrupt`）。
   **文件名就是文章 URL 的 slug**（`/posts/<文件名>/`）。
3. `Ctrl+Alt+T` 插入模板（或 `Ctrl+P` 命令面板输「模板」→ 插入模板）→ 选 **文章**。
   模板会填好：

   ```toml
   +++
   title = "文件名"
   date = 2026-10-18T14:10:00+08:00
   draft = false
   description = ""
   categories = [ "未分类" ]
   tags = [ ]
   cover = ""
   banner = ""
   mermaid = false
   +++
   ```

4. 按需改 front matter：

   | 字段 | 怎么填 |
   | --- | --- |
   | `title` | 文章标题（可以中文） |
   | `date` | 发布时间，`YYYY-MM-DDTHH:MM:00+08:00`；模板已按当前时间填好 |
   | `draft` | **`false` = 发布（推送后站点可见）**；还没写完就改成 `true` |
   | `description` | 一句话摘要，用于列表页和搜索引擎 |
   | `categories` / `tags` | 分类和标签，多个用逗号分隔 |
   | `cover` | 卡片缩略图，例如 `/images/posts/<slug>/cover.webp`，可不填 |
   | `banner` | 文章页顶部大图；不填就用站点随机背景 |
   | `mermaid` | 正文要用 ` ```mermaid ` 画图时改 `true`，否则保持 `false` |

5. 正文照常写。标题 `##`、列表、代码块、公式都支持。

---

## 四、插图

### 1. 怎么插入

- **截图后直接 `Ctrl+V` 粘贴**，或**把图片文件拖进编辑区**。
- 图片会自动落到 `static/images/obsidian/`，正文里自动出现：

  ```markdown
  ![](static/images/obsidian/Pasted%20image%2020261018140500.png)
  ```

- **不要手动改这个链接**。`static/` 前缀是 Obsidian 相对 vault 根的路径，Hugo 的 `static/` 目录就是站点根，
  `render-image.html` 会把它去掉，最终输出 `/images/obsidian/xxx.png`。
- 支持的外链（`https://...`）会原样保留，不会被改。

### 2. 为什么不用担心「路径不一致」

渲染钩子对下面几种写法都能正确出图（已用测试文章逐一验证，`check_site.py` 全部通过）：

```markdown
![](static/images/obsidian/a.png)          ← 本次配置的实际输出
![](/static/images/obsidian/a.png)         ← 手打了前导斜杠
![](../../static/images/obsidian/a.png)    ← 相对当前文章页的旧写法
![](/images/obsidian/a.png)                ← 站点根写法
![](a.png)                                 ← 裸文件名（兜底）
```

### 3. 文章专属图片要归档到 `static/images/posts/<slug>/`

这是仓库约定：**一篇文章自己的图，最终放到 `static/images/posts/<文章 slug>/` 下**；
多篇文章共用/随手截的图，留在 `static/images/obsidian/` 里即可。

粘贴的图片刚进来是临时名（`Pasted image 2026...png`），写完文章后归档一次：

```bash
# ① 先预演（默认 dry-run，不改任何文件），看清楚它会把哪个文件的引用改到哪里
python tools/rename_image.py "static/images/obsidian/Pasted image 20261018140500.png" "static/images/posts/<slug>/中断流程.png"

# ② 没问题再落盘：移动文件 + 自动改掉正文里的引用
python tools/rename_image.py "static/images/obsidian/Pasted image 20261018140500.png" "static/images/posts/<slug>/中断流程.png" --apply
```

- 脚本会同步改写 `content/` 里的引用，改完链接变成 `static/images/posts/<slug>/中断流程.png`，站点照样正常显示；
- 换目录时如果仓库里还有「裸文件名」引用，脚本会拒绝执行（怕猜错相对路径），把它列出来让你确认；
- 扩展名默认不能变；图片细节和自测命令见 [图片与媒体库操作说明.md](图片与媒体库操作说明.md)。

### 4. 图片体积 / WebP

- 单张尽量 **< 1 MB**、宽度 ≤ 1600px；太大的先本地压一下：

  ```bash
  python tools/img2webp.py 目录 -r -q 78 --max-dim 1600
  ```

- 直接推 PNG/JPG 也没关系：push 到 `main` 后 `Auto WebP` 工作流会自动转成 webp、改引用并补一次部署
  （会多出一个带 `[skip ci]` 的机器人提交，属正常现象）。

---

## 五、本地预览（可选，建议写长文时开一次）

在仓库根目录开一个终端：

```bash
hugo server -D      # -D 表示草稿也显示
```

浏览器打开 <http://localhost:1313>。改动文章/图片会自动刷新，顺手就能确认图片有没有正常显示。
`Ctrl+C` 停止。

---

## 六、提交与推送

> 推送 = 上线（`draft = false` 的文章几分钟后就会出现在站点上）。
> **没写完的文章请保持 `draft = true`**，或者先别推送。

三种方式，任选一种（都不需要 `git add -A`）：

### 方式 A：Obsidian 里的 Git 插件（最顺手）

| 想做的事 | 操作 |
| --- | --- |
| 提交 + 推送 | `Ctrl+Shift+G`，或 `Ctrl+P` → **Git: Commit-and-sync** |
| 只提交到本地（不推送） | `Ctrl+P` → **Git: Commit all changes** |
| 看改了什么 | 左侧栏 **Git** 图标（Source Control） |
| 从远端拉取 | `Ctrl+P` → **Git: Pull** |

- 提交信息默认是 `更新文章: 2026-10-18 14:10:00`，想改默认值：设置 → 第三方插件 → Git 齿轮 →
  **Commit message**。
- 插件默认**不会自动提交/推送**（已设为手动），避免半成品被自动发出去。
- 首次推送如果弹窗要凭据：用户名填 GitHub 用户名，密码填 **Personal Access Token**（不是登录密码）。
  Token 在 <https://github.com/settings/tokens> 生成，权限勾 `Contents: Read and write`（fine-grained）
  或 `repo`（classic）。本机已存过 Windows 凭据的话通常不会弹。
- 插件调用的是**系统 git**，会自动读到仓库里配好的代理和 Windows 凭据。

### 方式 B：双击一键推送脚本（推荐，带自检）

双击 **`docs/obsidian-push.bat`**（或在该文件右键 → 运行）。它会：

1. 先跑 `hugo --minify` + `python tools/check_site.py` 做**构建和产物自检**，不通过就**不提交**（仓库硬要求）；
2. 只暂存 `content/` 和 `static/`（文章与图片），**不用 `git add -A`**，不会把你别的改动一起提交；
3. 提示输入提交说明（直接回车 = 「更新文章」）；
4. 走代理推送 `origin`，代理失败会自动直连重试一次；
5. 最后停留在窗口里显示结果。

> 代理端口不是 7890 时：脚本会先读仓库 `git config http.proxy`，再读 Windows 系统代理；
> 也可以先 `set PROXY=http://127.0.0.1:端口` 再运行。

### 方式 C：终端手动

```bash
cd C:\Users\wang-\Desktop\WuSi_Blog
git status                                  # 看改了什么
git add content static                      # 只加文章和图片
git commit -m "新增文章：xxx"
git push                                    # 仓库已配 http.proxy，直接走代理
```

推送成功后 1~2 分钟，GitHub Actions 自动构建并部署：
<https://github.com/WuSiTech/WuSiTech.github.io/actions>

---

## 七、推送失败怎么排查

| 现象 | 原因 / 处理 |
| --- | --- |
| 插件报网络错误、卡住、`ETIMEDOUT` / `Could not read from remote` | 代理没开或端口不对。先确认代理软件在跑（默认 `127.0.0.1:7890`），再用**方式 B/C** 推送 |
| `Authentication failed` / `403` / `401` | GitHub 凭据或 PAT 失效。重新生成 PAT；`git config --local --unset credential.helper` 后重推会重新弹窗 |
| `git config --local http.proxy` 端口变了 | 执行 `git config --local http.proxy http://127.0.0.1:新端口` 和同样一条 `https.proxy`；不要代理了就 `git config --local --unset http.proxy`（`https.proxy` 同理） |
| `! [rejected] ... non-fast-forward` | 远端有新提交：先 `git pull --rebase origin main`，再推 |
| 脚本在自检那步停下 | 先看 `check_site.py` 的输出明细修好站点，再重跑（自检不过一律不提交） |
| 推上去了但站点没更新 | Actions 里看 `Build and deploy` 是否失败；失败按日志修，也可以手动 `Run workflow` |

---

## 八、常见问题 / 不要做的事

**Q：新建的笔记没落到 `content/posts`？**
检查 设置 → 文件与链接 →「新建笔记的存放位置」。本仓库 `app.json` 已经配好，一般不会错；
如果被 Obsidian 覆盖了，把该值改回 `content/posts`（用「指定文件夹」那一项）。

**Q：粘贴的图片存到别的地方了？**
设置 → 文件与链接 →「附件默认存放路径」应为 `static/images/obsidian`（用「指定文件夹」并填这个路径）。

**Q：Obsidian 编辑器里图片显示不出来，但站点上正常？**
正常。Obsidian 的预览解析和 Hugo 不一样，**以站点为准**（`hugo server` 或线上页面确认）。
不要为了「编辑器里能看」去改链接，改了站点反而可能断图。

**Q：文章顶上出现了一个空白文章「未命名」？**
那是新建后没改名的临时笔记。`未命名.md` / `Untitled.md` 已加进 `.gitignore`，不会被提交；
真提交过就 `git rm content/posts/未命名.md` 删掉。

**Q：能在 Obsidian 里直接改主题/后台配置吗？**
技术上可以，但**不要**：`themes/` 是 git 子模块，`static/admin/config.yml` 是后台配置（另有维护流程），
Obsidian 只用来写 `content/posts/` 里的文章和处理图片。

**不要做的事清单**

- 不要提交 `public/`、`resources/`、`.obsidian/workspace.json`、`.obsidian/plugins/obsidian-git/data.json`（都已 ignore）
- 不要手动改 `static/` 前缀之外的图片链接（不需要改）
- 不要用 `git add -A` 一把梭（会把你没想提交的东西一起带上；用方式 A/B/C）
- 不要把 `draft = false` 的半成品推上去
- 不要删/改 `static/images/` 下被主题引用的 `reimu.png`、`taichi*.png`、`cursor/*`

---

## 九、收工前自查

```bash
# 构建 + 产物校验（硬要求：必须 RESULT: ALL PASS）
hugo --minify
python tools/check_site.py

# 图片移动工具自测
python tools/test_rename_image.py

# 看一眼要提交什么
git status --short
```

---

## 十、相关文档

- [图片与媒体库操作说明.md](图片与媒体库操作说明.md) — 删图/移动图/WebP/rename_image.py 细节
- [升级与维护注意事项.md](升级与维护注意事项.md) — 主题子模块、构建与部署
- [图片池（media 分支）.md](图片池（media%20分支）.md) — 封面/背景图池
