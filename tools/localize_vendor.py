#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""localize_vendor.py —— 把 data/vendor.yml 里能本地化的 vendor 库全切成本地

背景
----
hugo-theme-reimu 的 data/vendor.yml 里每个库都写成 `CDN前缀|路径`，
CDN 前缀默认是 `webcache`（= https://npm.webcache.cn，国内 npm 镜像，能用但有免费额度限制）。
主题仓库和本站的 static/resources/ 里其实已经放好了这些库的本地副本，
把前缀改成 `local` 后页面就只请求自己域名下的文件，彻底不依赖第三方 CDN。

用法
----
    python tools/localize_vendor.py            # 就地改写 data/vendor.yml
    python tools/localize_vendor.py --dry-run  # 只看会改什么

注意
----
* data/vendor.yml 是从主题复制来的「整文件副本」（Hugo 对 data 文件不做深合并），
  主题升级后建议：重新复制主题那份 → 再跑一次本脚本。
* 找不到本地文件的条目会原样保留（仍走 CDN），脚本会列出来。
"""

from __future__ import annotations

import argparse
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
VENDOR = ROOT / "data" / "vendor.yml"
RESOURCES = ROOT / "static" / "resources"

ENTRY = re.compile(r"(?P<indent>[ \t]*src:\s*)(?P<prefix>[A-Za-z0-9_\-]+)\|(?P<path>[^\s#]+)")


def main(argv=None):
    ap = argparse.ArgumentParser(description="把 vendor.yml 里可本地化的库切成本地路径")
    ap.add_argument("--dry-run", action="store_true", help="只报告不写文件")
    ap.add_argument("--strict", action="store_true",
                    help="如果有条目仍然走外部 CDN 就以非零退出码结束（CI 里用，防止回退）")
    ap.add_argument("--vendor", default=str(VENDOR), help="vendor.yml 路径")
    args = ap.parse_args(argv)

    vendor_path = pathlib.Path(args.vendor)
    if not vendor_path.is_file():
        print(f"找不到 {vendor_path}", file=sys.stderr)
        return 2

    text = vendor_path.read_text(encoding="utf-8")
    stats = {"localized": [], "already": [], "missing": []}

    def repl(match: re.Match) -> str:
        prefix, path = match.group("prefix"), match.group("path")
        if prefix == "local":
            stats["already"].append(path)
            return match.group(0)
        if (RESOURCES / path).is_file():
            stats["localized"].append(path)
            return f"{match.group('indent')}local|{path}"
        stats["missing"].append(f"{prefix}|{path}")
        return match.group(0)

    new_text = ENTRY.sub(repl, text)

    print(f"vendor.yml: {vendor_path}")
    print(f"  已本地化 {len(stats['localized'])} 条")
    for p in stats["localized"]:
        print(f"    + {p}")
    print(f"  本来就是本地 {len(stats['already'])} 条")
    print(f"  没有本地副本、保持 CDN {len(stats['missing'])} 条")
    for p in stats["missing"]:
        print(f"    ! {p}")

    if args.strict and stats["missing"]:
        print(f"[X] 有 {len(stats['missing'])} 个库仍走外部 CDN（见上面 ! 开头的条目）", file=sys.stderr)
        return 1

    if args.dry_run:
        print("（--dry-run：未写入）")
        return 0
    if new_text == text:
        print("无需改动")
        return 0
    vendor_path.write_text(new_text, encoding="utf-8", newline="\n")
    print("已写入（LF 换行）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
