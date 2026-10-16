#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""auto_webp.py —— 把仓库里新增/修改的位图自动转成 WebP，并改写引用、删掉原图

给 .github/workflows/webp.yml 用：站长在后台或 GitHub 网页上传 jpg/png/heic 后，
push 到 main 时本脚本把 static/images/ 下这些新图转成同名 .webp，
顺带把 content/**、config/**、data/**、static/** 里对旧文件名的引用改成 .webp，最后删掉原图。
（后台 /admin/ 上传本来就会转码，见 static/admin/config.yml 的 media_libraries；
  本脚本是「绕过后台提交」时的兜底，也是修复存量图片的批量工具。）

设计要点
--------
* 转换能力复用同目录的 tools/img2webp.py（Pillow），不另起一套编码逻辑。
* 不放大：img2webp 的 --no-upscale 等价语义（compute_scale 会把缩放系数夹到 ≤1）；
  只有显式给了 --max-dim 且原图比它大时才缩小。
* 若生成的 webp 比原图还大（纯色/极小图很常见）→ 删掉 webp、保留原图，只在报告里说明。
* 跳过 gif（可能是动图）、svg（矢量）、已经是 webp 的、以及所有未知扩展名。
* 删原图的前提是「原文件名的所有引用都已成功改写」且「新 webp 确实存在」，
  任何一处引用改不了（比如落在 --include 之外的目录）就不删，宁可留两个文件。
* 单张失败只记一笔，不中断其它图片；末尾汇总，--strict 时以退出码 1 反映失败。
* 默认 dry-run：只报告不改文件。真正落盘要显式加 --apply。

用法
----
    python tools/auto_webp.py                            # 预演：HEAD^..HEAD 的新图，不落盘
    python tools/auto_webp.py --apply                    # 真正转换 + 改写引用 + 删原图
    python tools/auto_webp.py --apply --range origin/main..HEAD
    python tools/auto_webp.py --apply --files static/images/a.jpg static/images/b.png
    python tools/auto_webp.py --apply --target-kb 200 --max-dim 2560
    python tools/auto_webp.py --all --apply              # 存量图片：扫 static/images/** 全量
    python tools/auto_webp.py --apply --range all        # 同上（--range all 等价于 --all）

存量模式（--all / --range all）
-------------------------------
不看 git diff，直接把 static/images/** 下所有「还不是 webp 的位图」列成候选。
两重保护，确保主题素材绝不被碰：
  1) ALL_MODE_EXCLUDE：显式排除清单（主题鼠标指针 / 404 背景 / 太极图标）；
  2) 主题引用守卫 THEME_REF_GUARD：任何被 themes/** 里文本引用到的图片一律跳过。
     themes/ 是 git 子模块、且被 PRUNE_DIRS 排除在「引用改写」之外，所以转换 + 删原图
     一定会把主题里的引用改断 —— 宁可不转，也不动。

退出码：0 正常（含「跳过」、含「转成 webp 反而更大所以放弃」）；
        默认情况下单张失败也返回 0（失败的那张原图一定还在，不会丢东西），
        加 --strict 才返回 1。CI 里用默认行为，单张坏图不阻断整条流水线。
"""

from __future__ import annotations

import argparse
import importlib.util
import os
import re
import subprocess
import sys
from pathlib import Path

# ---------------------------------------------------------------- 可调参数（常量）
# 有损质量。80 是「肉眼与 85 几乎无差、体积明显更小」的常用折中；不要低于 75。
WEBP_QUALITY = 80
# 体积上限（KB）。给得很宽松，只用来兜住个别超大图；None 表示完全不限制。
# 触达上限时会自动往下降质量（img2webp 内部二分），再小也不会低于 1。
TARGET_KB = 600
# 最长边上限。必须配合「不放大」一起用：只有原图最长边超过它才缩小，小图原样保留。
# 站内现有 webp（banner 1600 宽、文章插图 ~960）都在这条线以内，等于默认不动尺寸。
MAX_DIM = 2560
# 编码方法 0-6，越大越慢越小。CI 里图不多，用 5。
METHOD = 5
# 要处理的源格式（小写，含点）。这里只列「位图」，不含 svg（矢量）与 webp（已经是目标格式）。
BITMAP_EXTS = {".jpg", ".jpe", ".jpeg", ".jfif", ".png", ".bmp", ".dib",
               ".tif", ".tiff", ".heic", ".heif", ".avif"}
# 明确跳过并在日志里说明原因的格式。
SKIP_REASON = {
    ".webp": "已经是 webp",
    ".svg": "矢量图，不能栅格化（保持清晰、可缩放）",
    ".gif": "可能是动图，Pillow 单帧转换会毁掉动画，一律跳过",
    ".ico": "图标/多尺寸容器，跳过",
    ".mp4": "视频，不是图片",
    ".pdf": "文档，不是图片",
}
# 只处理这些目录下的文件（push 触发的范围）
DEFAULT_PATTERNS = ["static/images/**"]

# ---- 存量模式（--all）专用：显式排除清单 -------------------------------------
# themes/reimu 是 git 子模块，主题用这些图当「鼠标指针 / 404 背景 / 太极图标」，
# 它们的引用写在 themes/** 里，本脚本不会（也不该）去改子模块，所以一旦转换 + 删原图，
# 主题里的引用就断了。清单里的东西一律不动，连「转成 webp 更小」也不转。
# （下面 THEME_REF_GUARD 是更彻底的第二道守卫：凡被 themes/** 引用到的图都跳过，
#   所以这份清单即使漏了某一项，也不会真的改坏主题；清单的作用是「快 + 可读」。）
ALL_MODE_EXCLUDE = [
    "static/images/cursor/*.png",  # 主题鼠标指针：themes/reimu/assets/css/*.scss 里 $cursor-*
    "static/images/reimu.png",     # 主题 404 / 首页背景：themes/reimu/layouts/**/*.html 里 images/reimu.png
    "static/images/taichi*.png",   # 主题赞助图标默认图：themes/reimu/assets/css/main.scss 里 ../images/taichi.png
]
# 主题目录（在 PRUNE_DIRS 里，不能被改写引用 —— 只用来做「引用守卫」扫描）
THEME_DIR = "themes"
# 存量模式下不必列出来的格式：webp 已经是目标格式，svg 是矢量（会被明确跳过，但刷屏）
ALL_MODE_QUIET_EXTS = {".webp", ".svg"}
# 被主题引用而跳过的原因说明（THEME_REF_GUARD 命中时用）
THEME_SKIP_NOTE = (f"被 {THEME_DIR}/ 里的主题文件引用（子模块，本脚本不改写它的引用），"
                   f"跳过以免主题断图")
