#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""check_build_status.py —— 校验「构建状态」挂件的构建产物

用法：
    python tools/check_build_status.py                  # 默认检查 public/
    python tools/check_build_status.py --dir public

检查三件事（都是容易静默坏掉的地方）：
  1. /build-status.json 是否生成、是否是合法 JSON；
  2. 里面的 states 键是否齐全（build_and_deploy / tools_and_config_checks / overall），
     取值是否在挂件认识的 variant 集合里；
  3. index.html 与随便一篇文章页面里是否都注入了挂件外壳，
     且两个胶囊的 Actions 链接与 rel="noopener" 都在。

退出码：0 全部通过；1 有问题；2 用法错误。
只用标准库。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

EXPECTED_KEYS = ["build_and_deploy", "tools_and_config_checks", "overall"]
ALLOWED_VARIANTS = {"success", "failure", "running", "unknown"}
ACTIONS_PAGES = (
    "https://github.com/WuSiTech/WuSiTech.github.io/actions/workflows/hugo.yaml",
    "https://github.com/WuSiTech/WuSiTech.github.io/actions/workflows/tools.yml",
)
ROOT_ID = re.compile(r'id="?build-status\b')
PILL = re.compile(r'class="?build-status__pill\b')


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="校验「构建状态」挂件的构建产物")
    parser.add_argument("--dir", default="public", help="构建输出目录（默认 public/）")
    args = parser.parse_args(argv)

    out_dir = Path(args.dir).resolve()
    if not out_dir.is_dir():
        print(f"[X] 找不到目录 {out_dir}（先 hugo 构建）", file=sys.stderr)
        return 2

    problems: list[str] = []

    # 1) /build-status.json
    status_file = out_dir / "build-status.json"
    data = None
    if not status_file.is_file():
        problems.append(
            "缺 build-status.json（检查 content/buildstatus.md 的 outputs、"
            "config/_default/hugo.yml 的 outputFormats.buildstatus、"
            "layouts/_default/single.buildstatus.json）"
        )
    else:
        try:
            data = json.loads(status_file.read_text(encoding="utf-8"))
        except Exception as exc:  # noqa: BLE001
            problems.append(f"build-status.json 不是合法 JSON：{exc}")

    if isinstance(data, dict):
        overall = data.get("overall")
        if overall not in ALLOWED_VARIANTS:
            problems.append(f"build-status.json 的 overall={overall!r} 不在 {sorted(ALLOWED_VARIANTS)} 里")
        states = data.get("states")
        if not isinstance(states, list):
            problems.append("build-status.json 里没有 states 数组")
        else:
            keys = [s.get("key") for s in states if isinstance(s, dict)]
            if keys != EXPECTED_KEYS:
                problems.append(f"states 的 key 是 {keys}，期望 {EXPECTED_KEYS}")
            for state in states:
                if isinstance(state, dict) and state.get("variant") not in ALLOWED_VARIANTS:
                    problems.append(f"states[{state.get('key')}] 的 variant={state.get('variant')!r} 不认识")
                if isinstance(state, dict) and not state.get("label"):
                    problems.append(f"states[{state.get('key')}] 缺少 label（胶囊会显示空白）")

    # 2) 页面里是否都注入了外壳
    pages = [out_dir / "index.html"]
    articles = sorted((out_dir / "posts").glob("*/index.html"))
    if articles:
        pages.append(articles[0])
    else:
        problems.append("产物里没有文章页（posts/*/index.html），无法确认挂件在文章页也注入了")

    for page in pages:
        if not page.is_file():
            problems.append(f"缺页面 {page.relative_to(out_dir).as_posix()}")
            continue
        text = page.read_text(encoding="utf-8", errors="replace")
        rel = page.relative_to(out_dir).as_posix()
        if not ROOT_ID.search(text):
            problems.append(f"{rel} 里没有挂件根元素 id=build-status")
        if len(PILL.findall(text)) < 2:
            problems.append(f"{rel} 里的胶囊少于 2 个（应有 Build and deploy 与 Tools and config checks）")
        for needle in ACTIONS_PAGES:
            if needle not in text:
                problems.append(f"{rel} 里缺少 Actions 链接 {needle}")
        if 'rel="noopener"' not in text and "rel=noopener" not in text:
            problems.append(f"{rel} 里的 Actions 链接缺少 rel=\"noopener\"")
        if "build-status.css" not in text:
            problems.append(f"{rel} 里没有引用 build-status.css")
        if "build-status.js" not in text:
            problems.append(f"{rel} 里没有引用 build-status.js")

    print(f"检查目录：{out_dir}")
    print(f"  挂件数据：{'build-status.json 正常' if data else '缺失或损坏'}")
    print(f"  检查页面：{', '.join(p.relative_to(out_dir).as_posix() for p in pages)}")
    if problems:
        print(f"\n  发现 {len(problems)} 个问题：")
        for item in problems:
            print(f"      - {item}")
        print("\nRESULT: FAILED")
        return 1
    print("\nRESULT: ALL PASS（数据文件合法、首页与文章页都注入了挂件）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
