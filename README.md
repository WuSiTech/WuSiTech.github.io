# media 分支：站点图片池（只放图片，不放站点代码）

main 分支不再保存这些大图。封面原图和背景图放在这个**孤儿分支**（不继承 main 的
提交历史），构建时由 GitHub Actions 拉到 `static/images/pool/` 再打包进站点。

这样做的目的：

- main 的提交历史和仓库体积保持轻量，日常改文章不受 100MB+ 图片拖累；
- 换图 / 加图只动这个分支，工作流自动把新清单同步回 main 的后台下拉框；
- 图片仍然是**原图**（不压缩、不改格式、不改文件名）。

## 目录结构

```
images/pool/covers/   文章封面原图 374 张（100 张 .avif + 274 张 .webp，共约 113 MB）
images/pool/bg/       全站随机固定背景的本地兜底图 10 张 .webp
.github/workflows/    同步工作流（push 本分支后自动更新 main 的封面清单）
README.md             本说明
```

## 和 main 分支的约定

| main 上的东西 | 说明 |
| --- | --- |
| `media.lock` | 建池时 media 分支的提交哈希，用来查「当时用的哪一版图片」 |
| `.github/workflows/hugo.yaml` | 构建前 `git ls-remote origin media` 取最新提交，用 `actions/cache` 缓存 `static/images/pool`；缓存未命中才 `git worktree add` 拉取，所以平时构建时间不变 |
| `.github/workflows/sync-cover-pool.yml` | **本分支 push 后**用 Git Tree API 列出 `images/pool/covers/` 下的全部图片，更新 main 的 `data/covers.yml`（唯一封面池清单）并写进 `static/admin/config.yml` 的 `COVER_OPTIONS` 标记区（后台「封面图」下拉框），然后自动提交回 main |
| `data/covers.yml` | 唯一的封面池清单（不填封面的文章用）。**自动生成**：本分支 push 后工作流会自动重写它并提交回 main，不需要再手动跑脚本 |

⚠️ 工作流文件必须在本分支上也有一份：GitHub Actions 的 push 事件用的是
**被推送的那个提交里的**工作流文件。以后改了 main 上的同步工作流，记得同步一份到这里。

## 怎么加图片

```bash
# 1. 检出本分支（用临时 worktree，不打断正在写文章的工作区）
git fetch origin media
git worktree add /tmp/media origin/media
cd /tmp/media

# 2. 把原图放进对应目录（保持原格式、原文件名，不要压缩）
cp /path/to/new-cover.webp images/pool/covers/

# 3. 提交并推送
git add images/pool/covers
git commit -m "新增封面：xxx"
git push origin media
```

推送后 `同步封面池` 工作流会自动把新清单写回 main，并触发一次站点构建，
新图片随之下线到线上（`https://wusitech.github.io/`）。

## 注意

- **不要**用 `git push --force` / rebase 重写本分支历史：main 的 `media.lock` 和缓存
  键都按提交哈希记，重写会让旧的哈希找不到。
- 本分支不放站点代码、配置、文章；那些都在 main。
- 单个文件必须小于 100MB（GitHub 限制），当前最大约 120KB。