# 引用改写时要扫描的目录（仓库相对路径）+ 允许改写的文本扩展名
REF_DIRS = ["content", "config", "data", "static"]
REF_EXTS = {".md", ".markdown", ".mdx", ".html", ".htm", ".toml", ".yaml", ".yml",
            ".json", ".txt", ".js", ".mjs", ".cjs", ".ts", ".css", ".scss",
            ".xml", ".csv", ".tsv", ".svg", ".env", ".conf", ".ini"}
# 永远不看的目录（构建产物 / 依赖 / 校验目录）
PRUNE_DIRS = {".git", "public", "resources", "node_modules", ".venv", "venv",
              "themes", ".verify-webp", ".verify-docx", ".verify-three",
              "_site", "dist", "build", ".hugo_build.lock"}

HERE = Path(__file__).resolve().parent


# ---------------------------------------------------------------- 小工具
def load_img2webp():
    """以模块方式载入同目录的 tools/img2webp.py（复用它的编码/缩放逻辑）。"""
    path = HERE / "img2webp.py"
    if not path.exists():
        sys.exit(f"找不到 {path}（auto_webp.py 依赖 tools/img2webp.py）")
    spec = importlib.util.spec_from_file_location("img2webp", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def human(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if abs(n) < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024.0
    return f"{n:.1f} GB"


def glob_to_regex(pattern: str) -> re.Pattern:
    """把 static/images/** 这类 glob 编译成正则（** 跨目录，* 不跨目录）。"""
    out, i, n = "", 0, len(pattern)
    while i < n:
        c = pattern[i]
        if c == "*":
            if pattern.startswith("**", i):
                out += ".*"
                i += 2
                if i < n and pattern[i] == "/":
                    i += 1  # **/ 也允许匹配「零层目录」
                continue
            out += "[^/]*"
        elif c == "?":
            out += "[^/]"
        else:
            out += re.escape(c)
        i += 1
    return re.compile("^" + out + "$")


def in_scope(rel: str, patterns) -> bool:
    rel = rel.replace("\\", "/")
    return any(p.match(rel) for p in patterns)


def base_dir_of(pattern: str) -> str:
    """glob 里第一个通配符之前的部分就是这次扫描的根目录（static/images/** → static/images）。"""
    cut = len(pattern)
    for i, ch in enumerate(pattern):
        if ch in "*?[":
            cut = i
            break
    return pattern[:cut].rstrip("/")


def iter_all_files(root: Path, glob_patterns):
    """存量模式：把 glob_patterns 覆盖到的目录整个走一遍，产出仓库相对路径（升序）。

    只产出「看起来是位图」的文件；已经是 webp / svg 的（ALL_MODE_QUIET_EXTS）
    以及 ALL_MODE_EXCLUDE 命中的直接不列出来，免得报告被几十行「跳过」刷屏。
    参数收的是 glob 字符串（不是编译好的正则），方便直接拿 DEFAULT_PATTERNS 调用。
    """
    patterns = [glob_to_regex(p) for p in glob_patterns]
    excl = [glob_to_regex(p) for p in ALL_MODE_EXCLUDE]
    out, seen = [], set()
    for pattern in glob_patterns:
        base = base_dir_of(pattern)
        base_abs = root / base if base else root
        if not base_abs.is_dir():
            print(f"[!] --all：{base or '.'} 不是目录，跳过")
            continue
        for cur, subdirs, names in os.walk(base_abs):
            subdirs[:] = [s for s in subdirs if s not in PRUNE_DIRS]
            for nm in names:
                p = Path(cur) / nm
                ext = p.suffix.lower()
                if ext not in BITMAP_EXTS or ext in ALL_MODE_QUIET_EXTS:
                    continue
                rel = p.relative_to(root).as_posix()
                if rel in seen or not in_scope(rel, patterns) or in_scope(rel, excl):
                    continue
                seen.add(rel)
                out.append(rel)
    return sorted(out)


def run_git(args, root: Path):
    proc = subprocess.run(["git", "-C", str(root), *args],
                          capture_output=True, text=True, encoding="utf-8", errors="replace")
    if proc.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} 失败：{(proc.stderr or '').strip()}")
    return proc.stdout


def files_from_git(root: Path, rng: str):
    """取某段提交里新增/修改（A/M）的文件名，顺带给出新增（A）的那些。"""
    out = run_git(["diff", "--name-status", "--diff-filter=AM", "--no-renames", rng], root)
    changed, added = [], set()
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) < 2:
            continue
        status, path = parts[0].strip(), parts[-1].strip()
        changed.append(path)
        if status.startswith("A"):
            added.add(path)
    return changed, added


