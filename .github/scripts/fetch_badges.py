#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""fetch_badges.py —— 镜像 README 顶部那两张 GitHub Actions 徽章 SVG

用法：

    python .github/scripts/fetch_badges.py                    # 下载到 static/badges/
    python .github/scripts/fetch_badges.py --token "$GITHUB_TOKEN"
    python .github/scripts/fetch_badges.py --proxy http://127.0.0.1:7890   # 本机调试用

背景：页底的「BLOG状态」固定条显示的必须是**本地文件**（本站硬约束：运行时不请求
外部资源，tools/check_site.py 会拦下外链），但视觉上要和 README 里那两张徽章
完全一致。办法就是构建前把徽章原样下载进 static/badges/，页面引用本地路径：
同一份 SVG，不额外发请求，而且 SVG 自己就带着 GitHub 算好的真实结论。

CI 里在 `hugo` 之前跑一次（见 .github/workflows/hugo.yaml）。仓库里已经提交了
一份首次下载的副本作为兜底，所以：

  - 下面任何一步失败（没网、限流、返回的不是 SVG）都只打一条 `::warning::`，
    保留仓库里已有的那份，脚本本身始终 exit 0 —— **绝不阻塞构建**；
  - 写文件是「先写临时文件再替换」，不会留下半截 SVG。

只用标准库（urllib），Python 3.8+ 都能跑。
"""

from __future__ import annotations

import argparse
import os
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

# README 顶部两张徽章的地址（顺序 = 页面上的显示顺序）
BADGES = [
    (
        "build-and-deploy.svg",
        "https://github.com/WuSiTech/WuSiTech.github.io/actions/workflows/hugo.yaml/badge.svg?branch=main",
    ),
    (
        "tools-and-config-checks.svg",
        "https://github.com/WuSiTech/WuSiTech.github.io/actions/workflows/tools.yml/badge.svg?branch=main",
    ),
]

DEFAULT_OUT_DIR = "static/badges"
USER_AGENT = "WuSiTech-blog-badge-mirror/1.0 (+https://github.com/WuSiTech/WuSiTech.github.io)"

# 正常徽章约 2.3 KB。小于这个数肯定不是完整的徽章（比如限流时的错误页）。
MIN_SVG_BYTES = 200
# 抓图超时（秒）。CI 里这一步卡住会推迟部署，所以给得比较紧；
# 超时只会让脚本打一条 warning，然后用仓库里已提交的兜底文件继续构建。
HTTP_TIMEOUT = 15.0


def warn(message: str) -> None:
    """打一条 GitHub Actions 注解；本地跑时就是普通一行，不影响退出码。"""
    print(f"::warning::fetch_badges: {message}", file=sys.stderr)


def note(message: str) -> None:
    print(f"fetch_badges: {message}")


def fetch(url: str, token: str, proxy: str | None) -> bytes:
    """下载一个徽章，返回响应体。

    GitHub 的 workflow 徽章是公开端点，不带 token 也能取（本地首次镜像就是匿名下的）；
    带上只是走一遍更高的额度。带了反而 401/403 时自动退回匿名重试。
    """
    handlers = [urllib.request.ProxyHandler({"http": proxy, "https": proxy})] if proxy else []
    opener = urllib.request.build_opener(*handlers)

    def get(headers: dict[str, str]) -> bytes:
        request = urllib.request.Request(url, headers=headers)
        with opener.open(request, timeout=HTTP_TIMEOUT) as response:
            return response.read()

    base_headers = {"User-Agent": USER_AGENT, "Accept": "image/svg+xml,*/*"}
    if not token:
        return get(base_headers)

    try:
        return get({**base_headers, "Authorization": f"Bearer {token}"})
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403):
            warn(f"带 token 请求 {url} 得到 HTTP {exc.code}，改成匿名重试")
            return get(base_headers)
        raise


def looks_like_svg(body: bytes) -> bool:
    """宽松判断：体积够、且是 <svg ...> ... </svg>（不检查内容，保持原样）。"""
    if len(body) < MIN_SVG_BYTES:
        return False
    head = body[:512].lstrip(b"\xef\xbb\xbf \t\r\n").lower()
    return head.startswith(b"<svg") and b"</svg>" in body.lower()


def write_atomic(target: Path, body: bytes) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    handle, tmp_name = tempfile.mkstemp(dir=str(target.parent), prefix=target.name, suffix=".tmp")
    try:
        with os.fdopen(handle, "wb") as tmp:
            tmp.write(body)
        os.replace(tmp_name, target)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="把 README 里的两张 Actions 徽章镜像到 static/badges/")
    parser.add_argument("--out-dir", default=DEFAULT_OUT_DIR, help=f"输出目录（默认 {DEFAULT_OUT_DIR}）")
    parser.add_argument(
        "--token",
        default=os.environ.get("GITHUB_TOKEN", ""),
        help="GitHub token（默认取环境变量 GITHUB_TOKEN；徽章是公开端点，可以没有）",
    )
    parser.add_argument(
        "--proxy",
        default=os.environ.get("HTTPS_PROXY") or None,
        help="HTTP(S) 代理，如 http://127.0.0.1:7890",
    )
    args = parser.parse_args(argv)

    out_dir = Path(args.out_dir)
    failed = 0

    for name, url in BADGES:
        target = out_dir / name
        try:
            body = fetch(url, args.token, args.proxy)
        except Exception as exc:  # noqa: BLE001 —— 任何网络/HTTP 错误都不该让构建失败
            failed += 1
            keep = "保留仓库里已有的那一份" if target.is_file() else "仓库里没有兜底文件，页面会显示破图"
            warn(f"下载 {name} 失败（{type(exc).__name__}: {exc}），{keep}")
            continue

        if not looks_like_svg(body):
            failed += 1
            keep = "保留仓库里已有的那一份" if target.is_file() else "仓库里没有兜底文件，页面会显示破图"
            warn(f"{name} 下载到的内容不像 SVG（{len(body)} 字节），{keep}")
            continue

        try:
            write_atomic(target, body)
        except OSError as exc:
            failed += 1
            warn(f"写入 {target} 失败（{exc}），保留仓库里已有的那一份")
            continue

        note(f"{name}: {len(body)} 字节（来源 {url}）")

    if failed:
        note(f"完成，{failed}/{len(BADGES)} 个徽章没能更新，构建继续（用仓库里的副本）")
    else:
        note(f"完成，{len(BADGES)} 个徽章已更新到 {out_dir}/")
    return 0


if __name__ == "__main__":
    sys.exit(main())
