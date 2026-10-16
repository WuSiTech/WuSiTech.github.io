# -*- coding: utf-8 -*-
"""tools/auto_webp.py 的自测：造一批小图 + 一个假仓库，验证转换/跳过/引用改写/删除规则。

不联网、只依赖 Pillow 与本机 git。用法：
    <bundled python> tools/test_auto_webp.py
输出风格与 tools/test_check_twikoo.py 一致：`RESULT: ALL PASS (N 项)`，失败退出码 1。
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import auto_webp  # noqa: E402

# 20x20 的渐变 PNG 会「转成 webp 更大」（约 99 B → 约 136 B），用来验证放弃转换的分支
GROWS_NAME = "grows.png"
TINY_MAX_DIM = 64

_results: list[tuple[bool, str, str]] = []


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


def make_images(root: Path) -> Path:
    """在 static/images/ 下造测试图，返回 static/images 目录。"""
    imgs = root / "static" / "images"
    sub = imgs / "sub"
    imgs.mkdir(parents=True, exist_ok=True)
    sub.mkdir(parents=True, exist_ok=True)

    big = Image.new("RGB", (64, 48), (200, 40, 40))
    big.save(imgs / "big.jpg", "JPEG", quality=95)
    Image.new("RGB", (40, 24), (30, 120, 220)).save(imgs / "shot.png", "PNG")
    Image.new("RGB", (16, 16), (255, 255, 0)).save(imgs / "already.webp", "WEBP", quality=80)
    Image.new("RGB", (20, 20)).save(imgs / "solo-tiny.png", "PNG")      # 同名前缀干扰项
    Image.new("RGB", (128, 96), (10, 200, 10)).save(sub / "solo.png", "PNG")  # 需要缩放

    # 20x20 渐变：转 webp 会更大
    grad = Image.new("RGB", (20, 20))
    px = grad.load()
    for y in range(20):
        for x in range(20):
            px[x, y] = (x * 12 % 256, y * 12 % 256, (x + y) * 6 % 256)
    grad.save(imgs / GROWS_NAME, "PNG")

    write_text(imgs / "vector.svg",
               '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8">'
               '<rect width="8" height="8" fill="#f00"/></svg>\n')
    write_text(imgs / "anim.gif", "GIF89a" + "\x00" * 32)
    return imgs


def setup_repo(root: Path) -> None:
    root.mkdir(parents=True, exist_ok=True)
    git(root, "init", "-q", "-b", "main")
    git(root, "config", "user.name", "t")
    git(root, "config", "user.email", "t@example.com")
    git(root, "config", "commit.gpgsign", "false")

    imgs = make_images(root)
    sub = imgs / "sub"

    # 引用：文章（含子目录）、站点配置、data、static 里的 json
    write_text(root / "content" / "posts" / "p.md",
               "---\ntitle: t\ncover: /images/big.jpg\n---\n\n"
               "![a](/images/shot.png)\n"
               "干扰项：/images/solo-tiny.png 与 /images/big.jpg.bak 不应被改\n"
               "子目录图：/images/sub/solo.png\n")
    write_text(root / "content" / "posts" / "sub" / "q.md",
               "正文引用 sub/solo.png，也重复一次 /images/sub/solo.png\n")
    write_text(root / "config" / "_default" / "params.yml",
               "banner: /images/big.jpg\ntaichi: /images/taichi.png\n")
    write_text(root / "data" / "cards.yml",
               "- cover: /images/shot.png\n  name: 卡片\n")
    write_text(root / "static" / "comments" / "c.json",
               '{"a": "/images/shot.png", "b": "/images/big.jpg"}\n')
    git(root, "add", "-A")
    git(root, "commit", "-q", "-m", "init")

    # 第二次提交：新增一张 jpg + 修改 png / webp / svg / gif / 小图，
    # 这样「本次 push 的变更」里就同时含盖要转换的、要跳过的、以及转不了的。
    Image.new("RGB", (72, 40), (90, 90, 240)).save(imgs / "new.jpg", "JPEG", quality=95)
    Image.new("RGB", (50, 30), (240, 200, 10)).save(imgs / "shot.png", "PNG")
    Image.new("RGB", (16, 16), (255, 0, 255)).save(sub / "solo.png", "PNG")
    write_text(imgs / "already.webp", "<svg xmlns='http://www.w3.org/2000/svg' width='6' height='6'/>\n")
    write_text(imgs / "anim.gif", "GIF89a" + "\x01" * 40)
    write_text(imgs / GROWS_NAME, "PNG" + "\x02" * 20)  # 内容坏了 → 转换必然失败，验证「单张失败不断流程」
    write_text(root / "content" / "posts" / "p.md",
               "---\ntitle: t\ncover: /images/big.jpg\n---\n\n"
               "![n](/images/new.jpg)\n"
               "![a](/images/shot.png)\n"
               "干扰项：/images/solo-tiny.png 与 /images/big.jpg.bak 不应被改\n"
               "子目录图：/images/sub/solo.png\n")
    git(root, "add", "-A")
    git(root, "commit", "-q", "-m", "feat: 加图")



def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def main() -> int:
    for _s in (sys.stdout, sys.stderr):
        try:
            _s.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

    tmp = Path(tempfile.mkdtemp(prefix="autowebp-"))
    root = tmp / "repo"
    try:
        setup_repo(root)
        content_p = root / "content" / "posts" / "p.md"
        content_q = root / "content" / "posts" / "sub" / "q.md"
        params = root / "config" / "_default" / "params.yml"
        data_cards = root / "data" / "cards.yml"
        comments = root / "static" / "comments" / "c.json"
        img = root / "static" / "images"

        print("=== 场景 1：--apply 真正转换（含子目录、干扰文件名、webp/矢量/动图跳过）===")
        rc = auto_webp.main(["--root", str(root), "--range", "HEAD^..HEAD", "--apply"])
        check(rc == 0, "有单张失败但未加 --strict，退出码仍为 0", f"rc={rc}")

        # 1) jpg/png 转成 webp 且原图被删
        check((img / "new.jpg").exists() is False, "原图 new.jpg 已删除")
        check((img / "new.webp").is_file(), "生成 new.webp")
        check((img / "shot.png").exists() is False, "原图 shot.png 已删除")
        check((img / "shot.webp").is_file(), "生成 shot.webp")
        check((img / "sub" / "solo.png").exists() is False, "子目录原图 sub/solo.png 已删除")
        check((img / "sub" / "solo.webp").is_file(), "生成子目录 sub/solo.webp")
        with Image.open(img / "sub" / "solo.webp") as im:
            w, h = im.size
        check(max(w, h) <= TINY_MAX_DIM,
              f"最大边被限制在 {TINY_MAX_DIM}（--max-dim 生效且不放大）", f"实际 {w}x{h}")
        check((img / "big.jpg").is_file() and not (img / "big.webp").exists(),
              "本次变更之外的 big.jpg 没被动过")

        # 2) 已经是 webp / svg / gif 被跳过（原文件保持原样、不产生同名 webp）
        check((img / "already.webp").is_file(), "已经是 webp 的文件保持原样")
        check((img / "vector.svg").is_file() and not (img / "vector.webp").exists(),
              "svg 被跳过（保留，不栅格化）")
        check((img / "anim.gif").is_file() and not (img / "anim.webp").exists(),
              "gif 被跳过（保留，不毁动画）")

        # 3) 转换失败的坏图：保留原文件、不留下半成品 webp、不中断其它图片
        check((img / GROWS_NAME).is_file(), f"{GROWS_NAME}（坏文件）保留原图")
        check(not (img / "grows.webp").exists(), "失败时没有留下 grows.webp")
        check((img / "new.webp").is_file() and (img / "shot.webp").is_file(),
              "单张失败没有中断其它图片的转换")

        # 4) 引用改写：content（含子目录）/config/data/static
        cp = read(content_p)
        check("/images/new.webp" in cp, "content/posts/p.md 里 new.jpg → new.webp")
        check("/images/shot.webp" in cp, "content/posts/p.md 里 shot.png → shot.webp")
        check("/images/big.jpg" in cp, "未被转换的 big.jpg 引用保持不变")
        check("/images/solo-tiny.png" in cp, "同前缀干扰项 solo-tiny.png 未被误伤")
        check("/images/big.jpg.bak" in cp, "带额外后缀的 big.jpg.bak 未被误伤")
        check("/images/sub/solo.webp" in cp, "content/posts/p.md 里 sub/solo.png → sub/solo.webp")
        cq = read(content_q)
        check("/images/sub/solo.webp" in cq, "content/posts/sub/q.md（子目录）里带路径的引用被改写")
        check("sub/solo.png" not in cq, "content/posts/sub/q.md 里不再残留 solo.png")
        check("/images/big.jpg" in read(params),
              "params.yml 里未被转换的 big.jpg 保持原样（不能无中生有改成正主）")
        check("/images/taichi.png" in read(params), "params.yml 里不存在的图引用保持原样")
        check("/images/shot.webp" in read(data_cards), "data/cards.yml 里 shot.png → shot.webp")
        cj = read(comments)
        check(cj.count("/images/shot.webp") == 1 and cj.count("/images/big.jpg") == 1,
              "static/comments/c.json 里 shot 改写、big 原样",
              f"shot={cj.count('/images/shot.webp')} big={cj.count('/images/big.jpg')}")

        print("\n=== 场景 1b：--strict 时单张失败应反映为退出码 1 ===")
        rc_strict = auto_webp.main(["--root", str(root), "--range", "HEAD^..HEAD",
                                    "--apply", "--strict"])
        check(rc_strict == 1, "--strict 下退出码 1", f"rc={rc_strict}")

        print("\n=== 场景 2：dry-run 不改动任何文件（且确实扫到了候选图）===")
        # 再造一张图并提交，让「本次变更」真的包含它 —— 否则 dry-run 会因为
        # 候选列表为空而「什么都没做」，就测不到东西了。
        Image.new("RGB", (96, 64), (12, 200, 90)).save(img / "dry.jpg", "JPEG", quality=95)
        write_text(content_p, cp + "\n![dry](/images/dry.jpg)\n")
        git(root, "add", "-A")
        git(root, "commit", "-q", "-m", "feat: dry 测试图")
        before_snapshot = {str(p.relative_to(root)): p.read_bytes()
                           for p in root.rglob("*") if p.is_file() and ".git" not in p.parts}
        rc = auto_webp.main(["--root", str(root), "--range", "HEAD^..HEAD"])
        check(rc == 0, "dry-run 退出码为 0", f"rc={rc}")
        after_snapshot = {str(p.relative_to(root)): p.read_bytes()
                          for p in root.rglob("*") if p.is_file() and ".git" not in p.parts}
        check(before_snapshot == after_snapshot, "dry-run 之后所有文件字节完全一致")
        check(not (img / "dry.webp").exists(), "dry-run 没有生成 dry.webp")
        check("/images/dry.jpg" in read(content_p), "dry-run 没有改写引用")

        print("\n=== 场景 3：--keep-source 保留原图 ===")
        rc = auto_webp.main(["--root", str(root), "--files", "static/images/dry.jpg",
                             "--apply", "--keep-source"])
        check(rc == 0, "退出码为 0", f"rc={rc}")
        check((img / "dry.jpg").is_file() and (img / "dry.webp").is_file(),
              "--keep-source 下原图与 webp 同时存在")
        check("/images/dry.webp" in read(content_p), "引用仍然改写成 dry.webp")

        print("\n=== 场景 4：路径匹配与引用边界（不误伤同名片段）===")
        check(auto_webp.in_scope("static/images/a.jpg", [auto_webp.glob_to_regex("static/images/**")]),
              "static/images/a.jpg 落在范围内")
        check(auto_webp.in_scope("static/images/x/y/a.jpg",
                                 [auto_webp.glob_to_regex("static/images/**")]),
              "static/images/x/y/a.jpg（子目录）落在范围内")
        check(not auto_webp.in_scope("static/avatar/a.jpg",
                                     [auto_webp.glob_to_regex("static/images/**")]),
              "static/avatar/a.jpg 不在范围内")

        def hit(name, text):
            return auto_webp.ref_regex(name).search(text) is not None

        cases = [
            ("/images/taichi.png", True, "站内绝对路径 /images/x.png"),
            ("![a](/images/a.png)", True, "markdown 图片语法"),
            ('src="/images/a.png"', True, "html 属性"),
            ("url(/images/a.png)", True, "css url() / 括号包裹"),
            ("./a.png", True, "相对路径 ./a.png"),
            ("a.png", True, "行首裸文件名"),
            ("  \"a.png\"", True, "引号包裹的裸文件名"),
            ("cover: a.png\n", True, "yaml 值"),
            ("/images/taichi-fill.png", False, "同前缀干扰项 taichi-fill.png"),
            ("b-a.png", False, "同后缀干扰项 b-a.png"),
            ("xa.png", False, "紧贴字母的 xa.png"),
            ("/images/a.png.bak", False, "带额外后缀 a.png.bak"),
            ("/images/a.png-old", False, "连字符后缀 a.png-old"),
            ("/images/a.pngx", False, "多一个字母 a.pngx"),
        ]
        for text, want, label in cases:
            name = "taichi.png" if "taichi" in text else "a.png"
            got = hit(name, text)
            check(got == want, f"ref_regex {'命中' if want else '不命中'}：{label}"
                               f"（{text.strip()!r}）")

        check(auto_webp.human(512) == "512 B" and auto_webp.human(2048) == "2.0 KB",
              "human() 体积格式化", f"{auto_webp.human(512)} / {auto_webp.human(2048)}")
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