def resolve_range(root: Path, explicit: str | None):
    """决定 git 的对比范围：优先命令行/环境变量，否则 HEAD^..HEAD，最后退回 HEAD。"""
    if explicit:
        return explicit
    env_before = os.environ.get("WEBP_BASE_SHA") or os.environ.get("GITHUB_EVENT_BEFORE") or ""
    env_after = os.environ.get("WEBP_HEAD_SHA") or os.environ.get("GITHUB_SHA") or "HEAD"
    zero = set("0")
    if env_before and set(env_before) != zero:
        try:
            run_git(["cat-file", "-e", f"{env_before}^{{commit}}"], root)
            return f"{env_before}..{env_after}"
        except RuntimeError:
            pass
    for cand in ("HEAD^..HEAD", "HEAD"):
        try:
            if cand == "HEAD":
                run_git(["rev-parse", "--verify", "HEAD"], root)
                return cand
            run_git(["rev-parse", "--verify", "HEAD^"], root)
            return cand
        except RuntimeError:
            continue
    return None


# 允许出现在文件名前面的「边界字符」（路径分隔符、引号、括号、空白等）
BOUNDARY = "\\s/\\\\'\"()\\[\\]{}=:;,|*"
# 文件名前面的路径部分（/images/、./sub/ 等），引用改写的报告里用来区分各种写法。
# 注意 [^/]* 里不能再放任意字符：否则 "b-a.png" 会被当成「路径 b- + 文件名 a.png」。
PATH_PREFIX = r"(?:[^\s()\"'<>/\\]*[/\\]+)?"
_KEYS = ("markdown", "html")


