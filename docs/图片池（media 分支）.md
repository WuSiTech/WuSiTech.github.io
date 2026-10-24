# 图片池（media 分支）

> 一句话：**封面原图和背景兜底图不在 main 分支**，单独放在 `media` 孤儿分支，
> 构建时自动拉取；main 上只留清单，所以日常改文章不会被上百 MB 图片拖慢。

## 为什么这么做

原先 `static/images/pool/` 直接放在 main：

- 每次 `git clone`、每次 checkout 都要带上约 113MB 的图片，和写文章无关；
- 图片只是素材，不需要跟文章一起进版本历史。

现在改成两份：

| 分支 | 内容 |
| --- | --- |
| `main` | 站点源码 + **清单**（`data/covers.yml`）+ `media.lock` |
| `media` | **只放图片**：`images/pool/covers/`（374 张封面原图）、`images/pool/bg/`（10 张背景兜底图）、同步工作流 |

`media` 是**孤儿分支**（用 `git checkout --orphan` 建的，不继承 main 历史），
两边内容互不干扰；`media` 分支自己的说明见该分支根目录的 `README.md`。

## 图片从哪来、到哪去

```
media 分支 images/pool/{covers,bg}/
        │
        │  构建时（CI）或本地跑 tools/fetch_media_pool.py
        ▼
main 工作区的 static/images/pool/      ← 已被 .gitignore 忽略，永不提交
        │
        │  hugo --minify
        ▼
public/images/pool/                    ← 线上实际路径 /images/pool/…
```

**用原图**：不做二次压缩、不改文件名、不改格式（`.webp` 还是 `.webp`，`.avif` 还是 `.avif`）。
站点里所有引用都写站内路径，例如 `/images/pool/covers/covers-01.avif`。

## CI 怎么拉（平时不额外花时间）

`.github/workflows/hugo.yaml` 与 `.github/workflows/tools.yml` 的构建 job 里各有三步：

1. **解析 media 分支版本**：`git ls-remote origin media` 取最新提交哈希；
2. **缓存图片池**：`actions/cache`，键是 `media-<哈希>`，缓存目录 `static/images/pool`；
3. **拉取（缓存未命中才执行）**：`git fetch origin media --depth=1` + `git worktree add … FETCH_HEAD`，
   再把 `images/pool/*` 复制到 `static/images/pool/`。

> ⚠️ 这里必须是 `FETCH_HEAD`，不能写 `origin/media`：actions/checkout 的浅克隆把
> `remote.origin.fetch` 收窄成了当前分支，`git fetch origin media` 只写 `FETCH_HEAD`、
> **不会**创建 `refs/remotes/origin/media`，写 `origin/media` 会报 `invalid reference`。

效果：

- media 没变 → 缓存命中，构建时间和以前一样；
- media 变了 → 那一次构建多花 1~2 分钟，之后又回到缓存命中。

⚠️ `hugo.yaml` / `tools.yml` 的 Checkout 步骤必须是 `fetch-depth: 1`。写成 `0` 时
actions/checkout 会拉**所有分支**，media 那 113MB 就白拉了，缓存也失去意义。
站点没有用 `enableGitInfo` / `.GitInfo`（`lastmod` 都是手写的），不需要 git 历史。

## 本地怎么拉

```bash
python tools/fetch_media_pool.py                    # 拉取（已就绪则跳过），国内网络加 --proxy
python tools/fetch_media_pool.py --check            # 只检查 static/images/pool 是否就绪
python tools/fetch_media_pool.py --force            # 删掉重拉
```

然后照常 `hugo --minify --destination .verify/out && python tools/check_site.py --dir .verify/out`。
**没有图片池时构建不会报错，但封面会 404、`check_site.py` 会报断链** —— 所以校验前必须先拉。

## 清单是怎么自动同步的

`data/covers.yml`（**唯一的封面池数据**，主题 `helpers/randomCover.html` 直接读它）和
`static/admin/config.yml` 里后台「封面图」下拉框的 374 个选项，都是从 media 分支的图片清单来的，靠两个东西维护：

1. **`.github/workflows/sync-cover-pool.yml`**（也放在 media 分支上，否则 push media 不会触发）：
   media 分支一 push，就用 Git Tree API 列出 `images/pool/covers/` 下所有 `.webp`/`.avif`，
   更新 `data/covers.yml`，并**只替换** `static/admin/config.yml` 里
   `# ===== COVER_OPTIONS_BEGIN =====` 与 `# ===== COVER_OPTIONS_END =====` 之间那段，
   然后自动提交回 main；最后显式 `gh workflow run hugo.yaml` 触发一次构建部署
   （media 的 push 不会触发 `hugo.yaml`，`GITHUB_TOKEN` 推的提交也不会自动触发其他工作流，
   不显式触发的话新图片永远进不了线上）。
