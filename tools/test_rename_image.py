# -*- coding: utf-8 -*-
"""tools/rename_image.py 的自测：造一个假仓库，验证改名/移动 + 引用改写 + 各种拒绝。

不联网、只依赖标准库与本机 git。用法：
    <bundled python> tools/test_rename_image.py
输出风格与 tools/test_auto_webp.py 一致：`RESULT: ALL PASS (N 项)`，失败退出码 1。
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import rename_image  # noqa: E402

_results: list[tuple[bool, str, str]] = []

# 1x1 的合法 PNG（内容无关紧要：rename 不改码，只看扩展名/存在性）
PNG_1PX = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
    "0000000d49444154789c6360000002000100051a0a2e0000000049454e44ae426082"
)


def check(ok: bool, label: str, detail: str = "") -> bool:
    _results.append((bool(ok), label, detail))
    print(f"  [{'PASS' if ok else 'FAIL'}] {label}" + (f"   {detail}" if detail else ""))
    return bool(ok)


def git(root: Path, *args: str) -> None:
    proc = subprocess.run(["git", "-C", str(root), *args],
                          capture_output=True, text=True, encoding="utf-8", errors="replace")
    if proc.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} 失败：{proc.stderr}")


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="")


def write_img(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(PNG_1PX)


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def snap(root: Path) -> dict:
    return {str(p.relative_to(root)): p.read_bytes()
            for p in root.rglob("*") if p.is_file() and ".git" not in p.parts}


def run(*args) -> int:
    """调用 main()，把 die() 的 SystemExit 变成退出码。"""
    try:
        rc = rename_image.main([str(a) for a in args])
    except SystemExit as exc:
        return exc.code if isinstance(exc.code, int) else 2
    return 0 if rc is None else rc


def setup_repo(root: Path, bare_ref: bool = False, theme_ref: bool = False,
               with_layouts: bool = False) -> None:
    root.mkdir(parents=True, exist_ok=True)
    git(root, "init", "-q", "-b", "main")
    git(root, "config", "user.name", "t")
    git(root, "config", "user.email", "t@example.com")
    git(root, "config", "commit.gpgsign", "false")

    imgs = root / "static" / "images"
    write_img(imgs / "photo.jpg")
    write_img(imgs / "other.jpg")
    if theme_ref:
        # 主题（子模块替身）引用了 photo.jpg
        write_text(root / "themes" / "reimu" / "layouts" / "baseof.html",
                   '<img src="{{ "images/photo.jpg" | relURL }}"/>\n')

    write_text(root / "content" / "posts" / "p.md",
               "---\ntitle: t\ncover: /images/photo.jpg\nbanner: images/photo.jpg\n---\n\n"
               "![a](../images/photo.jpg)\n"
               "![b](/images/photo.jpg)\n"
               "![c](static/images/photo.jpg)\n"
               "干扰项（都不能被改）：/images/photo-1.jpg /images/my-photo.jpg "
               "/images/photo.jpg.bak /images/photo.jpgx\n")
    write_text(root / "config" / "_default" / "params.yml",
               'logo: "../images/photo.jpg"\navatar: "/images/other.jpg"\n')
    write_text(root / "data" / "cards.yml",
               "- cover: /images/photo.jpg\n  name: 卡片\n")
    write_text(root / "static" / "comments" / "c.json",
               '{"a": "/images/photo.jpg"}\n')
    if bare_ref:
        write_text(root / "data" / "bare.yml", "- name: 裸引用\n  cover: photo.jpg\n")
    if with_layouts:
        write_text(root / "layouts" / "partials" / "head.html",
                   '<img src="/images/photo.jpg"/>\n')
    git(root, "add", "-A")
    git(root, "commit", "-q", "-m", "init")


def main() -> int:
    for _s in (sys.stdout, sys.stderr):
        try:
            _s.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

    tmp = Path(tempfile.mkdtemp(prefix="rename-img-"))
    try:
        # ================= 场景 1：dry-run 不改文件 =================
        print("=== 场景 1：dry-run（默认）不改动任何文件 ===")
        root = tmp / "a"
        setup_repo(root)
        before = snap(root)
        rc = run("--root", root, "static/images/photo.jpg", "static/images/cover.jpg")
        check(rc == 0, "dry-run 退出码 0", f"rc={rc}")
        check(snap(root) == before, "dry-run 之后所有文件字节完全一致")
        check((root / "static/images/photo.jpg").is_file(), "dry-run 没有移动原图")
        check(not (root / "static/images/cover.jpg").exists(), "dry-run 没有生成目标文件")
        check("/images/photo.jpg" in read(root / "content/posts/p.md"),
              "dry-run 没有改写引用")

        # ================= 场景 2：同目录改名成功 =================
        print("\n=== 场景 2：同目录改名 photo.jpg → cover.jpg ===")
        rc = run("--root", root, "static/images/photo.jpg", "static/images/cover.jpg", "--apply")
        check(rc == 0, "改名退出码 0", f"rc={rc}")
        check(not (root / "static/images/photo.jpg").exists(), "原图已移走")
        check((root / "static/images/cover.jpg").is_file(), "目标文件存在")
        check((root / "static/images/cover.jpg").read_bytes() == PNG_1PX,
              "改名没有动文件内容（字节一致）")
        p = read(root / "content/posts/p.md")
        check("/images/cover.jpg" in p, "front matter cover 引用被改写")
        check("images/cover.jpg" in p and "banner: images/cover.jpg" in p,
              "不带前导斜杠的 images/... 引用被改写")
        check("../images/cover.jpg" in p, "../images/... 形式的引用被改写")
        check("static/images/cover.jpg" in p, "static/images/... 形式的引用被改写")
        check("/images/photo-1.jpg" in p, "相似文件名 photo-1.jpg 未被误伤")
        check("/images/my-photo.jpg" in p, "相似文件名 my-photo.jpg 未被误伤")
        check("/images/photo.jpg.bak" in p, "带额外后缀 photo.jpg.bak 未被误伤")
        check("/images/photo.jpgx" in p, "多一个字母 photo.jpgx 未被误伤")
        check("photo.jpg" not in p.replace("photo.jpg.bak", "").replace("photo.jpgx", "")
              .replace("photo-1.jpg", "").replace("my-photo.jpg", ""),
              "content 里没有残留旧引用")
        check("/images/cover.jpg" in read(root / "config/_default/params.yml"),
              "config/params.yml 里的引用被改写")
        check("/images/other.jpg" in read(root / "config/_default/params.yml"),
              "config 里指向别的图的引用保持原样")
        check("/images/cover.jpg" in read(root / "data/cards.yml"),
              "data/cards.yml 里的引用被改写")
        check("/images/cover.jpg" in read(root / "static/comments/c.json"),
              "static/comments/c.json 里的引用被改写")
        # 改完的引用文件必须是 UTF-8 无 BOM + LF
        raw = (root / "content/posts/p.md").read_bytes()
        check(not raw.startswith(b"\xef\xbb\xbf"), "改写后的文件没有 BOM")
        check(b"\r\n" not in raw, "改写后的文件是 LF 换行")

        # ================= 场景 3：移入子目录 =================
        print("\n=== 场景 3：移入子目录 images/cover.jpg → images/posts/cover.jpg ===")
        rc = run("--root", root, "static/images/cover.jpg", "static/images/posts/cover.jpg",
                 "--apply")
        check(rc == 0, "移动退出码 0", f"rc={rc}")
        check(not (root / "static/images/cover.jpg").exists(), "原图已移走")
        check((root / "static/images/posts/cover.jpg").is_file(), "子目录里出现目标文件")
        p = read(root / "content/posts/p.md")
        check("/images/posts/cover.jpg" in p, "绝对路径引用改成 /images/posts/cover.jpg")
        check("../images/posts/cover.jpg" in p, "../ 相对引用保留前缀并加上子目录")
        check("static/images/posts/cover.jpg" in p, "static/ 前缀引用保留前缀并加上子目录")
        check("![b](/images/photo.jpg)" not in p and "![b](/images/posts/cover.jpg)" in p,
              "旧的顶层路径引用已改成子目录路径")
        check("/images/photo-1.jpg" in p and "/images/my-photo.jpg" in p,
              "移动后相似文件名依旧未被误伤")
        check("/images/posts/cover.jpg" in read(root / "data/cards.yml"),
              "data 里的引用也被改写")
        check("/images/other.jpg" in read(root / "config/_default/params.yml"),
              "config 里别的图依旧没被动")

        # ================= 场景 4：各种拒绝（一个文件都不许变）=================
        print("\n=== 场景 4：安全检查拒绝（目标已存在 / 扩展名变了 / .. 逃逸 / 绝对路径 / 非图片）===")
        root4 = tmp / "d"
        setup_repo(root4)
        write_img(root4 / "static" / "images" / "taken.jpg")
        before = snap(root4)
        rc = run("--root", root4, "static/images/photo.jpg", "static/images/taken.jpg", "--apply")
        check(rc == 2, "目标已存在时拒绝（退出码 2）", f"rc={rc}")
        check(snap(root4) == before, "目标已存在时什么都没改")

        rc = run("--root", root4, "static/images/photo.jpg", "static/images/photo.png", "--apply")
        check(rc == 2, "扩展名不一致时拒绝", f"rc={rc}")
        check(snap(root4) == before, "扩展名不一致时什么都没改")

        rc = run("--root", root4, "static/images/photo.jpg", "../escape.jpg", "--apply")
        check(rc == 2, "目标含 .. 逃逸时拒绝", f"rc={rc}")

        rc = run("--root", root4, "static/images/photo.jpg", "C:/tmp/out.jpg", "--apply")
        check(rc == 2, "绝对路径目标被拒绝", f"rc={rc}")

        rc = run("--root", root4, "content/posts/p.md", "content/posts/q.md", "--apply")
        check(rc == 2, "源文件不是图片时拒绝", f"rc={rc}")

        rc = run("--root", root4, "static/images/nope.jpg", "static/images/x.jpg", "--apply")
        check(rc == 2, "源文件不存在时拒绝", f"rc={rc}")
        check(snap(root4) == before, "上述所有拒绝场景都没有改动任何文件")

        # ================= 场景 5：被主题引用 → 默认拒绝 =================
        print("\n=== 场景 5：图片被 themes/（子模块）引用 → 默认拒绝 ===")
        root5 = tmp / "e"
        setup_repo(root5, theme_ref=True)
        before = snap(root5)
        rc = run("--root", root5, "static/images/photo.jpg", "static/images/cover.jpg", "--apply")
        check(rc == 2, "被主题引用时拒绝执行（退出码 2）", f"rc={rc}")
        check(snap(root5) == before, "被主题引用时什么都没改")

        # ================= 场景 6：裸文件名引用 =================
        print("\n=== 场景 6：裸文件名引用（换目录时默认拒绝，--rewrite-bare 才改）===")
        root6 = tmp / "f"
        setup_repo(root6, bare_ref=True)
        bare = root6 / "data" / "bare.yml"
        before = snap(root6)
        rc = run("--root", root6, "static/images/photo.jpg", "static/images/sub/photo.jpg",
                 "--apply")
        check(rc == 2, "存在裸引用且换目录时拒绝执行", f"rc={rc}")
        check(snap(root6) == before, "拒绝时什么都没改")
        check("cover: photo.jpg" in read(bare), "裸引用保持原样")

        rc = run("--root", root6, "static/images/photo.jpg", "static/images/sub/photo.jpg",
                 "--apply", "--rewrite-bare")
        check(rc == 0, "--rewrite-bare 后成功", f"rc={rc}")
        check((root6 / "static/images/sub/photo.jpg").is_file(), "文件已移入 sub/")
        check("cover: sub/photo.jpg" in read(bare), "裸引用被改写成 sub/photo.jpg")
        check("/images/sub/photo.jpg" in read(root6 / "content/posts/p.md"),
              "带路径的引用同时被改写")
        p6 = read(root6 / "content/posts/p.md")
        check("![b](/images/sub/photo.jpg)" in p6 and "![b](/images/photo.jpg)" not in p6,
              "带路径的引用没有残留（旧位置那一条已经不在）")
        check("/images/photo-1.jpg" in p6 and "/images/photo.jpg.bak" in p6,
              "移动后相似文件名依旧未被误伤")

        # 裸引用 + 同目录改名：安全，不该拒绝
        root6b = tmp / "f2"
        setup_repo(root6b, bare_ref=True)
        rc = run("--root", root6b, "static/images/photo.jpg", "static/images/head.jpg",
                 "--apply")
        check(rc == 0, "同目录改名遇到裸引用不拒绝（语义不变）", f"rc={rc}")
        check("cover: head.jpg" in read(root6b / "data/bare.yml"),
              "同目录改名时裸引用被改成 head.jpg")

        # ================= 场景 7：只报告不改写的目录 =================
        print("\n=== 场景 7：layouts/ 不在改写范围（只提示，不改）===")
        root7 = tmp / "g"
        setup_repo(root7, with_layouts=True)
        rc = run("--root", root7, "static/images/photo.jpg", "static/images/cover.jpg", "--apply")
        check(rc == 0, "有 layouts/ 残留时默认仍成功（只提示）", f"rc={rc}")
        check("/images/photo.jpg" in read(root7 / "layouts/partials/head.html"),
              "layouts/ 里的引用一个字没改（不在自动改写范围内）")
        check((root7 / "static/images/cover.jpg").is_file(), "文件本身改名成功")
        root7b = tmp / "g2"
        setup_repo(root7b, with_layouts=True)
        rc = run("--root", root7b, "static/images/photo.jpg", "static/images/cover.jpg",
                 "--apply", "--strict")
        check(rc == 1, "--strict 下把「只报告没改」的残留反映为退出码 1", f"rc={rc}")

        # ================= 场景 8：纯函数级检查 =================
        print("\n=== 场景 8：匹配/分类的纯函数行为 ===")
        rx = rename_image.token_regex("a.jpg")
        cases = [
            ("/images/a.jpg", "path", True, "站内绝对路径"),
            ("../images/a.jpg", "path", True, "../ 相对路径"),
            ("static/images/a.jpg", "path", True, "仓库相对路径"),
            ("images/a.jpg", "path", True, "媒体库相对路径"),
            ("a.jpg", "bare", True, "裸文件名"),
            ("/other/a.jpg", "other", True, "别的目录下的同名文件"),
            ("/images/xa.jpg", "", False, "紧贴字母 xa.jpg 不命中"),
            ("/images/a.jpg.bak", "", False, "带额外后缀不命中"),
            ("/images/a.jpg-old", "", False, "连字符后缀不命中"),
        ]
        for text, kind, want_hit, label in cases:
            m = rx.search(text)
            got_hit = m is not None
            got_kind = rename_image.match_kind(m.group("path"), "images/") if m else ""
            check(got_hit == want_hit and got_kind == kind,
                  f"分类正确：{label}（{text!r}）",
                  f"hit={got_hit} kind={got_kind!r}")
        check(rename_image.media_marker("static/images") == "images/",
              "media_marker() 从媒体根目录推出 images/ 标记")
        check(rename_image.media_marker("static/avatar/") == "avatar/",
              "media_marker() 兼容结尾斜杠 / 别的目录")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    passed = sum(1 for ok, _l, _d in _results if ok)
    total = len(_results)
    failed = [label for ok, label, _d in _results if not ok]
    print()
    if failed:
        print("失败项：")
        for label in failed:
            print(f"  - {label}")
    print(f"RESULT: {'ALL PASS' if not failed else 'FAILED'} ({passed}/{total} 项)")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