def ref_regex(name: str) -> re.Pattern:
    """按「完整文件名 + 明确边界」匹配，既不漏正常引用，也不误伤同名片段。

    * markdown 图片/链接：`](/images/a.png)` / `](a.png)`
    * html / css：`src="/images/a.png"`、`url(/images/a.png)`
    * 裸路径：`/images/a.png`、`./a.png`、`a.png`
    * 配置值：`cover: /images/a.png`
    前一个字符只允许行首或 BOUNDARY 里的字符（空白 / `/` / `\\` / 引号 / 括号 /
    `=` / `:` / `,` / `;` / `|` / `*`），所以 b-a.png、xa.png 不会被误伤；
    后一个字符不能是字母/数字/下划线/点/连字符，所以 a.png 不会命中
    a.png.bak、a.png-old、a.pngx。
    命中结果在 groupdict() 里带写法名字（markdown / html / code / bare），
    报告里会打出来，方便审计。
    """
    b = f"[{BOUNDARY}]"
    esc = re.escape(name)
    # 前缀 = 「路径（以 / 或 \ 开头）」或「边界字符」，二选一；整体可选。
    # 关键：路径那一支必须自己带上前导分隔符，否则 b-a.png 会被当成「路径 b- + 文件名 a.png」。
    # 前导边界用 lookbehind 打在【前缀的起点】上，保证 b-a.png / xa.png 这类
    # 「文件名只是更长标识符的一截」不会被误伤。
    pre = r"(?:\\?/(?:[^\s()\"'<>]*[/\\])?|(?<![^\s/\\'\"()\[\]{}=:;,|*])" + b + r")?"
    # 末尾统一要求「文件名后面不是字母/数字/下划线/点/连字符」，
    # 并且文件名前面【紧邻】的字符也不能是这些 —— 双保险，确保只命中完整文件名。
    tail = r"(?<![\w.\-])" + esc + r"(?![\w.\-])"
    alts = [
        r"(?P<markdown>\]\()" + pre + tail + r"(?=[)\s\"'#>?])",
        r"(?P<html>[\"'\(])" + pre + tail + r"(?=[\"')\s#>?])",
        pre + tail,
    ]
    return re.compile("|".join(alts))


def _keep_prefix(match: re.Match, name: str) -> str:
    """取「文件名前面那一段」（路径 + 边界字符），替换时原样保留。

    注意不能直接拿 group(0)：各分支捕获组只覆盖前缀，而 group(0) 是整个命中，
    里面还含旧文件名。这里用「命中结尾 - 文件名长度」算出文件名的起点，
    起点之前的内容才是要保留的前缀。
    """
    start = match.end() - len(name)
    return match.string[match.start():start]


def _boundary_of(match: re.Match):
    """返回 (命中组名, 用于报告)；没有命名组命中就是裸路径/配置值那一支。"""
    for key in _KEYS:
        if match.group(key) is not None:
            return key
    return ""


def iter_ref_files(root: Path, dirs, prune_dirs=None):
    """遍历可改写的文本文件，产出 (路径, 文本)。

    跳过 .git/public/resources/themes 等目录、二进制文件、图片（扩展名不在 REF_EXTS）
    和超过 4MB 的大文件。用 read_bytes 一次读完，避免 Windows 上文件句柄被 hold 住。
    prune_dirs 用来临时换一套剪枝集合（主题引用守卫要反过来「只扫 themes/」）。
    """
    prune = PRUNE_DIRS if prune_dirs is None else prune_dirs
    for d in dirs:
        base = root / d
        if not base.is_dir():
            continue
        for cur, subdirs, names in os.walk(base):
            subdirs[:] = [s for s in subdirs if s not in prune]
            for nm in names:
                p = Path(cur) / nm
                if p.suffix.lower() not in REF_EXTS:
                    continue
                try:
                    if p.stat().st_size > 4 * 1024 * 1024:
                        continue
                    raw = p.read_bytes()
                except OSError:
                    continue
                if b"\x00" in raw:  # 二进制
                    continue
                try:
                    text = raw.decode("utf-8")
                except UnicodeDecodeError:
                    continue
                yield p, text


