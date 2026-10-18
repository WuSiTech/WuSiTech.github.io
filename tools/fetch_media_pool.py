#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""fetch_media_pool.py —— 本地把 media 分支的图片池拉到 static/images/pool

main 分支不含大图：374 张封面原图 + 10 张背景图放在 media 孤儿分支，CI 构建前由
.github/workflows/hugo.yaml 自动拉取。本地只要想做「构建 + check_site.py 校验」，
就先跑一次本脚本，把图片池放到同样的位置（static/images/pool 已在 .gitignore 里，
不会被误提交）。

用法：
    python tools/fetch_media_pool.py                  # 拉取（已就绪就跳过）
    python tools/fetch_media_pool.py --force          # 删掉重拉
    python tools/fetch_media_pool.py --check          # 只检查是否已就绪
    python tools/fetch_media_pool.py --proxy http://127.0.0.1:7890   # 走代理（国内网络）

只调用 git 命令行，不依赖第三方库；Windows / Linux / macOS 都能跑。
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
POOL_DIR = REPO_ROOT / "static" / "images" / "pool"
MEDIA_BRANCH = "media"


class FetchError(Exception):
    """可预期的失败（打印中文原因后退出）。"""


def run_git(args: list[str], proxy: str = "") -> str:
    """跑一条 git 命令，返回 stdout（失败抛 FetchError）。"""
    command = ["git"]
    if proxy:
        command += ["-c", f"http.proxy={proxy}", "-c", f"https.proxy={proxy}"]
    command += args
    try:
        result = subprocess.run(
            command,
            cwd=str(REPO_ROOT),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
        )
    except FileNotFoundError:
        raise FetchError("找不到 git 命令，请先安装 Git 并加入 PATH")
    if result.returncode != 0:
        raise FetchError(
            f"git {' '.join(args)} 失败（退出码 {result.returncode}）：\n{result.stderr.strip()}"
        )
    return result.stdout.strip()


def describe_pool() -> tuple[int, int]:
    covers = POOL_DIR / "covers"
    backgrounds = POOL_DIR / "bg"
    n_covers = len([p for p in covers.iterdir() if p.is_file()]) if covers.is_dir() else 0
    n_bg = len([p for p in backgrounds.iterdir() if p.is_file()]) if backgrounds.is_dir() else 0
    return n_covers, n_bg


def main(argv=None) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except Exception:
            pass

    parser = argparse.ArgumentParser(
        description=f"把 {MEDIA_BRANCH} 分支的图片池拉到 static/images/pool（本地构建 / 校验前用）",
    )
    parser.add_argument("--force", action="store_true", help="目录已存在也重新拉取")
    parser.add_argument("--check", action="store_true", help="只检查 static/images/pool 是否就绪")
    parser.add_argument("--proxy", default="", help="git 走的代理，例如 http://127.0.0.1:7890")
    args = parser.parse_args(argv)

    if args.check:
        n_covers, n_bg = describe_pool()
        print(f"static/images/pool：封面 {n_covers} 张，背景 {n_bg} 张")
        if n_covers == 0:
            print("[X] 图片池还没准备好，先跑 python tools/fetch_media_pool.py", file=sys.stderr)
            return 1
        print("RESULT: 图片池已就绪")
        return 0

    n_covers, n_bg = describe_pool()
    if n_covers > 0 and not args.force:
        print(f"static/images/pool 已就绪（封面 {n_covers} 张，背景 {n_bg} 张），跳过；要重拉加 --force")
        return 0

    try:
        sha = run_git(["ls-remote", "origin", MEDIA_BRANCH], proxy=args.proxy)
        sha = sha.split("\t")[0] if sha else ""
        if not sha:
            raise FetchError(
                f"远程没有 {MEDIA_BRANCH} 分支（git ls-remote origin {MEDIA_BRANCH} 无结果）；"
                "请确认 remote 是 WuSiTech/WuSiTech.github.io，并且有网络（必要时加 --proxy）"
            )
        print(f"[1/3] {MEDIA_BRANCH} 分支当前提交：{sha[:10]}")
        print(f"[2/3] 拉取 {MEDIA_BRANCH} 分支（只取最新一次提交的目录树）……")
        run_git(["fetch", "origin", MEDIA_BRANCH, "--depth=1"], proxy=args.proxy)
    except FetchError as exc:
        print(f"[X] {exc}", file=sys.stderr)
        return 2

    worktree = Path(tempfile.mkdtemp(prefix="wusi-media-"))
    try:
        print(f"[3/3] 检出图片池并复制到 static/images/pool ……（临时目录 {worktree}）")
        # 用 FETCH_HEAD 而不是 origin/media：有些检出（例如 CI 的浅克隆）把
        # remote.origin.fetch 收窄成了当前分支，fetch 别的分支不会建 origin/media。
        run_git(["worktree", "add", "--detach", str(worktree), "FETCH_HEAD"], proxy=args.proxy)
        source = worktree / "images" / "pool"
        if not source.is_dir():
            raise FetchError(f"{MEDIA_BRANCH} 分支里没有 images/pool/ 目录")
        # 目录是纯生成的（.gitignore 里），直接整块替换，避免残留旧图
        if POOL_DIR.exists():
            shutil.rmtree(POOL_DIR)
        POOL_DIR.mkdir(parents=True, exist_ok=True)
        shutil.copytree(source, POOL_DIR, dirs_exist_ok=True)
    except (FetchError, OSError) as exc:
        print(f"[X] {exc}", file=sys.stderr)
        return 2
    finally:
        try:
            run_git(["worktree", "remove", "--force", str(worktree)])
        except FetchError:
            shutil.rmtree(worktree, ignore_errors=True)
        try:
            run_git(["worktree", "prune"])
        except FetchError:
            pass

    n_covers, n_bg = describe_pool()
    print(f"完成：封面 {n_covers} 张，背景 {n_bg} 张 → static/images/pool")
    if n_covers == 0:
        print("[X] 复制后一张封面都没有，请检查 media 分支内容", file=sys.stderr)
        return 2
    print("现在可以跑：hugo --minify --destination .verify/out && python tools/check_site.py --dir .verify/out")
    return 0


if __name__ == "__main__":
    sys.exit(main())
