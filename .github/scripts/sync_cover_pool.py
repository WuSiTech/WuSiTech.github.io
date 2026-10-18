#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""sync_cover_pool.py —— 从 media 分支的封面原图生成两份清单

背景
----
封面原图（374 张 .webp/.avif）不再放在 main 分支的 static/images/pool/，
而是单独放在 media 孤儿分支的 images/pool/covers/ 下（构建时由
.github/workflows/hugo.yaml 拉到 static/images/pool 再构建，见 media.lock）。

本脚本由 .github/workflows/sync-cover-pool.yml 在 media 分支 push 后调用，
产出（只改这两处，避免手抄出错）：

  1. data/cover_pool.yml
     站内路径清单，例如 /images/pool/covers/covers-01.avif，一行一条。
  2. static/admin/config.yml
     只替换 # ===== COVER_OPTIONS_BEGIN ===== 与 # ===== COVER_OPTIONS_END =====
     之间的内容（后台「封面图」下拉框的选项），标记行以外一个字符都不动。

可选：
  --covers-yml  同时重写 data/covers.yml（随机封面池快照）。工作流默认不写它，
                因为随机池是站长的手工取舍，不是每次 media 变动都要跟着变。

用法
----
  # CI（默认）：用 Git Tree API 列 media 分支
  GITHUB_TOKEN=xxx GITHUB_REPOSITORY=WuSiTech/WuSiTech.github.io \
      python3 .github/scripts/sync_cover_pool.py --from-git-tree

  # 本地：直接扫一份 media 检出的目录（也可以直接给 images/pool/covers 目录）
  python3 .github/scripts/sync_cover_pool.py --from-dir ../WuSi_media/images/pool/covers

  # 只检查有没有过期（不写文件；有差异时退出码 1）
  python3 .github/scripts/sync_cover_pool.py --from-dir <目录> --check

只用标准库，Python 3.8+ 都能跑（CI 里跑在 ubuntu-latest 自带的 3.12 上）。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

# ---------------------------------------------------------------------------
# 常量：路径、标记行、支持的扩展名
# ---------------------------------------------------------------------------
REPO_ROOT = Path(__file__).resolve().parents[2]
COVER_POOL_YML = REPO_ROOT / "data" / "cover_pool.yml"
COVERS_YML = REPO_ROOT / "data" / "covers.yml"
CONFIG_YML = REPO_ROOT / "static" / "admin" / "config.yml"

# media 分支里封面原图的目录（Git 树里的路径前缀）
MEDIA_COVERS_PREFIX = "images/pool/covers/"
# 站点上线后的站内路径前缀
SITE_COVERS_PREFIX = "/images/pool/covers/"

COVER_EXTS = (".webp", ".avif")

MARK_BEGIN = "COVER_OPTIONS_BEGIN"
MARK_END = "COVER_OPTIONS_END"

# 自然排序：covers-02 排在 covers-10 前面、covers-100 排在 covers-101 前面
_NUM_RE = re.compile(r"(\d+)")


class SyncError(Exception):
    """可预期的失败（打印中文原因后以退出码 2 结束）。"""


def natural_key(name: str) -> tuple:
    """把文件名拆成「文本 / 数字」交替的元组，数字按数值比较。"""
    parts = _NUM_RE.split(name)
    key = []
    for i, part in enumerate(parts):
        if i % 2:
            key.append((1, int(part), ""))
        else:
            key.append((0, 0, part))
    return tuple(key)


# ---------------------------------------------------------------------------
# 取文件名清单：两种来源
# ---------------------------------------------------------------------------
def collect_from_git_tree(repo: str, branch: str, token: str) -> list[str]:
    """用 GitHub Git Tree API 列出 media 分支 images/pool/covers/ 下的原图。"""
    url = f"https://api.github.com/repos/{repo}/git/trees/{branch}?recursive=1"
    headers = {
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {token}",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "WuSiTech-cover-pool-sync",
    }
    last_error: Exception | None = None
    for attempt in range(1, 4):
        try:
            request = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(request, timeout=60) as response:
                payload = json.load(response)
            break
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            last_error = exc
            print(f"[!] 第 {attempt} 次请求 Git Tree API 失败：{exc}", file=sys.stderr)
            if attempt < 3:
                time.sleep(3 * attempt)
    else:
        raise SyncError(f"连续 3 次取不到 media 分支的文件树：{last_error}")

    if payload.get("truncated"):
        raise SyncError(
            "Git Tree API 返回的文件树被截断（truncated=true），"
            "media 分支文件太多，改用 --from-dir 模式或分页 API"
        )

    names = []
    for entry in payload.get("tree", []):
        path = entry.get("path", "")
        if entry.get("type") != "blob" or not path.startswith(MEDIA_COVERS_PREFIX):
            continue
        name = path[len(MEDIA_COVERS_PREFIX):]
        # 只取目录下的直接子文件，跳过子目录里的东西
        if not name or "/" in name:
            continue
        names.append(name)
    return names