def theme_refs(root: Path, name: str):
    """扫 themes/** 里是否引用了 name（文件名或「目录/文件名」尾巴）。

    返回 [(相对路径, 次数)]。themes/ 是 git 子模块，被 PRUNE_DIRS 排除在引用改写之外，
    所以「被主题引用」= 转换 + 删原图一定断图 → 调用方据此跳过这张图。
    """
    rx = ref_regex(name)
    hits = []
    for p, text in iter_ref_files(root, [THEME_DIR], prune_dirs=PRUNE_DIRS - {THEME_DIR}):
        n = len(list(rx.finditer(text)))
        if n:
            hits.append((p.relative_to(root).as_posix(), n))
    return hits


def count_refs(root: Path, name: str, dirs=REF_DIRS):
    """返回 name 在可改写文本里出现的 (相对路径, 总次数, 行号列表)。"""
    rx = ref_regex(name)
    hits = []
    for p, text in iter_ref_files(root, dirs):
        found = list(rx.finditer(text))
        if found:
            lines = sorted({text.count("\n", 0, m.start()) + 1 for m in found})
            hits.append((p.relative_to(root).as_posix(), len(found), lines))
    return hits


def rewrite_refs(root: Path, old_name: str, new_name: str, dirs=REF_DIRS):
    """把所有文本里的旧文件名改成新文件名。返回 (改动列表, 命中总数, 成功改写数)。"""
    rx = ref_regex(old_name)
    changes, hit_total, ok_total = [], 0, 0
    for p, text in list(iter_ref_files(root, dirs)):
        found = list(rx.finditer(text))
        if not found:
            continue
        hit_total += len(found)
        for m in found:
            kind = _boundary_of(m)
            changes.append((p.relative_to(root).as_posix(),
                            text.count("\n", 0, m.start()) + 1, old_name, new_name, kind))
        # 前缀（路径 + 边界字符）必须原样保留，只换文件名
        new_text = rx.sub(lambda m: _keep_prefix(m, old_name) + new_name, text)
        tmp = p.with_suffix(p.suffix + ".autowebp.tmp")
        try:
            # 统一 UTF-8 无 BOM，二进制写入保证 LF 不被换行转换带歪
            tmp.write_bytes(new_text.encode("utf-8"))
            os.replace(tmp, p)
        except OSError as exc:
            print(f"      [!] 改写失败 {p.relative_to(root).as_posix()}：{exc}")
            tmp.unlink(missing_ok=True)
            continue
        ok_total += len(found)
    return changes, hit_total, ok_total




# ---------------------------------------------------------------- 转换本体
def convert_one(img2webp, args, src: Path, root: Path):
    """把一张图转成同名 .webp；返回结果字典。不删除原始文件（删除在调用方决定）。"""
    out = src.with_suffix(".webp")
    rel = src.relative_to(root).as_posix()
    res = {"src": rel, "out": out, "status": "skip", "note": "",
           "before": 0, "after": 0, "quality": None, "changes": [],
           "deleted": False, "hits": 0, "rewritten": 0}
    try:
        before = src.stat().st_size
        res["before"] = before
        if out.exists():
            res["note"] = f"目标已存在（{human(out.stat().st_size)}），保留原图不动"
            return res
        # 复用 img2webp 的读图 / 缩放 / 编码
        raw = img2webp.load_frames(src, args)
        im, frames, durations, loop = raw
        icc = im.info.get("icc_profile")
        exif = im.info.get("exif")
        if frames:  # 动图（gif/webp）：脚本层面已排除，这里保底走缩放逻辑
            new_frames = []
            for f in frames:
                f2, _, _ = img2webp.maybe_resize(f, args)
                new_frames.append(f2)
            frames = new_frames
            im = frames[0]
        else:
            im, _o, _n = img2webp.maybe_resize(im, args)
        target_bytes = int(args.target_kb * 1024) if args.target_kb else None
        if target_bytes:
            data, used_q, missed = img2webp.encode_with_target(
                im, frames, durations, loop, args, target_bytes, icc, exif)
        else:
            data = img2webp.encode(im, frames, durations, loop, args, args.quality, icc, exif)
            used_q, missed = args.quality, False
        res["quality"] = used_q
        res["missed"] = bool(missed)
        if len(data) >= before:
            res["note"] = (f"转成 webp 反而更大（{human(before)} → {human(len(data))}），"
                           f"放弃转换、保留原图")
            return res
        if args.apply:
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(data)
        res["status"] = "ok"
        res["after"] = len(data)
        res["note"] = "已缩放到 " + ("否" if not args.max_dim else f"最长边 ≤ {args.max_dim}")
        return res
    except Exception as exc:  # 单张失败不影响其它
        res["status"] = "fail"
        res["note"] = f"{type(exc).__name__}: {exc}"
        try:
            out.unlink(missing_ok=True)
        except OSError:
            pass
        return res


