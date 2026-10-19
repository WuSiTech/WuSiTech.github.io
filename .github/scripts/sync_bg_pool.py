#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""sync_bg_pool.py —— 从 media 分支的背景图生成/更新 data/remote_backgrounds.yml

背景
----
随机背景图池不再放 main 分支，而是放 media 孤儿分支的 images/pool/bg-web/ 下，
构建时由 .github/workflows/hugo.yaml 拉到 static/images/pool 再打包。

本脚本由 .github/workflows/sync-bg-pool.yml 在 media 分支 push 后调用，
唯一产出是 data/remote_backgrounds.yml（站内路径清单，前端随机背景读它）。

想加背景：把图片（建议最长边 1920、quality 82，约 80~260KB）提交到 media 分支的
images/pool/bg-web/，工作流会自动重跑并提交新的清单，站点随之重新构建。

用法
----
  # CI：用 Git Tree API 列 media 分支
  GITHUB_TOKEN=xxx GITHUB_REPOSITORY=WuSiTech/WuSiTech.github.io \
      python3 .github/scripts/sync_bg_pool.py --from-git-tree

  # 本地：扫一份 media 检出的目录（或直接给 bg-web 目录）
  python3 .github/scripts/sync_bg_pool.py --from-dir <目录>

  # 只检查有没有过期（不写文件；有差异时退出码 1）
  python3 .github/scripts/sync_bg_pool.py --from-dir <目录> --check

只用标准库。
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

REPO_ROOT = Path(__file__).resolve().parents[2]
BG_YML = REPO_ROOT / "data" / "remote_backgrounds.yml"

MEDIA_BG_PREFIX = "images/pool/bg-web/"
SITE_BG_PREFIX = "/images/pool/bg-web/"

BG_EXTS = (".webp", ".avif", ".jpg", ".jpeg", ".png")

_NUM_RE = re.compile(r"(\d+)")


class SyncError(Exception):
    pass


def natural_key(name: str) -> tuple:
    parts = _NUM_RE.split(name)
    key = []
    for i, part in enumerate(parts):
        key.append((1, int(part), "") if i % 2 else (0, 0, part))
    return tuple(key)


def collect_from_git_tree(repo: str, branch: str, token: str) -> list[str]:
    url = f"https://api.github.com/repos/{repo}/git/trees/{branch}?recursive=1"
    headers = {
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {token}",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "WuSiTech-bg-pool-sync",
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
        raise SyncError("Git Tree API 返回的文件树被截断，改用 --from-dir 模式")

    names = []
    for entry in payload.get("tree", []):
        path = entry.get("path", "")
        if entry.get("type") != "blob" or not path.startswith(MEDIA_BG_PREFIX):
            continue
        name = path[len(MEDIA_BG_PREFIX):]
        if not name or "/" in name:
            continue
        names.append(name)
    return names


def collect_from_dir(raw_path: str) -> list[str]:
    path = Path(raw_path).expanduser()
    if not path.is_dir():
        raise SyncError(f"目录不存在：{path}")
    candidates = [path / "images" / "pool" / "bg-web", path]
    bg_dir = next((p for p in candidates if p.is_dir()), None)
    if bg_dir is None:
        raise SyncError(f"{path} 下找不到 images/pool/bg-web/")
    return [p.name for p in bg_dir.iterdir() if p.is_file()]


def build_site_paths(names: list[str]) -> list[str]:
    usable = sorted({n for n in names if n.lower().endswith(BG_EXTS)}, key=natural_key)
    if not usable:
        raise SyncError(f"一张背景图都没找到（只认 {' / '.join(BG_EXTS)}）")
    for name in sorted(set(names) - set(usable)):
        print(f"[!] 跳过非图片文件：{name}", file=sys.stderr)
    return [SITE_BG_PREFIX + n for n in usable]


def render_bg_yaml(paths: list[str]) -> str:
    lines = [
        "# 随机背景图池（media 分支 images/pool/bg-web/，构建时拉取）",
        "#",
        "# ⚠️ 自动生成，不要手改：.github/scripts/sync_bg_pool.py 由",
        "#    .github/workflows/sync-bg-pool.yml 在 media 分支 push 后调用。",
        "#",
        "# 想加背景：把图（建议最长边 1920、q82，约 80~260KB）提交到 media 分支的",
        "# images/pool/bg-web/，工作流会自动重跑并提交新的清单，站点随之重建。",
        f"# 共 {len(paths)} 张。",
        "remote_backgrounds:",
    ]
    lines += [f'  - "{p}"' for p in paths]
    return "\n".join(lines) + "\n"


def parse_args(argv=None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="从 media 分支的背景图生成 data/remote_backgrounds.yml")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--from-git-tree", action="store_true", help="用 Git Tree API（CI 用）")
    source.add_argument("--from-dir", metavar="目录", help="扫本地目录")
    parser.add_argument("--repo", default=os.environ.get("GITHUB_REPOSITORY", ""), help="owner/repo")
    parser.add_argument("--branch", default=os.environ.get("MEDIA_BRANCH", "media"), help="media 分支名")
    parser.add_argument("--check", action="store_true", help="只比对不写文件；有差异时退出码 1")
    return parser.parse_args(argv)


def main(argv=None) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except Exception:
            pass

    try:
        args = parse_args(argv)
        if args.from_git_tree:
            token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN") or ""
            if not args.repo:
                raise SyncError("--from-git-tree 需要 --repo 或 GITHUB_REPOSITORY")
            if not token:
                raise SyncError("--from-git-tree 需要 GITHUB_TOKEN")
            names = collect_from_git_tree(args.repo, args.branch, token)
        else:
            names = collect_from_dir(args.from_dir)
        paths = build_site_paths(names)
    except SyncError as exc:
        print(f"[X] {exc}", file=sys.stderr)
        return 2

    content = render_bg_yaml(paths)
    old = BG_YML.read_text(encoding="utf-8") if BG_YML.exists() else None
    if old == content:
        print("RESULT: 清单已是最新")
        return 0
    if args.check:
        print("[X] data/remote_backgrounds.yml 与 media 分支不一致", file=sys.stderr)
        return 1
    BG_YML.write_text(content, encoding="utf-8", newline="\n")
    print(f"RESULT: 已更新 data/remote_backgrounds.yml（{len(paths)} 张背景图）")
    return 0


if __name__ == "__main__":
    sys.exit(main())