#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""check_site.py —— 校验构建产物（public/），把四类问题在部署前拦住

用法：
    python tools/check_site.py                 # 默认检查 public/
    python tools/check_site.py --dir out       # 指定构建输出目录
    python tools/check_site.py --allow cdn.example.com   # 额外允许某个外部域名（放行用）

检查四件事：
  1. 站内引用（img 的 src/data-src、a 的 href、link 的 href）是否都能在产物里找到对应文件
     —— 断图、错路径、改了 slug 忘改链接，都会在这里暴露
  2. 浏览器**会真正请求**的外部资源是否在允许清单内
     —— 保证“不依赖被墙资源”这条要求不被后续改动破坏
     （只看 src/link/url() 这类会发起请求的引用，正文里的普通外链不算）
  3. sitemap.xml 里每个 <loc> 是否都有对应页面
  4. 首页 index.html 是否还有导航链接
     —— 防止后台（导航栏目 / 站点文案）写坏后，首页静默地把导航整块丢掉

退出码：0 全部通过；1 有问题；2 用法错误。
只用标准库，任何 Python 3.8+ 都能跑。
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from urllib.parse import unquote, urlparse

SELF_HOSTS = {"wusitech.github.io", "wstk.pages.dev", "localhost", "127.0.0.1"}

# 第三方资源目录：static/resources/ 与 static/vendor/ 是整包放进来的库，
# 里面可能自带测试页（如 live2d 的 test.html）或引用自己没带的字体文件，
# 这些不是本站页面，扫它们会产生误报。站点自己的页面/样式才检查。
VENDOR_DIRS = {"resources", "vendor"}

# 会真正发起网络请求的引用
LOADED_ATTRS = re.compile(
    r"""(?:src|data-src|data-original)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))""",
    re.IGNORECASE,
)
LINK_HREF = re.compile(r"""<link\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))""", re.IGNORECASE)
ANCHOR_HREF = re.compile(r"""<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))""", re.IGNORECASE)
CSS_URL = re.compile(r"""url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]+))\s*\)""", re.IGNORECASE)
LOC = re.compile(r"<loc>\s*([^<\s]+)\s*</loc>", re.IGNORECASE)

# 首页导航断言：首页必须有导航链接，防止后台把菜单写坏后静默丢导航。
# 判定从宽（至少命中 NAV_MIN_HIT 个），这样以后增删一个合法栏目不会误报。
NAV_LINKS = ("/", "/archives", "/categories", "/tags", "/friend", "/about")
NAV_MIN_HIT = 5


def pick(match: re.Match) -> str:
    for group in match.groups():
        if group:
            return group.strip()
    return ""


def is_external(url: str) -> bool:
    return url.startswith("http://") or url.startswith("https://")


def host_of(url: str) -> str:
    try:
        return (urlparse(url).hostname or "").lower()
    except ValueError:
        return ""


def nav_path_of(url: str) -> str | None:
    """把首页里的一个 href 归一成站内路径（/archives/ → /archives）；不像站内链接返回 None。

    --minify 会把属性引号去掉（写成 href=/archives），所以匹配一律不依赖引号
    （ANCHOR_HREF 就是这么写的）；这里再去掉域名、查询串和结尾斜杠，
    即使 --baseURL 让导航渲染成绝对地址（https://wusitech.github.io/archives/）也不会漏判。
    """
    if not url or url.startswith(("#", "mailto:", "tel:", "javascript:", "data:")):
        return None
    parsed = urlparse(url)
    if parsed.scheme or url.startswith("//"):
        # 绝对地址只在指向本站时才算导航；外链导航（友链等）不算
        if parsed.scheme not in ("http", "https") or (parsed.hostname or "").lower() not in SELF_HOSTS:
            return None
    path = unquote(parsed.path or "")
    if not path.startswith("/"):
        path = "/" + path
    if path != "/":
        path = path.rstrip("/")
    return path or "/"


def internal_target(url: str, page: Path, out_dir: Path) -> Path | None:
    """把站内引用映射到产物里的文件路径；返回 None 表示不像站内资源。"""
    parsed = urlparse(url)
    if parsed.scheme or url.startswith("//"):
        return None
    path = unquote(parsed.path)
    if not path:
        return None
    if path.startswith("/"):
        target = out_dir / path.lstrip("/")
    else:
        target = (page.parent / path).resolve()
    # 目录形式（/posts/xxx/）→ index.html
    if path.endswith("/") or target.is_dir():
        return target / "index.html"
    return target