def apply_ref_rewrite(root: Path, args, res):
    """改写引用；返回 True 表示「原图可以安全删除」。"""
    out_name = res["out"].name
    old_name = Path(res["src"]).name
    changes, hit_total, ok_total = rewrite_refs(root, old_name, out_name)
    res["changes"] = changes
    res["hits"] = hit_total
    res["rewritten"] = ok_total
    if hit_total == 0:
        print("      引用：没有找到对它的引用（新图未被引用过）")
    kind_names = {"markdown": "markdown 引用", "html": "html/css 属性",
                  "": "裸路径 / 配置值", "dry": "预演"}
    for relpath, line, old, new, kind in changes:
        print(f"      引用改写 {relpath}:{line}  {old} → {new}"
              f"（{kind_names.get(kind, kind)}）")
    left = count_refs(root, old_name) if hit_total != ok_total else []
    if left:
        for relpath, cnt, lines in left:
            print(f"      [!] 仍有残留引用 {relpath}（{cnt} 处，行 {lines}），不删除原图")
        return False
    return ok_total == hit_total


def process(args):
    root = Path(args.root).resolve()
    if not (root / ".git").exists():
        sys.exit(f"{root} 不像 git 仓库根目录（缺 .git）")

    patterns = [glob_to_regex(p) for p in (args.patterns or DEFAULT_PATTERNS)]
    scanned, added = [], set()

    # --range all（或 --all）＝ 存量模式：不看 git diff，扫全量非 webp 位图
    range_all = bool(args.range) and args.range.strip().lower() in ("all", "--all", "全部")
    all_mode = bool(args.all) or range_all
    if all_mode and args.files:
        sys.exit("--all / --range all 与 --files 不能同时用（一个是全量扫描，一个是点名文件）")

    if args.files:
        # --files 里既可能是仓库相对路径，也可能是用户随手给的本地相对路径
        for f in args.files:
            p = Path(f)
            cands = [p] if p.is_absolute() else [root / f, Path.cwd() / f, p]
            for c in cands:
                if c.is_file():
                    try:
                        rel = c.resolve().relative_to(root).as_posix()
                    except ValueError:
                        continue
                    scanned.append(rel)
                    added.add(rel)
                    break
            else:
                print(f"[!] 命令行给的路径不存在：{f}")
    elif all_mode:
        print("存量模式（--all）：不比对 git diff，扫描下列目录下所有还不是 webp 的位图：")
        for p in (args.patterns or DEFAULT_PATTERNS):
            print(f"  · {p}")
        print("显式排除（主题素材，一律不动）：")
        for p in ALL_MODE_EXCLUDE:
            print(f"  · {p}")
        print(f"外加守卫：任何被 {THEME_DIR}/ 内文本引用到的图片都会跳过（{THEME_SKIP_NOTE}）。")
        scanned = iter_all_files(root, args.patterns or DEFAULT_PATTERNS)
        added = set(scanned)
    else:
        rng = resolve_range(root, args.range)
        if not rng:
            print("无法确定对比范围（仓库还没有提交？），退出。")
            return 0
        print(f"对比范围：{rng}")
        changed, added = files_from_git(root, rng)
        scanned = [f for f in changed if in_scope(f, patterns)]

    # 去重 + 只保留真正存在的文件
    todo, seen = [], set()
    for rel in sorted(scanned):
        if rel in seen:
            continue
        seen.add(rel)
        if not (root / rel).is_file():
            continue
        todo.append(rel)

    if all_mode:
        print(f"存量候选（{ [p.pattern for p in patterns] } 下）：{len(todo)} 个")
    else:
        print(f"变更中落在 {[p.pattern for p in patterns]} 下的文件：{len(todo)} 个")
    results = []
    for rel in todo:
        src = root / rel
        ext = src.suffix.lower()
        print(f"\n· {rel}")
        if ext in SKIP_REASON:
            print(f"      跳过：{SKIP_REASON[ext]}")
            results.append({"src": rel, "status": "skip", "note": SKIP_REASON[ext],
                            "before": src.stat().st_size, "after": 0})
            continue
        if ext not in BITMAP_EXTS:
            note = f"不在处理范围（只处理 {' '.join(sorted(BITMAP_EXTS))}）"
            print(f"      跳过：{note}")
            results.append({"src": rel, "status": "skip", "note": note,
                            "before": src.stat().st_size, "after": 0})
            continue
        # 主题引用守卫：themes/** 里的引用不会被改写，所以被主题引用的图绝不能转 + 删。
        trefs = theme_refs(root, src.name)
        if trefs:
            note = (f"{THEME_SKIP_NOTE}；命中："
                    + "、".join(f"{f}（{n} 处）" for f, n in trefs))
            print(f"      跳过：{note}")
            results.append({"src": rel, "status": "skip", "note": note,
                            "before": src.stat().st_size, "after": 0})
            continue
        res = convert_one(IMG2WEBP, args, src, root)
        res["is_new"] = rel in added
        if res["status"] != "ok":
            print(f"      {res['status']}：{res['note']}")
            results.append(res)
            continue
        before, after = res["before"], res["after"]
        pct = (1 - after / before) * 100 if before else 0
        if not args.apply:
            # dry-run：到这里一个字都没写，直接报「会怎么做」
            print(f"      [dry-run] 会将 {rel} → {res['out'].relative_to(root).as_posix()}"
                  f"  {human(before)} → {human(after)}（-{pct:.0f}%）q{res['quality']}")
            hits = count_refs(root, src.name)
            for relpath, cnt, lines in hits:
                print(f"      [dry-run] 将会改写 {relpath}（{cnt} 处）")
            if not hits:
                print("      [dry-run] 没有找到对它的引用（新图未被引用过）")
            print("      [dry-run] 会删除原图" if not args.keep_source
                  else "      [dry-run] 会保留原图（--keep-source）")
            print("      [dry-run] 未写入 webp、未改写引用、未删除原图")
            res["status"] = "dry"
            res["after_bytes"] = after
            res["changes"] = [(relpath, (lines[0] if lines else 0), src.name,
                               res["out"].name, "dry")
                              for relpath, _cnt, lines in hits]
            results.append(res)
            continue
        print(f"      生成 {res['out'].relative_to(root).as_posix()}"
              f"  {human(before)} → {human(after)}（-{pct:.0f}%）q{res['quality']}")
        safe = apply_ref_rewrite(root, args, res)
        if safe and res["out"].exists():
            if args.keep_source:
                print("      保留原图（--keep-source）")
            else:
                try:
                    src.unlink()
                except OSError as exc:
                    res["status"] = "fail"
                    res["note"] = f"删除原图失败：{exc}"
                    print(f"      [!] {res['note']}")
                    results.append(res)
                    continue
                res["deleted"] = True
                print("      已删除原图")
        elif not safe:
            print("      引用未全部改写成功，保留原图")
        results.append(res)
    return report(results, args)


