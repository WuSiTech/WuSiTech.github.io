#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""rename_image.py —— 把仓库里的图片改名 / 移到子目录，并把所有引用一起改掉

为什么需要它
------------
Sveltia CMS（本仓库的后台，static/admin/sveltia-cms.js，v0.241.0）**没有「移动图片」的功能**，
连「重命名」也不接受带斜杠的名字 —— bundle 里的校验函数：

    jFe=({name:e,fileName:t,otherNames:n,folderNames:r=[]})=>{
      if(!e)return`empty`;
      if(e.includes(`/`)||!t)return`character`;      // ← 带 / 直接判为非法字符
      if(e.startsWith(`.`))return`leading_dot`; ... }

对应提示语 `enter_new_name_for_asset_error.character` = "File name cannot contain special
characters."。所以后台里唯一能把图片挪个位置的办法是**改名/重新上传**，而改名之后
所有引用它的地方（文章 front matter 的 cover/banner、正文 markdown、config 里的
logo/头像、data 里的卡片图 …）都会指向一个不存在的文件。

这个脚本做两件事：把文件移过去 + 把仓库里对它的引用一起改掉。

它改什么、不改什么
------------------
* 会改：content/**、config/**、data/**、static/** 里对这张图的引用（与 tools/auto_webp.py 同一套目录）。
* 只报告不会改：layouts/**、i18n/**、functions/**、archetypes/**、themes/**。
  themes/ 是 git 子模块 —— 如果图被主题引用，脚本默认直接拒绝改名（加 --force 才硬来）。
* 引用必须写成「带路径」的形式才认得出（`/images/a.jpg`、`../images/a.jpg`、
  `images/a.jpg`、`static/images/a.jpg`）。只写裸文件名 `a.jpg` 时无法判断相对基准：
    - 同目录改名（a.jpg → b.jpg）：裸引用改成 b.jpg（安全）；
    - 移到子目录（a.jpg → sub/a.jpg）：默认**拒绝执行**并列出位置，让你先手工确认；
      加 --rewrite-bare 才把它们改成 `sub/a.jpg`。

默认 dry-run
------------
不加 --apply 只预演（一个字都不写）。真正落盘要显式 --apply。

用法
----
    # 预演：把 static/images/photo.jpg 改名成 static/images/cover.jpg
    python tools/rename_image.py static/images/photo.jpg static/images/cover.jpg

    # 真做：移进子目录 posts/
    python tools/rename_image.py static/images/photo.jpg static/images/posts/photo.jpg --apply

    # 裸文件名引用也想一起改（确认过它们是相对 images/ 写的才用）
    python tools/rename_image.py static/images/a.jpg static/images/sub/a.jpg --apply --rewrite-bare

    # 改完之后自己提交（脚本绝不 commit / push）
    git add -A && git commit -m "图片改名：photo.jpg → cover.jpg" && git push

退出码：0 正常（含 dry-run）；2 参数/安全检查不通过（什么都没改）；1 落盘过程中有失败（--strict 时）。

只依赖 Python 标准库 + 本目录的 auto_webp.py（不联网、不引入第三方依赖）。
"""

from __future__ import annotations

import argparse
import importlib.util
import os
import posixpath
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent

# ---- 允许被改名的图片扩展名（含 svg / 矢量；扩展名默认不允许变）---------------
IMAGE_EXTS = {".jpg", ".jpe", ".jpeg", ".jfif", ".png", ".bmp", ".dib", ".gif",
              ".webp", ".svg", ".avif", ".heic", ".heif", ".tif", ".tiff", ".ico"}
# 默认「媒体根目录」（对应 static/admin/config.yml 的 media_folder）。
# 引用里出现「<媒体根目录名>/」时就认为它指向这个媒体库。
DEFAULT_MEDIA_ROOT = "static/images"
# 允许出现在路径/URL 里的字符（用来在引用里向左扩张出完整 token）。
# 故意排除空白、引号、括号、尖括号、逗号、分号、竖线、星号、问号：
# 它们都是 markdown / yaml / html 的定界符，跨过去就会吃掉别的字段。
PATH_CHARS = r"[^\s()\"'<>|;,*?]"
# 只报告不改写的目录（themes 是子模块；其它是模板/函数，不在媒体的引用改写范围内）
REPORT_ONLY_DIRS = ["layouts", "i18n", "functions", "archetypes", "themes"]


def load_auto_webp():
    """复用 tools/auto_webp.py 的文件遍历 / 剪枝 / 体积格式化（同一套口径）。"""
    path = HERE / "auto_webp.py"
    if not path.exists():
        sys.exit(f"找不到 {path}（rename_image.py 依赖 tools/auto_webp.py）")
    spec = importlib.util.spec_from_file_location("auto_webp", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


AW = load_auto_webp()


# ---------------------------------------------------------------- 引用匹配 / 改写
def token_regex(old_tail: str) -> re.Pattern:
    """匹配引用里的「…/旧尾巴」，把前面的路径部分捕进 path 组。

    * 前缀被贪婪地吃掉（`/`、`../`、`static/`、`https://host/` 都能吃到），
      但不跨空白/引号/括号，所以不会吃进别的字段。
    * 前后都要卡边界，`xa.jpg`、`b-a.jpg`、`a.jpg.bak`、`a.jpgx` 都不命中。
    """
    return re.compile(
        r"(?P<path>" + PATH_CHARS + r"*[/\\])?"
        r"(?<![\w.\-])(?P<name>" + re.escape(old_tail) + r")(?![\w.\-])"
    )


def media_marker(media_root: str) -> str:
    """引用里用来认定「这是本站媒体库」的标记，例如 static/images → images/。"""
    return posixpath.basename(media_root.rstrip("/")) + "/"


def match_kind(path_part: str | None, marker: str) -> str:
    """命中类别：path=带路径的引用，bare=裸文件名，other=指向别的目录（不是这张图）。"""
    pn = (path_part or "").replace("\\", "/")
    if pn.endswith(marker):
        return "path"
    if pn == "":
        return "bare"
    return "other"


def count_path_refs(text: str, old_tail: str, marker: str) -> int:
    """数「还指向媒体库里旧位置」的引用条数。

    只看 kind == "path"（即引用写成了 <媒体库名>/<旧相对路径>）。
    不能简单地对整段文本做 token_regex.search —— 移动之后新路径里依然含旧文件名，
    例如 cover.jpg → posts/cover.jpg 之后 `/images/posts/cover.jpg` 也会命中
    `cover.jpg`，但它的目录部分不是 `images/`（而是 `images/posts/`），分类是 other，
    所以不会被误判成「残留引用」。
    """
    rx = token_regex(old_tail)
    return sum(1 for m in rx.finditer(text)
               if match_kind(m.group("path"), marker) == "path")


def plan_rewrite(text: str, old_tail: str, new_tail: str, marker: str,
                 rewrite_bare: bool = False):
    """算出这段文本要改成什么。

    返回 (新文本, changes, ambiguous, other_hits)：
      changes     [(旧片段, 新片段, 类别, 行号)]  真正要改的位置
      ambiguous   [旧片段]                       裸文件名且换了目录 → 无法自动判断
      other_hits  [旧片段]                       同名但写在别的目录下（不碰）

    裸文件名（引用里没有任何目录）的判定：
      * 同目录改名 a.jpg → b.jpg：改成 b.jpg，语义不变，安全；
      * 换目录 a.jpg → sub/a.jpg：默认不猜（ambiguous），--rewrite-bare 才改成 sub/a.jpg。
    """
    rx = token_regex(old_tail)
    same_dir = posixpath.dirname(old_tail) == posixpath.dirname(new_tail)
    changes, ambiguous, others = [], [], []

    def repl(m: re.Match) -> str:
        raw_path = m.group("path") or ""
        line = text.count("\n", 0, m.start()) + 1
        kind = match_kind(m.group("path"), marker)
        if kind == "path":
            new = raw_path + new_tail
            changes.append((m.group(0), new, "path", line))
            return new
        if kind == "bare":
            if same_dir:
                new = posixpath.basename(new_tail)
                changes.append((m.group(0), new, "bare-same-dir", line))
                return new
            if rewrite_bare:
                changes.append((m.group(0), new_tail, "bare-moved", line))
                return new_tail
            ambiguous.append(m.group(0))
            return m.group(0)
        others.append(m.group(0))
        return m.group(0)

    return rx.sub(repl, text), changes, ambiguous, others


# ---------------------------------------------------------------- 参数校验
def die(msg: str, code: int = 2):
    print(f"[!] {msg}", file=sys.stderr)
    sys.exit(code)


def norm_rel(root: Path, raw: str, what: str) -> str:
    """把命令行给的路径规范成「仓库相对 posix 路径」，顺手挡掉绝对路径 / .. 逃逸。"""
    s = (raw or "").strip().replace("\\", "/")
    if not s:
        die(f"{what}不能为空")
    if re.match(r"^[A-Za-z]:", s) or s.startswith("/") or s.startswith("//"):
        die(f"{what}必须是仓库相对路径（不要写绝对路径）：{raw}")
    parts = [p for p in s.split("/") if p not in ("", ".")]
    if any(p == ".." for p in parts):
        die(f"{what}不能含 ..（不许跳出仓库）：{raw}")
    if not parts:
        die(f"{what}不是有效路径：{raw}")
    abs_p = (root / Path(*parts)).resolve()
    try:
        rel = abs_p.relative_to(root)
    except ValueError:
        die(f"{what}落到仓库之外了：{raw}")
    return rel.as_posix()


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="rename_image.py",
        description="把图片改名 / 移到子目录，并同步改写仓库里对它的引用（默认 dry-run）。",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="示例：\n"
               "  python tools/rename_image.py static/images/a.jpg static/images/cover.jpg\n"
               "  python tools/rename_image.py static/images/a.jpg static/images/sub/a.jpg --apply\n"
               "  python tools/rename_image.py static/images/a.jpg static/images/sub/a.jpg --apply --rewrite-bare\n")
    p.add_argument("source", help="原图（仓库相对路径），如 static/images/photo.jpg")
    p.add_argument("dest", help="目标（仓库相对路径），如 static/images/posts/photo.jpg")
    p.add_argument("--root", default=".", help="仓库根目录（默认当前目录）")
    p.add_argument("--apply", action="store_true",
                   help="真的落盘：移动文件 + 改写引用（默认只预演）")
    p.add_argument("--dry-run", action="store_true", help="显式预演（默认行为，起强调作用）")
    p.add_argument("--media-root", default=DEFAULT_MEDIA_ROOT,
                   help=f"媒体库根目录（默认 {DEFAULT_MEDIA_ROOT}），用来认定引用里的「images/」标记")
    p.add_argument("--rewrite-bare", action="store_true",
                   help="裸文件名引用（a.jpg）在换目录时也一起改写成新相对路径（默认拒绝执行）")
    p.add_argument("--allow-ext-change", action="store_true",
                   help="允许改扩展名（默认禁止：扩展名和真实格式不一致会让浏览器/后台误判）")
    p.add_argument("--force", action="store_true",
                   help="跳过「被主题引用」「裸引用无法判定」这两类硬拒绝（危险，自己确认过再用）")
    p.add_argument("--strict", action="store_true",
                   help="有「只报告没改」的残留引用时以退出码 1 结束")
    return p


# ---------------------------------------------------------------- 主流程
def main(argv=None) -> int:
    for _s in (sys.stdout, sys.stderr):
        try:
            _s.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

    args = build_parser().parse_args(argv)
    root = Path(args.root).resolve()
    if not (root / ".git").exists():
        die(f"{root} 不像 git 仓库根目录（缺 .git）", 2)

    apply = bool(args.apply) and not bool(args.dry_run)
    src_rel = norm_rel(root, args.source, "原图")
    dst_rel = norm_rel(root, args.dest, "目标")
    src, dst = root / src_rel, root / dst_rel

    # ---- 源文件检查
    if not src.is_file():
        die(f"原图不存在：{src_rel}")
    if src.suffix.lower() not in IMAGE_EXTS:
        die(f"原图不像图片（扩展名 {src.suffix or '无'}）：{src_rel}")
    if src.stat().st_size == 0:
        die(f"原图是空文件：{src_rel}")
    if src_rel == dst_rel:
        print(f"原图与目标相同（{src_rel}），没有需要做的事。")
        return 0
    # ---- 目标检查
    if src.suffix.lower() != dst.suffix.lower() and not args.allow_ext_change:
        die(f"扩展名必须保持一致（{src.suffix} → {dst.suffix}）；"
            f"改名不改格式，确实要改加 --allow-ext-change")
    if dst.exists():
        die(f"目标已存在，拒绝覆盖：{dst_rel}")

    media_root = (args.media_root or DEFAULT_MEDIA_ROOT).replace("\\", "/").strip("/")
    marker = media_marker(media_root)
    src_in_media = src_rel == media_root or src_rel.startswith(media_root + "/")
    dst_in_media = dst_rel == media_root or dst_rel.startswith(media_root + "/")
    if not src_in_media:
        die(f"原图不在媒体库 {media_root}/ 下：{src_rel}\n"
            f"    引用是按「<媒体库名>/<相对路径>」认的，换别的目录就没法可靠改写。"
            f"确实要改这个文件请显式指定它所在目录，例如 --media-root {posixpath.dirname(src_rel)}")
    if not dst_in_media:
        die(f"原图在媒体库 {media_root}/ 里，目标必须在同一个媒体库里（否则引用基准就变了）："
            f"{dst_rel}")

    old_tail = src_rel[len(media_root) + 1:] if src_in_media else src_rel
    new_tail = dst_rel[len(media_root) + 1:] if dst_in_media else dst_rel
    same_dir = posixpath.dirname(old_tail) == posixpath.dirname(new_tail)

    print("=" * 72)
    print("rename_image.py" + ("（预演，不改任何文件）" if not apply else "（--apply：真的要落盘）"))
    print("=" * 72)
    print(f"仓库：{root}")
    print(f"原图：{src_rel}")
    print(f"目标：{dst_rel}")
    print(f"媒体库：{media_root}/（引用标记 {marker!r}）；同目录改名：{'是' if same_dir else '否（=移动）'}")

    # ---- 扫描引用 --------------------------------------------------------
    rx = token_regex(old_tail)
    rewritable, ambiguous, others = {}, [], []
    for p, text in AW.iter_ref_files(root, AW.REF_DIRS):
        new_text, changes, amb, oth = plan_rewrite(text, old_tail, new_tail, marker,
                                                   args.rewrite_bare)
        rel = p.relative_to(root).as_posix()
        if amb:
            lines = sorted({text.count("\n", 0, m.start()) + 1
                            for m in rx.finditer(text)
                            if match_kind(m.group("path"), marker) == "bare"})
            ambiguous.append((rel, len(amb), lines, amb[:3]))
        if oth:
            others.append((rel, len(oth), oth[:3]))
        if changes:
            rewritable[rel] = (p, text, new_text, changes)

    # 只报告、不改写的目录（layouts / themes 等）
    leftover = []
    for p, text in AW.iter_ref_files(root, REPORT_ONLY_DIRS,
                                     prune_dirs=AW.PRUNE_DIRS - {"themes"}):
        n = count_path_refs(text, old_tail, marker)
        if n:
            leftover.append((p.relative_to(root).as_posix(), n))

    if rewritable:
        print("\n将改写的引用：")
        for rel, (_p, _text, _n, changes) in sorted(rewritable.items()):
            for old, new, kind, line in changes:
                print(f"  {rel}:{line}  {old} → {new}   [{kind}]")
    else:
        print("\n没有找到带路径的引用（也许这张图还没被文章用过）。")
    if others:
        print("\n同名但写在别的目录下（不是这张图，保持原样）：")
        for rel, n, samples in others:
            print(f"  {rel}（{n} 处）：{'、'.join(samples)}")

    # ---- 硬拒绝 ----------------------------------------------------------
    blocked = False
    if ambiguous:
        print("\n[!] 有裸文件名引用（没有路径），换目录后无法自动判断该怎么改：")
        for rel, n, lines, samples in ambiguous:
            print(f"  {rel}（{n} 处，行 {lines}）：{'、'.join(samples)}")
        if args.rewrite_bare:
            print("    已加 --rewrite-bare：会按新的相对路径改写它们。")
        elif args.force:
            print("    已加 --force：这些裸引用保持原样（可能断链，自己确认）。")
        else:
            print(f"    处理办法：确认它们是相对 {media_root}/ 写的 → 加 --rewrite-bare；"
                  f"或先手工把那几处改掉再跑。")
            blocked = True
    if leftover:
        print("\n[!] 下面这些目录不在自动改写的范围内，需要你自己确认：")
        for rel, n in leftover:
            print(f"  {rel}（{n} 处）")
        theme_hits = [x for x in leftover if x[0].startswith("themes/")]
        if theme_hits and not args.force:
            print("    themes/ 是 git 子模块，改它等于改主题 —— 默认拒绝。"
                  "确实要改名请加 --force，并自己改主题里的引用。")
            blocked = True
    if blocked:
        die("安全检查未通过，什么都没改。", 2)

    # ---- dry-run 到此为止 -------------------------------------------------
    if not apply:
        print("\n[dry-run] 会做：")
        print(f"  1. 移动 {src_rel} → {dst_rel}")
        print(f"  2. 改写 {len(rewritable)} 个文件里的 "
              f"{sum(len(v[3]) for v in rewritable.values())} 处引用")
        for rel, (_p, _text, _n, changes) in sorted(rewritable.items()):
            bare_same = [c for c in changes if c[2] == "bare-same-dir"]
            if bare_same:
                print(f"     （{rel} 里有 {len(bare_same)} 处裸文件名，按同目录改名处理）")
        print("[dry-run] 未移动文件、未改写引用。确认无误后加 --apply 重跑。")
        print("\nRESULT: OK (dry-run)")
        return 0

    # ---- 落盘：先改引用，全部成功后再移动文件（谁都不许半途而废）----------
    print("\n改写引用：")
    failed = []
    for rel, (p, _text, new_text, changes) in sorted(rewritable.items()):
        tmp = p.with_suffix(p.suffix + ".rename.tmp")
        try:
            tmp.write_bytes(new_text.encode("utf-8"))   # UTF-8 无 BOM，LF 原样保留
            os.replace(tmp, p)
            print(f"  {rel}：改写 {len(changes)} 处")
        except OSError as exc:
            tmp.unlink(missing_ok=True)
            failed.append(f"{rel}：{exc}")
            print(f"  [!] {rel} 改写失败：{exc}")
    if failed:
        print("\n有引用文件改写失败，为免出现「文件已移走、引用还指着旧路径」，不移动文件。")
        for f in failed:
            print(f"  - {f}")
        print("RESULT: FAILED")
        return 1

    print("\n移动文件：")
    dst.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.replace(src, dst)
    except OSError as exc:
        print(f"  [!] 移动失败：{exc}")
        print("RESULT: FAILED")
        return 1
    print(f"  {src_rel} → {dst_rel}")

    # ---- 复核 ------------------------------------------------------------
    left = []
    for p, text in AW.iter_ref_files(root, AW.REF_DIRS):
        if count_path_refs(text, old_tail, marker):
            left.append(p.relative_to(root).as_posix())
    print("\n复核（可改写范围内是否还有指向旧位置的引用）：")
    if left:
        print(f"  [!] 仍有残留：{left}")
    else:
        print("  没有残留。")
    left_ro = []
    for p, text in AW.iter_ref_files(root, REPORT_ONLY_DIRS,
                                     prune_dirs=AW.PRUNE_DIRS - {"themes"}):
        if count_path_refs(text, old_tail, marker):
            left_ro.append(p.relative_to(root).as_posix())
    if left_ro:
        print("  这些目录不在改写范围，请自行确认：")
        for rel in left_ro:
            print(f"    {rel}")

    print("\n下一步：git status 看一眼，然后自己提交（本脚本不会 commit / push）：")
    print(f'  git add -A && git commit -m "图片改名：{Path(src_rel).name} → {Path(dst_rel).name}" '
          f'&& git push')
    if failed or (left and not args.force):
        print("RESULT: FAILED")
        return 1
    if args.strict and left_ro:
        print("RESULT: OK (with unwritten references, --strict)")
        return 1
    print("RESULT: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