def collect_from_dir(raw_path: str) -> list[str]:
    """扫本地目录。既接受 media 检出根目录，也接受 images/pool/covers 本身。"""
    path = Path(raw_path).expanduser()
    if not path.is_dir():
        raise SyncError(f"目录不存在：{path}")
    candidates = [path / "images" / "pool" / "covers", path]
    covers_dir = next((p for p in candidates if p.is_dir()), None)
    if covers_dir is None:
        raise SyncError(f"{path} 下找不到 images/pool/covers/")
    return [p.name for p in covers_dir.iterdir() if p.is_file()]


# ---------------------------------------------------------------------------
# 生成两份清单的文本
# ---------------------------------------------------------------------------
def build_site_paths(names: list[str]) -> list[str]:
    """过滤 + 去重 + 自然排序，返回 /images/pool/covers/xxx 形式。"""
    usable = sorted(
        {name for name in names if name.lower().endswith(COVER_EXTS)},
        key=natural_key,
    )
    if not usable:
        raise SyncError(f"一张封面都没找到（只认 {' / '.join(COVER_EXTS)}）")
    skipped = sorted(set(names) - set(usable))
    for name in skipped:
        print(f"[!] 跳过非封面文件：{name}", file=sys.stderr)
    return [SITE_COVERS_PREFIX + name for name in usable]


def render_cover_pool_yaml(paths: list[str]) -> str:
    lines = [
        "# 文章封面候选清单（自动生成，不要手改）",
        "#",
        "# 来源：media 孤儿分支 images/pool/covers/ 下的全部原图（.webp / .avif，未压缩）",
        "# 生成：.github/scripts/sync_cover_pool.py（由 .github/workflows/sync-cover-pool.yml",
        "#       在 media 分支 push 后自动调用；同一份清单会写进 static/admin/config.yml",
        "#       的 COVER_OPTIONS 标记区，作为后台「封面图」下拉框的选项）",
        "#",
        f"# 共 {len(paths)} 张。想加图：把原图提交到 media 分支的 images/pool/covers/，",
        "# 工作流会自动重跑并提交新的清单，不需要手改本文件。",
    ]
    lines += [f"- {path}" for path in paths]
    return "\n".join(lines) + "\n"


def render_covers_yaml(paths: list[str]) -> str:
    """data/covers.yml（主题 helper/randomCover 用的随机封面池）。"""
    lines = [
        "# 文章封面池（主题的 helper/randomCover 从中洗牌分配，不填封面的文章自动使用）",
        "#",
        "# 图片本身在 media 孤儿分支，构建时由 .github/workflows/hugo.yaml 拉到",
        "# static/images/pool/ 再打包（见 media.lock）。本文件是清单快照：",
        "# media 分支加图后，想让它进随机池就重跑一次",
        "#   python3 .github/scripts/sync_cover_pool.py --from-dir <media 检出目录> --covers-yml",
        f"# 共 {len(paths)} 张。",
    ]
    lines += [f"- {path}" for path in paths]
    return "\n".join(lines) + "\n"


def render_option_lines(paths: list[str], indent: str) -> list[str]:
    """config.yml 标记区里的内容（缩进跟着 BEGIN 标记行走）。"""
    lines = [
        f"{indent}# 封面候选（自动生成，勿手改）——来源 media 分支，共 {len(paths)} 张",
    ]
    lines += [f"{indent}- {path}" for path in paths]
    return lines