def report(results, args):
    ok = [r for r in results if r["status"] in ("ok", "dry")]
    skips = [r for r in results if r["status"] == "skip"]
    fails = [r for r in results if r["status"] == "fail"]
    gains = [r for r in ok if r.get("after")]
    print("\n" + "=" * 72)
    print("汇总")
    print("=" * 72)
    if gains:
        print("转换明细：")
        for r in gains:
            before, after = r["before"], r.get("after", r.get("after_bytes", 0))
            pct = (1 - after / before) * 100 if before else 0
            flags = []
            if r.get("missed"):
                flags.append("未达 --target-kb 上限")
            if r.get("changes"):
                flags.append(f"改写引用 {len(r['changes'])} 处")
            if r.get("deleted"):
                flags.append("原图已删")
            elif args.keep_source:
                flags.append("原图保留")
            extra = ("  " + "；".join(flags)) if flags else ""
            print(f"  {r['src']}\n      {human(before)} → {human(after)}（-{pct:.0f}%）"
                  f"  q{r.get('quality')}{extra}")
        tb = sum(r["before"] for r in gains)
        ta = sum(r.get("after", r.get("after_bytes", 0)) for r in gains)
        print(f"  合计：{human(tb)} → {human(ta)}，省下 {human(tb - ta)}"
              f"（{(tb - ta) / tb * 100 if tb else 0:.1f}%）")
    changed_ref_files = sorted({c[0] for r in ok for c in r.get("changes", [])})
    if changed_ref_files:
        print("被改写的引用文件：")
        for f in changed_ref_files:
            print(f"  {f}")
    if skips:
        print("跳过：")
        for r in skips:
            print(f"  {r['src']}  —— {r['note']}")
    if fails:
        print("失败：")
        for r in fails:
            print(f"  {r['src']}  —— {r.get('note', '')}")
    print(f"\n共 {len(results)} 个文件：转换成功 {len([r for r in ok if r['status'] == 'ok'])}"
          f" / 预演 {len([r for r in ok if r['status'] == 'dry'])}"
          f" / 跳过 {len(skips)} / 失败 {len(fails)}"
          f"{'（dry-run，仓库文件未变动）' if not args.apply else ''}")
    if fails and args.strict:
        print("RESULT: FAILED", file=sys.stderr)
        return 1
    if fails:
        print("注意：有失败项，但未加 --strict，退出码仍为 0（原图都已保留）")
    print("RESULT: OK" if not fails else "RESULT: OK (with failures)")
    return 0


