#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""img2webp.py —— 任意图片转 WebP 并压缩（批量、可缩放、可指定目标体积）

依赖 Pillow（图片编解码标准库做不到）：
    pip install Pillow
HEIC/AVIF（iPhone 照片、部分相机）需要额外插件：
    pip install pillow-heif

主要能力
--------
* 输入：png / jpg / jpeg / bmp / gif / tif / tiff / webp / ico / ppm / tga / jp2 …
  支持文件、目录（默认不递归，-r 递归）、通配符；HEIC/AVIF/SVG 视插件而定
* 压缩：-q 质量、--lossless 无损、--method 0-6、--target-kb 压到指定体积以内
* 缩放：--max-dim 限制最长边、--max-w/--max-h 限制宽高、--scale 百分比、--no-upscale 不放大
* 保留：透明通道、动画（GIF/WebP 动图转成动图 WebP）
* 元数据：默认按 EXIF 方向摆正后去掉 EXIF（保留 ICC 色彩配置），--keep-metadata 可保留 EXIF
* 批量：-j 并发、--overwrite、--skip-existing、--dry-run、--in-place（原文件是 webp 时就地重压）

用法
----
    python img2webp.py 图片.png                      # 生成 图片.webp
    python img2webp.py photos/ -r -q 78 --max-dim 1600
    python img2webp.py photos/ -r -o out/ --target-kb 200 -j 4
    python img2webp.py a.jpg --lossless -v
    python img2webp.py *.png --dry-run               # 只报告不写文件