def patch_config_yml(text: str, paths: list[str]) -> str:
    """只替换两条标记行之间的内容，标记行本身和别处一个字都不动。"""
    lines = text.splitlines(keepends=True)
    begin = end = -1
    for index, line in enumerate(lines):
        if MARK_BEGIN in line and begin < 0:
            begin = index
        elif MARK_END in line and begin >= 0:
            end = index
            break
    if begin < 0 or end < 0:
        raise SyncError(
            f"static/admin/config.yml 里找不到 {MARK_BEGIN} / {MARK_END} 标记行，"
            "请先确认后台封面字段还是 select + options 的写法"
        )
    if end < begin:
        raise SyncError("config.yml 的 COVER_OPTIONS_END 出现在 BEGIN 前面，标记区写反了")

    indent = re.match(r"[ \t]*", lines[begin]).group(0)
    block = [line + "\n" for line in render_option_lines(paths, indent)]
    return "".join(lines[: begin + 1] + block + lines[end:])


# ---------------------------------------------------------------------------
# 写文件 / 比对
# ---------------------------------------------------------------------------
def parse_args(argv=None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="从 media 分支的封面原图生成 data/cover_pool.yml 与后台下拉选项",
    )
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument(
        "--from-git-tree",
        action="store_true",
        help="用 Git Tree API 列 media 分支（CI 用；需要 GITHUB_TOKEN / GITHUB_REPOSITORY）",
    )
    source.add_argument("--from-dir", metavar="目录", help="扫本地目录（media 检出根目录或 covers 目录）")
    parser.add_argument("--repo", default=os.environ.get("GITHUB_REPOSITORY", ""), help="owner/repo")
    parser.add_argument("--branch", default=os.environ.get("MEDIA_BRANCH", "media"), help="media 分支名")
    parser.add_argument("--covers-yml", action="store_true", help="同时重写 data/covers.yml（随机封面池）")
    parser.add_argument("--check", action="store_true", help="只比对不写文件；有差异时退出码 1")
    return parser.parse_args(argv)


def build_outputs(args: argparse.Namespace) -> tuple[dict[Path, str], int]:
    """返回 {要写的文件: 新内容} 和封面张数。"""
    if args.from_git_tree:
        token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN") or ""
        if not args.repo:
            raise SyncError("--from-git-tree 需要 --repo，或设置 GITHUB_REPOSITORY 环境变量")
        if not token:
            raise SyncError("--from-git-tree 需要 GITHUB_TOKEN 环境变量（工作流里用 secrets.GITHUB_TOKEN）")
        names = collect_from_git_tree(args.repo, args.branch, token)
    else:
        names = collect_from_dir(args.from_dir)

    paths = build_site_paths(names)

    outputs: dict[Path, str] = {
        COVER_POOL_YML: render_cover_pool_yaml(paths),
        CONFIG_YML: patch_config_yml(CONFIG_YML.read_text(encoding="utf-8"), paths),
    }
    if args.covers_yml:
        outputs[COVERS_YML] = render_covers_yaml(paths)
    return outputs, len(paths)


def main(argv=None) -> int:
    # 诊断输出是中文，Windows 控制台默认编码会炸，这里兜一下
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except Exception:
            pass

    try:
        args = parse_args(argv)
        outputs, count = build_outputs(args)
    except SyncError as exc:
        print(f"[X] {exc}", file=sys.stderr)
        return 2

    changed: list[str] = []
    for path, content in outputs.items():
        old = path.read_text(encoding="utf-8") if path.exists() else None
        if old == content:
            print(f"  [=] {path.relative_to(REPO_ROOT).as_posix()} 已是最新")
            continue
        changed.append(path.relative_to(REPO_ROOT).as_posix())
        if not args.check:
            path.write_text(content, encoding="utf-8", newline="\n")
            print(f"  [改] {path.relative_to(REPO_ROOT).as_posix()}")

    print(f"封面原图 {count} 张；需要更新 {len(changed)} 个文件")

    if args.check:
        if changed:
            print(f"[X] 以下文件与 media 分支不一致：{', '.join(changed)}", file=sys.stderr)
            return 1
        print("RESULT: 清单已是最新")
        return 0

    if not changed:
        print("RESULT: 无需改动")
    else:
        print(f"RESULT: 已更新 {', '.join(changed)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
