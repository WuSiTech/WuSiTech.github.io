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
| `main` | 站点源码 + **清单**（`data/covers.yml`、`data/cover_pool.yml`）+ `media.lock` |
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

`data/covers.yml`（随机封面池）和 `static/admin/config.yml` 里后台「封面图」下拉框的 374 个选项，
都是从 media 分支的图片清单来的，靠两个东西维护：

1. **`.github/workflows/sync-cover-pool.yml`**（也放在 media 分支上，否则 push media 不会触发）：
   media 分支一 push，就用 Git Tree API 列出 `images/pool/covers/` 下所有 `.webp`/`.avif`，
   生成 `data/cover_pool.yml`，并**只替换** `static/admin/config.yml` 里
   `# ===== COVER_OPTIONS_BEGIN =====` 与 `# ===== COVER_OPTIONS_END =====` 之间那段，
   然后自动提交回 main；最后显式 `gh workflow run hugo.yaml` 触发一次构建部署
   （media 的 push 不会触发 `hugo.yaml`，`GITHUB_TOKEN` 推的提交也不会自动触发其他工作流，
   不显式触发的话新图片永远进不了线上）。
2. **`.github/scripts/sync_cover_pool.py`**：上面工作流调的就是它；本地也能用：

```bash
# 在 main 上，把一份 media 检出目录的图片清单同步过来
python .github/scripts/sync_cover_pool.py --from-dir <media 检出目录>
python .github/scripts/sync_cover_pool.py --from-dir <media 检出目录> --covers-yml  # 连 data/covers.yml 一起重写
python .github/scripts/sync_cover_pool.py --from-dir <media 检出目录> --check       # 只校验是否最新（不写文件）
```

- `data/cover_pool.yml`：全量清单，供后台/工具读取（自动维护）；
- `data/covers.yml`：**随机封面池快照**（没填 `cover` 的文章从里面洗牌取图）。它不会跟着
  media 每次变动自动更新——随机池算是站长的取舍；想让新图也进随机池就跑一次上面带 `--covers-yml` 的命令。
- `media.lock`：建池时 media 分支的提交哈希。它不是构建输入（构建永远取 media 最新提交），
  只用来查「当时用的是哪一版图片」，回滚时按它检出即可。

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

1. `同步封面池` 工作流自动更新 main 的 `data/cover_pool.yml` 和后台下拉框；
2. 它随后显式请求一次 `hugo.yaml`，新图片随之下线；
3. 想让新图也进随机封面池，再在 main 上跑一次带 `--covers-yml` 的脚本。

⚠️ **不要 force push / rebase 重写 media 历史**：`media.lock` 和 CI 缓存键都按提交哈希记。

## 自查

```bash
# 图片池是否就绪
python tools/fetch_media_pool.py --check

# 清单是否和 media 分支一致（需要本地已 fetch media）
python .github/scripts/sync_cover_pool.py --from-dir static/images/pool/covers --check

# 后台下拉框选项数量（应为 374）
grep -c '^- /images/pool/covers/' data/cover_pool.yml
grep -c 'COVER_OPTIONS' static/admin/config.yml   # 应为 2（一对标记行）
```