def build_parser():
    p = argparse.ArgumentParser(
        prog="auto_webp.py",
        description="把仓库里新增/修改的位图转成 WebP、改写引用并删掉原图（默认 dry-run）。",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="示例：\n"
               "  python tools/auto_webp.py --apply\n"
               "  python tools/auto_webp.py --range origin/main..HEAD\n"
               "  python tools/auto_webp.py --files static/images/new.jpg --apply\n")
    p.add_argument("--root", default=".", help="仓库根目录（默认当前目录）")
    p.add_argument("--range", default=None,
                   help="git 范围，如 HEAD^..HEAD / origin/main..HEAD；写 all 表示存量模式"
                        "（默认读 GITHUB_EVENT_BEFORE 或 HEAD^..HEAD）")
    p.add_argument("--files", nargs="*", default=None,
                   help="直接指定文件（跳过 git diff，测试/修复存量图用）")
    p.add_argument("--all", action="store_true",
                   help="存量模式：扫 patterns 覆盖的目录下所有非 webp 位图（不看 git diff）；"
                        "等价于 --range all。会自动跳过主题素材，见源码 ALL_MODE_EXCLUDE")
    p.add_argument("--patterns", nargs="*", default=None,
                   help=f"只处理匹配这些 glob 的文件（默认 {' '.join(DEFAULT_PATTERNS)}）")
    p.add_argument("--apply", action="store_true",
                   help="真的落盘：写 webp、改写引用、删原图（默认只预演）")
    p.add_argument("--keep-source", action="store_true", help="保留原图（不删）")
    p.add_argument("--quality", type=int, default=WEBP_QUALITY,
                   help=f"有损质量 1-100（默认 {WEBP_QUALITY}，源码里是常量）")
    p.add_argument("--target-kb", type=float, default=TARGET_KB,
                   help=f"单张体积上限 KB（默认 {TARGET_KB}；0 表示不限制）")
    p.add_argument("--max-dim", type=int, default=MAX_DIM,
                   help=f"最长边上限（默认 {MAX_DIM}；0 表示不限制尺寸）")
    p.add_argument("--method", type=int, default=METHOD, choices=range(0, 7), metavar="0-6",
                   help=f"编码方法，越大越慢越小（默认 {METHOD}）")
    p.add_argument("--strict", action="store_true", help="有失败项时以退出码 1 结束")
    return p


# 这里用「先解析再给 img2webp 造一个 args」的思路：
# img2webp 的 encode()/maybe_resize() 只读这些属性，所以直接复用本脚本的 args 即可。
def fixup_args(args):
    if not args.target_kb:
        args.target_kb = None
    if not args.max_dim:
        args.max_dim = None
    # img2webp 函数会用到的其余属性
    args.lossless = False
    args.alpha_quality = None
    args.exact = False
    args.keep_metadata = False
    args.no_upscale = True      # 不放大：compute_scale 会把系数夹到 ≤ 1
    args.max_w = None
    args.max_h = None
    args.scale = None
    return args


IMG2WEBP = None


def main(argv=None):
    for _stream in (sys.stdout, sys.stderr):
        try:
            _stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    global IMG2WEBP
    args = fixup_args(build_parser().parse_args(argv))
    IMG2WEBP = load_img2webp()
    if not args.apply:
        print("（dry-run：只报告，不改动任何文件；要真正执行加 --apply）")
    return process(args)


if __name__ == "__main__":
    sys.exit(main())