def main(argv=None) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except Exception:
            pass

    ap = argparse.ArgumentParser(description="校验构建产物：断链 / 外部资源 / sitemap / 首页导航")
    ap.add_argument("--dir", default="public", help="构建输出目录（默认 public/）")
    ap.add_argument("--allow", nargs="*", default=[], help="额外允许的外部域名（会发起请求的）")
    ap.add_argument("--max-report", type=int, default=15, help="每类问题最多列出多少条")
    args = ap.parse_args(argv)

    out_dir = Path(args.dir).resolve()
    if not out_dir.is_dir():
        print(f"[X] 找不到目录 {out_dir}（先 hugo 构建）", file=sys.stderr)
        return 2

    allowed_hosts = set(SELF_HOSTS) | {h.lower() for h in args.allow}

    def is_site_file(path: Path) -> bool:
        rel = path.relative_to(out_dir)
        return not (rel.parts and rel.parts[0] in VENDOR_DIRS)

    pages = sorted(p for p in out_dir.rglob("*.html") if "_internal" not in p.parts and is_site_file(p))
    css_files = sorted(p for p in out_dir.rglob("*.css") if is_site_file(p))
    if not pages:
        print(f"[X] {out_dir} 里没有 HTML，确定构建成功了吗？", file=sys.stderr)
        return 2

    missing: list[tuple[str, str]] = []
    blocked: list[tuple[str, str]] = []
    ignored_external = 0

    for page in pages:
        text = page.read_text(encoding="utf-8", errors="replace")
        rel_page = page.relative_to(out_dir).as_posix()

        loaded = [pick(m) for m in LOADED_ATTRS.finditer(text)]
        loaded += [pick(m) for m in LINK_HREF.finditer(text)]
        for url in loaded:
            if not url or url.startswith(("data:", "mailto:", "tel:", "javascript:", "#")):
                continue
            if is_external(url):
                host = host_of(url)
                if host and host not in allowed_hosts:
                    blocked.append((rel_page, url))
                continue
            target = internal_target(url, page, out_dir)
            if target is not None and not target.exists():
                missing.append((rel_page, url))

        # 站内锚点也检查（断链同样影响体验）
        for match in ANCHOR_HREF.finditer(text):
            url = pick(match)
            if not url or url.startswith(("#", "mailto:", "tel:", "javascript:", "data:")):
                continue
            if is_external(url):
                ignored_external += 1
                continue
            target = internal_target(url, page, out_dir)
            if target is not None and not target.exists():
                missing.append((rel_page, url))

    # CSS 里的 url()
    for css in css_files:
        text = css.read_text(encoding="utf-8", errors="replace")
        for match in CSS_URL.finditer(text):
            url = pick(match)
            if not url or url.startswith(("data:", "#")):
                continue
            if is_external(url):
                host = host_of(url)
                if host and host not in allowed_hosts:
                    blocked.append((css.relative_to(out_dir).as_posix(), url))
                continue
            target = internal_target(url, css, out_dir)
            if target is not None and not target.exists():
                missing.append((css.relative_to(out_dir).as_posix(), url))

    # sitemap
    # 注意：Hugo 会把 section 根（如 /posts/）也写进 sitemap，而主题往往没有对应的
    # section 模板、不产出 index.html。这种“目录下确实有页面”的条目按存在处理，
    # 真正写错路径（目录下什么都没有）才报错。
    sitemap_errors: list[str] = []
    sitemap = out_dir / "sitemap.xml"
    if sitemap.exists():
        text = sitemap.read_text(encoding="utf-8", errors="replace")
        for loc in LOC.findall(text):
            parsed = urlparse(loc)
            path = unquote(parsed.path)
            target = out_dir / path.lstrip("/")
            if path.endswith("/") or target.is_dir():
                if (target / "index.html").exists() or any(target.rglob("*.html")):
                    continue
                target = target / "index.html"
            if not target.exists():
                sitemap_errors.append(loc)
    else:
        sitemap_errors.append("(构建产物里没有 sitemap.xml)")

    # 首页导航
    # 只查首页：菜单是后台（导航栏目 / 站点文案集合）可改的，写坏之后首页会静默少一大块导航，
    # 断链检查发现不了（少了链接不算断链），所以单独断言一条。
    nav_errors: list[str] = []
    index_page = out_dir / "index.html"
    if not index_page.exists():
        nav_errors.append("(构建产物里没有 index.html，无法校验首页导航)")
    else:
        text = index_page.read_text(encoding="utf-8", errors="replace")
        found = set()
        for match in ANCHOR_HREF.finditer(text):
            path = nav_path_of(pick(match))
            if path:
                found.add(path)
        hit = [link for link in NAV_LINKS if link in found]
        if len(hit) < NAV_MIN_HIT:
            miss = [link for link in NAV_LINKS if link not in found]
            nav_errors.append(
                "首页 index.html 只命中 {}/{} 个导航链接（要求至少 {} 个）；"
                "命中：{}；缺失：{}".format(
                    len(hit),
                    len(NAV_LINKS),
                    NAV_MIN_HIT,
                    " ".join(hit) if hit else "(无)",
                    " ".join(miss) if miss else "(无)",
                )
            )

    def dump(title: str, items: list, fmt) -> None:
        print(f"  {title}: {len(items)}")
        for item in items[: args.max_report]:
            print(f"      - {fmt(item)}")
        if len(items) > args.max_report:
            print(f"      ... 还有 {len(items) - args.max_report} 条")

    print(f"检查目录：{out_dir}")
    print(f"  HTML 页面 {len(pages)} 个，CSS {len(css_files)} 个\n")
    dump("[1] 站内引用找不到文件", missing, lambda x: f"{x[0]}  ->  {x[1]}")
    dump("[2] 会真正请求的外部资源（不在允许清单）", blocked, lambda x: f"{x[0]}  ->  {x[1]}")
    dump("[3] sitemap 指向不存在的页面", sitemap_errors, lambda x: x)
    dump("[4] 首页导航链接缺失", nav_errors, lambda x: x)

    print(f"\n  正文里的普通外链（不发起资源请求，已忽略）：{ignored_external} 个")
    bad = len(missing) + len(blocked) + len(sitemap_errors) + len(nav_errors)
    if bad:
        print(f"\nRESULT: FAILED（{bad} 处问题）")
        return 1
    print("\nRESULT: ALL PASS（无断链、无未授权外部资源、sitemap 完整、首页导航正常）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