"""

from __future__ import annotations

import argparse
import io
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

try:
    from PIL import Image, ImageOps
except ImportError:  # pragma: no cover
    sys.exit("缺少 Pillow。请先安装：pip install Pillow")

# 可选格式插件：装了就用，没装不影响
for _mod in ("pillow_heif", "pillow_avif"):
    try:
        _m = __import__(_mod)
        if hasattr(_m, "register_heif_opener"):
            _m.register_heif_opener()
        if hasattr(_m, "register_avif_opener"):
            _m.register_avif_opener()
    except Exception:
        pass

DEFAULT_EXTS = {
    ".png", ".jpg", ".jpeg", ".jpe", ".jfif", ".bmp", ".dib", ".gif", ".tif", ".tiff",
    ".webp", ".ico", ".ppm", ".pgm", ".pnm", ".pbm", ".tga", ".jp2", ".j2k", ".pcx",
    ".heic", ".heif", ".avif",
}


def human(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if abs(n) < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024.0
    return f"{n:.1f} GB"


def has_alpha(im) -> bool:
    return im.mode in ("RGBA", "LA", "PA") or (im.mode == "P" and "transparency" in im.info)


def normalize(im):
    """把各种模式统一成 WebP 友好的模式。"""
    if im.mode in ("RGBA", "RGB", "L"):
        return im
    if has_alpha(im):
        return im.convert("RGBA")
    if im.mode in ("1", "I;16", "I;16B", "I;16L", "I", "F"):
        # 16 位/浮点/二值 → 8 位灰度
        return im.convert("L")
    if im.mode in ("P", "PA"):
        return im.convert("RGBA" if has_alpha(im) else "RGB")
    return im.convert("RGB")


def compute_scale(w: int, h: int, args) -> float:
    s = 1.0
    if args.scale:
        s *= args.scale / 100.0
    ratios = []
    if args.max_w:
        ratios.append(args.max_w / w)
    if args.max_h:
        ratios.append(args.max_h / h)
    if ratios:
        s = min(s, min(ratios))
    if args.max_dim and max(w, h) * s > args.max_dim:
        s = args.max_dim / max(w, h)
    if args.no_upscale:
        s = min(s, 1.0)
    return s


def load_frames(path: Path, args):
    """读图；动图返回 (frames, durations, loop, base)。"""
    im = Image.open(path)
    animated = bool(getattr(im, "is_animated", False)) and getattr(im, "n_frames", 1) > 1
    if not animated:
        im = normalize(im)
        if not args.keep_metadata:
            im = ImageOps.exif_transpose(im)
        return im, None, None, None

    frames, durations = [], []
    loop = im.info.get("loop", 0)
    for i in range(im.n_frames):
        im.seek(i)
        frame = normalize(im)
        # 关键：normalize() 对 RGB/RGBA 帧会原样返回，返回的仍是"可 seek 的动图对象"。
        # 直接塞进 append_images 会让 Pillow 把该对象的 n_frames(总帧数) 再展开一遍，
        # 帧数与 duration 列表不匹配 → IndexError。这里统一拷成普通单帧图像。
        if frame is im or getattr(frame, "n_frames", 1) > 1:
            frame = frame.copy()
            if frame.mode not in ("RGB", "RGBA", "L"):
                frame = frame.convert("RGBA" if has_alpha(frame) else "RGB")
        frames.append(frame)
        durations.append(max(10, int(im.info.get("duration", 100) or 100)))
    im.seek(0)
    return frames[0], frames, durations, loop


def maybe_resize(im, args):
    """按参数等比缩放；返回 (图像, 原始尺寸, 新尺寸)"""
    w, h = im.size
    s = compute_scale(w, h, args)
    if s >= 0.999:
        return im, (w, h), (w, h)
    tw, th = max(1, round(w * s)), max(1, round(h * s))
    resample = Image.LANCZOS if s < 1 else Image.BICUBIC
    return im.resize((tw, th), resample), (w, h), (tw, th)


def save_kwargs(args, quality):
    kw = {"format": "WEBP", "method": args.method}
    if args.lossless:
        kw["lossless"] = True
    else:
        kw["quality"] = int(quality)
        if args.alpha_quality is not None:
            kw["alpha_quality"] = args.alpha_quality
        if args.exact:
            kw["exact"] = True
    return kw


def encode(im, frames, durations, loop, args, quality, icc=None, exif=None) -> bytes:
    buf = io.BytesIO()
    kw = save_kwargs(args, quality)
    if icc:
        kw["icc_profile"] = icc
    if exif and args.keep_metadata:
        kw["exif"] = exif
    if frames:
        # 各帧时长相同（GIF 最常见）时传整数，Pillow 就不必逐帧索引时长列表
        same = bool(durations) and len(set(durations)) == 1
        kw.update(save_all=True, append_images=frames[1:],
                  duration=(durations[0] if same else durations), loop=loop)
    im.save(buf, **kw)
    return buf.getvalue()


def encode_with_target(im, frames, durations, loop, args, target_bytes, icc=None, exif=None):
    """二分质量，找到"不超过目标体积"的最高质量。"""
    if args.lossless:
        data = encode(im, frames, durations, loop, args, None, icc, exif)
        return data, None, len(data) > target_bytes
    best = None
    lo, hi = 1, max(1, args.quality)
    while lo <= hi:
        mid = (lo + hi) // 2
        data = encode(im, frames, durations, loop, args, mid, icc, exif)
        if len(data) <= target_bytes:
            best = (mid, data)
            lo = mid + 1
        else:
            hi = mid - 1
    if best is None:
        data = encode(im, frames, durations, loop, args, 1, icc, exif)
        return data, 1, len(data) > target_bytes
    return best[1], best[0], False


def collect_inputs(patterns, recursive, exts):
    files = []
    for pat in patterns:
        p = Path(pat)
        if p.is_dir():
            it = p.rglob("*") if recursive else p.glob("*")
            files += [f for f in it if f.is_file() and f.suffix.lower() in exts]
        elif p.is_file():
            files.append(p)
        else:
            import glob as _glob
            files += [Path(f) for f in _glob.glob(pat, recursive=recursive)
                      if Path(f).is_file() and Path(f).suffix.lower() in exts]
    seen, out = set(), []
    for f in sorted(files, key=lambda x: str(x).lower()):
        key = str(f.resolve()).lower()
        if key not in seen:
            seen.add(key)
            out.append(f)
    return out


def resolve_output(src: Path, args, multi: bool) -> Path:
    if args.output:
        out = Path(args.output)
        if multi or out.is_dir() or str(args.output).endswith(("/", "\\")):
            return out / (src.stem + ".webp")
        return out
    return src.with_suffix(".webp")


def convert_one(src: Path, args, multi: bool, target_bytes):
    t0 = time.time()
    out = resolve_output(src, args, multi)
    same = out.resolve() == src.resolve()
    if same and not args.in_place:
        return {"src": src, "out": out, "status": "skip",
                "note": "输入已是 .webp，如要重压请加 --in-place（或 -o 指定别的名字）"}
    if out.exists() and not args.overwrite and not same:
        return {"src": src, "out": out, "status": "skip", "note": "目标已存在（--overwrite 可覆盖）"}
    try:
        before = src.stat().st_size
        im, frames, durations, loop = load_frames(src, args)
        orig_size = im.size
        icc = im.info.get("icc_profile")
        exif = im.info.get("exif")
        if frames:
            new_frames = []
            for f in frames:
                f2, _, _ = maybe_resize(f, args)
                new_frames.append(f2)
            frames = new_frames
            im = frames[0]
            new_size = im.size
        else:
            im, orig_size, new_size = maybe_resize(im, args)
        if target_bytes:
            data, used_q, missed = encode_with_target(im, frames, durations, loop, args,
                                                      target_bytes, icc, exif)
        else:
            data, used_q, missed = encode(im, frames, durations, loop, args,
                                          args.quality, icc, exif), args.quality, False
        # 已经优化过的小图/线稿可能越压越大：重压 .webp 时默认保留原文件
        if len(data) > before and src.suffix.lower() == ".webp" and not args.allow_bigger:
            return {"src": src, "out": out, "status": "skip",
                    "note": f"重压后更大（{human(before)} → {human(len(data))}），保留原文件；"
                            f"要强制写入加 --allow-bigger"}
        if args.dry_run:
            return {"src": src, "out": out, "status": "dry",
                    "before": before, "after": len(data), "size": (orig_size, new_size),
                    "q": used_q, "secs": time.time() - t0, "missed": missed}
        out.parent.mkdir(parents=True, exist_ok=True)
        if same:
            tmp = out.with_suffix(".webp.tmp")
            tmp.write_bytes(data)
            os.replace(tmp, out)
        else:
            out.write_bytes(data)
        return {"src": src, "out": out, "status": "ok", "before": before, "after": len(data),
                "size": (orig_size, new_size), "q": used_q, "secs": time.time() - t0, "missed": missed}
    except Exception as exc:  # 单张失败不影响其它
        return {"src": src, "out": out, "status": "fail", "note": f"{type(exc).__name__}: {exc}"}


def report(results, args, target_bytes):
    ok = [x for x in results if x["status"] in ("ok", "dry")]
    print()
    for x in ([] if args.quiet else results):
        name = str(x["src"])
        if len(name) > 58:
            name = "…" + name[-57:]
        if x["status"] == "ok" or x["status"] == "dry":
            before, after = x["before"], x["after"]
            pct = (1 - after / before) * 100 if before else 0
            pct_txt = f"-{pct:.0f}%" if pct >= 0 else f"+{-pct:.0f}%"
            (ow, oh), (nw, nh) = x["size"]
            dim = f"{ow}x{oh}" if (ow, oh) == (nw, nh) else f"{ow}x{oh} → {nw}x{nh}"
            q = "lossless" if args.lossless else f"q{x['q']}"
            flags = ""
            if x.get("missed"):
                flags += "  [!] 未达目标体积"
            if after > before:
                flags += "  [!] 比原文件大"
            prefix = "[dry] " if x["status"] == "dry" else ""
            print(f"{prefix}{name}\n      {human(before)} → {human(after)}  ({pct_txt})  {dim}  {q}{flags}")
        elif x["status"] == "skip":
            print(f"跳过  {name}\n      {x.get('note', '')}")
        else:
            print(f"失败  {name}\n      {x.get('note', '')}")
    total_before = sum(x["before"] for x in ok)
    total_after = sum(x["after"] for x in ok)
    saved = total_before - total_after
    pct = (saved / total_before * 100) if total_before else 0
    print()
    print(f"共 {len(results)} 个：成功 {len([x for x in ok if x['status'] == 'ok'])}"
          f" / 预演 {len([x for x in ok if x['status'] == 'dry'])}"
          f" / 跳过 {len([x for x in results if x['status'] == 'skip'])}"
          f" / 失败 {len([x for x in results if x['status'] == 'fail'])}")
    if ok:
        print(f"体积：{human(total_before)} → {human(total_after)}，省下 {human(saved)}（{pct:.1f}%）")
    if target_bytes:
        print(f"目标：每张 ≤ {human(target_bytes)}")
    return len([x for x in results if x["status"] == "fail"])


def build_parser():
    p = argparse.ArgumentParser(
        prog="img2webp.py",
        description="任意图片转 WebP 并压缩（批量 / 缩放 / 目标体积 / 保留透明与动画）。",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="示例：\n"
               "  python img2webp.py 图.png\n"
               "  python img2webp.py photos/ -r --max-dim 1600 -q 78 -o out/\n"
               "  python img2webp.py *.jpg --target-kb 200 -j 4\n"
               "  python img2webp.py old.webp --in-place --lossless\n")
    p.add_argument("inputs", nargs="+", help="图片文件、目录或通配符")
    p.add_argument("-o", "--output", help="输出文件或目录（默认与原图同目录、同名 .webp）")
    p.add_argument("-r", "--recursive", action="store_true", help="目录递归")
    p.add_argument("-q", "--quality", type=int, default=82, help="有损质量 1-100（默认 82）")
    p.add_argument("--lossless", action="store_true", help="无损模式（体积通常比有损大）")
    p.add_argument("--method", type=int, default=4, choices=range(0, 7), metavar="0-6",
                   help="压缩方法，越高越慢越小（默认 4；6 最慢最好）")
    p.add_argument("--alpha-quality", type=int, default=None, help="透明通道质量 0-100（默认由编码器定）")
    p.add_argument("--exact", action="store_true", help="保留透明区域的 RGB 值（略大，默认容许改写以省体积）")
    p.add_argument("--target-kb", type=float, default=None, help="目标体积上限（KB），自动二分质量")
    p.add_argument("--max-dim", type=int, help="限制最长边像素（等比）")
    p.add_argument("--max-w", type=int, help="限制宽度")
    p.add_argument("--max-h", type=int, help="限制高度")
    p.add_argument("--scale", type=float, help="按百分比缩放（如 50 表示缩小一半）")
    p.add_argument("--no-upscale", action="store_true", help="只缩不放")
    p.add_argument("--keep-metadata", action="store_true", help="保留 EXIF（默认摆正后丢弃）")
    p.add_argument("--overwrite", action="store_true", help="覆盖已存在的目标文件")
    p.add_argument("--skip-existing", action="store_true", help="目标已存在就跳过（默认行为）")
    p.add_argument("--in-place", action="store_true", help="输入本身是 .webp 时就地重压")
    p.add_argument("--allow-bigger", action="store_true",
                   help="允许输出比原文件更大（默认：重压 .webp 时若变大则保留原文件）")
    p.add_argument("-j", "--jobs", type=int, default=1, help="并发数（动图/大图建议 1-4）")
    p.add_argument("--dry-run", action="store_true", help="只计算不写文件")
    p.add_argument("--exclude", nargs="*", default=[], help="要排除的扩展名，如 .gif .svg")
    p.add_argument("--include", nargs="*", default=None, help="只处理这些扩展名，如 .png .jpg")
    p.add_argument("-v", "--verbose", action="store_true", help="显示每个文件的耗时")
    p.add_argument("--quiet", action="store_true", help="只输出汇总")
    return p


def main(argv=None):
    # 中文 Windows 控制台常是 GBK，遇到无法编码的字符不要让程序崩掉
    for _stream in (sys.stdout, sys.stderr):
        try:
            _stream.reconfigure(errors="replace")
        except Exception:
            pass
    args = build_parser().parse_args(argv)

    exts = DEFAULT_EXTS
    if args.include:
        exts = {e.lower() if e.startswith(".") else "." + e.lower() for e in args.include}
    if args.exclude:
        exts = exts - {e.lower() if e.startswith(".") else "." + e.lower() for e in args.exclude}

    files = collect_inputs(args.inputs, args.recursive, exts)
    if not files:
        print("没有找到可处理的图片。支持的扩展名：" + " ".join(sorted(exts)), file=sys.stderr)
        print("（HEIC/AVIF 需要 pip install pillow-heif；SVG 无法用本工具栅格化）", file=sys.stderr)
        return 2

    target_bytes = int(args.target_kb * 1024) if args.target_kb else None
    if target_bytes and args.lossless:
        print("提示：--lossless 与 --target-kb 同时使用时无法通过降质量达成目标。", file=sys.stderr)

    multi = len(files) > 1 or args.output is None and any(f.is_dir() for f in [Path(i) for i in args.inputs])
    t0 = time.time()

    if args.jobs and args.jobs > 1:
        with ThreadPoolExecutor(max_workers=args.jobs) as pool:
            results = list(pool.map(lambda f: convert_one(f, args, multi, target_bytes), files))
    else:
        results = [convert_one(f, args, multi, target_bytes) for f in files]

    fails = report(results, args, target_bytes)
    print(f"耗时 {time.time() - t0:.1f}s", file=sys.stderr)
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