2. **`.github/scripts/sync_cover_pool.py`**：上面工作流调的就是它；本地也能用：

```bash
# 在 main 上，把一份 media 检出目录的图片清单同步过来（会同时更新 data/covers.yml 和后台下拉框）
python .github/scripts/sync_cover_pool.py --from-dir <media 检出目录>
python .github/scripts/sync_cover_pool.py --from-dir <media 检出目录> --check   # 只校验是否最新（不写文件）
```

- `data/covers.yml`：**唯一的封面池数据**（没填 `cover` 的文章从里面洗牌取图）。**自动生成，不要手改**；
  media 加图后工作流会自动重写它并提交，新图会直接进随机池（不再需要手动 `--covers-yml`，该参数已删除）。
- `media.lock`：media 分支当前提交的哈希快照。它不是构建输入（构建永远取 media 最新提交），
  只用来查「当时用的是哪一版图片」，回滚时按它检出即可。
  **2026-10-24 做过一次历史压缩**（见文末「历史压缩」一节），现在 media 只剩一个提交 `f8311d1`。

## 加图 / 换图 / 删图

```bash
# 用临时 worktree 检出 media，不打断正在写文章的工作区
git fetch origin media
git worktree add /tmp/media origin/media
cd /tmp/media

cp /path/to/new-cover.webp images/pool/covers/    # 原图，不压缩、不改名
git add images/pool/covers
git commit -m "新增封面：xxx"
git push origin media

cd - && git worktree remove /tmp/media
```

推完 media 之后：

1. `同步封面池` 工作流自动更新 main 的 `data/covers.yml` 和后台下拉框；
2. 它随后显式请求一次 `hugo.yaml`，新图片随之下线（也自动进随机封面池，不用再手动跑脚本）。

⚠️ **不要 force push / rebase 重写 media 历史**：`media.lock` 和 CI 缓存键都按提交哈希记。
（唯一例外：2026-10-24 为了清掉历史里的旧版本图片做过一次，做法见文末「历史压缩」。）

## 自查

```bash
# 图片池是否就绪
python tools/fetch_media_pool.py --check

# 清单是否和 media 分支一致（需要本地已 fetch media）
python .github/scripts/sync_cover_pool.py --from-dir static/images/pool/covers --check

# 后台下拉框选项数量（应为 374）
grep -c '^- /images/pool/covers/' data/covers.yml
grep -c 'COVER_OPTIONS' static/admin/config.yml   # 应为 2（一对标记行）
```

## 历史压缩（2026-10-24）

media 是孤儿分支，历史上堆了不少「旧版本图片」：最初的 113MB 封面原图、后来压到 ~80KB 的新版、
被替换/删除的背景图等。**删文件只删 tip、不删历史**，所以当时 media 的可达对象约 **421.5 MB**。
2026-10-24 把历史压成**一个提交**，只保留当时的 1158 个文件（tree 与压缩前的 tip 完全一致）：

```bash
# 1. 用 worktree 从当前 tip 建孤儿提交（index 保留全部文件）
git worktree add /tmp/media origin/media
cd /tmp/media
git checkout --orphan media-fresh
git commit -m "图片池：历史压缩为单个提交"

# 2. 校验 tree 一致后再强推（--force-with-lease 防止误伤别人刚推的提交）
git rev-parse 'HEAD^{tree}'          # 必须等于 origin/media^{tree}
git push --force-with-lease=refs/heads/media:<旧 tip> origin media-fresh:refs/heads/media

# 3. 把 main 上的 media.lock 改成新 tip
```

结果：media 分支 = **单提交 `f8311d1`**（1158 个文件 / 211.9 MB），可达历史从 421.5 MB 降到 **211.5 MB**；
本地 `git gc --prune=now` 后 `.git` 从 480 MB 降到 239 MB（GitHub 端要等它自己的 GC，
仓库 Settings 里的大小不会立刻下降）。

注意：强推之后**其他机器**上旧的 `media` 会分叉，需要：

```bash
git fetch origin media
git branch -f media origin/media      # 或者删掉重建 worktree
```

以后再需要压缩历史时照上面三步做，**同时更新 main 的 `media.lock`**。
