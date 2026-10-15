#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""docx2md.py —— Word (.docx) 转 Markdown 工具（纯标准库，零依赖）

只做"Markdown 支持的东西"的转换，字体/字号/颜色等排版属性一律忽略。

支持的转换
----------
* 标题：Heading 1~9 / 标题 1~9 / Title，以及按大纲级别(outlineLvl)兜底 → `#` ... `######`
* 行内：加粗 `**`、斜体 `*`、删除线 `~~`、行内代码 `` ` ``、超链接 `[](...)`
* 上下标：默认输出 HTML `<sup>/<sub>`（可选关闭）
* 代码块：Code / Preformatted / 代码 等样式 → ``` 围栏（连续多段自动合并成一个块）
* 列表：项目符号 / 有序列表，支持多级嵌套；`☐/☑` 前缀识别为任务列表 `- [ ]`
* 表格：转换为 GFM 表格（保留列对齐；合并单元格按网格展开）
* 引用：Quote / 引用 等样式 → `> `
* 分隔线：只带上下边框的空段落 → `---`
* 图片：按文档中出现的位置输出 `![alt](xxx_files/imageN.png)`，并把图片从 docx 里导出到同目录
* 脚注 / 尾注：转换为 GFM 脚注 `[^1]` + 文末定义
* 换行：`<w:br/>` → Markdown 硬换行；分页符可选转 `---`
* 修订：接受插入(w:ins)，忽略删除(w:del)
* 页码/目录等域：忽略域代码，保留域缓存结果（TOC 域整体跳过）

忽略（Markdown 不支持）
-----------------------
字体 / 字号 / 颜色 / 高亮 / 下划线 / 段落缩进 / 居中 / 分栏 / 页眉页脚 / 文本框位置等。

用法
----
    python docx2md.py 文档.docx                     # 生成 文档.md + 文档_files/
    python docx2md.py 文档.docx -o out.md --images-dir img
    python docx2md.py 文档.docx --stdout            # 只打印不写文件
    python docx2md.py 文档.docx --hugo-frontmatter  # 额外加 Hugo 的 TOML front matter
"""

from __future__ import annotations

import argparse
import datetime as _dt
import os
import posixpath
import re
import sys
import zipfile
from xml.etree import ElementTree as ET

# --------------------------------------------------------------------------
# OOXML 命名空间
# --------------------------------------------------------------------------
NS_W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main"
NS_WP = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
NS_V = "urn:schemas-microsoft-com:vml"
NS_CT = "http://schemas.openxmlformats.org/package/2006/content-types"
NS_PR = "http://schemas.openxmlformats.org/package/2006/relationships"
NS_DC = "http://purl.org/dc/elements/1.1/"
NS_DCTERMS = "http://purl.org/dc/terms/"


def w(tag: str) -> str:
    return f"{{{NS_W}}}{tag}"


def r(tag: str) -> str:
    return f"{{{NS_R}}}{tag}"


def a(tag: str) -> str:
    return f"{{{NS_A}}}{tag}"


def wp(tag: str) -> str:
    return f"{{{NS_WP}}}{tag}"


def v(tag: str) -> str:
    return f"{{{NS_V}}}{tag}"


# 等宽字体（用于判断"行内代码"）
MONO_FONTS = {
    "consolas", "courier new", "courier", "monaco", "menlo", "source code pro",
    "jetbrains mono", "fira code", "cascadia code", "cascadia mono", "dejavu sans mono",
    "lucida console", "sf mono", "ubuntu mono", "roboto mono", "ibm plex mono",
    "simsun-extb", "monospace", "等线", "宋体-简",
}

# 上下标使用的 HTML 标签；Markdown 本身不支持，默认用 HTML（可用 --super-sub plain 关闭）
CHECKBOX_ON = "☑☒✓✔■"
CHECKBOX_OFF = "☐□▢❑"


# --------------------------------------------------------------------------
# 小工具
# --------------------------------------------------------------------------
def val(el, attr="val", default=None):
    """读取 w:val 之类的属性；<w:b/> 这种无属性节点视为 true。"""
    if el is None:
        return default
    got = el.get(w(attr))
    if got is None:
        return True if attr == "val" else default
    return got


def is_on(el) -> bool:
    """OOXML 里 w:b / w:b w:val="false" / w:b w:val="0" 都表示关闭。"""
    if el is None:
        return False
    got = el.get(w("val"))
    if got is None:
        return True
    return str(got).lower() not in ("false", "0", "off", "none")


def esc(text: str) -> str:
    """转义 Markdown 特殊字符（尽量克制，保持可读）。"""
    if not text:
        return ""
    text = text.replace("\\", "\\\\")
    for ch in ("`", "*", "_", "[", "]", "<", ">"):
        text = text.replace(ch, "\\" + ch)
    # 行首可能被当成块级语法的字符
    text = re.sub(r"(?m)^([ \t]*)([#>])", r"\1\\\2", text)
    text = re.sub(r"(?m)^([ \t]*)([-+])(\s)", r"\1\\\2\3", text)
    text = re.sub(r"(?m)^([ \t]*)(\d+)([.)])(\s)", r"\1\2\\\3\4", text)
    return text


def esc_cell(text: str) -> str:
    """表格单元格：额外转义竖线，压掉换行。"""
    return text.replace("|", "\\|")


def norm_style(name: str) -> str:
    return re.sub(r"\s+", " ", (name or "").strip()).lower()


# --------------------------------------------------------------------------
# 转换器
# --------------------------------------------------------------------------
class Docx2Md:
    def __init__(self, path, images_dir=None, image_prefix=None, opts=None):
        self.path = path
        self.opts = opts or {}
        self.zip = zipfile.ZipFile(path)
        self.styles = {}          # styleId -> 样式名
        self.num_fmt = {}         # (numId, ilvl) -> (numFmt, start)
        self.rels = {}            # rId -> 目标（图片/超链接）
        self.footnotes = {}       # id -> 脚注 XML 元素
        self.endnotes = {}
        self.image_cache = {}     # rId -> markdown 里的引用路径
        self.saved_images = {}    # zip 内路径 -> 已导出的文件名
        self.footnote_order = []  # 按出现顺序的脚注编号
        self.footnote_defs = []
        self.textbox_blocks = []  # 文本框内容（原位取不到，附在段落后面）
        self.stats = {"paragraphs": 0, "images": 0, "tables": 0, "footnotes": 0, "code_blocks": 0}
        self.style_num = {}       # styleId -> numPr（列表编号写在样式里的情况）
        self.style_based = {}     # styleId -> basedOn
        self._list_counter = {}
        self._in_cell = False     # 处于表格单元格内（换行要转成空格或 <br>）

        base = os.path.splitext(os.path.basename(path))[0]
        self.images_dir = images_dir or f"{base}_files"
        self.image_prefix = image_prefix if image_prefix is not None else (
            os.path.basename(self.images_dir.rstrip("/\\")) + "/")

        self._read_styles()
        self._read_numbering()
        self._read_rels()
        self._read_notes()
        self.doc = self._xml("word/document.xml")

    # ---------------- 读取 docx 内部结构 ----------------
    def _xml(self, part):
        try:
            return ET.fromstring(self.zip.read(part))
        except KeyError:
            return None

    def _read_styles(self):
        root = self._xml("word/styles.xml")
        if root is None:
            return
        for st in root.findall(w("style")):
            sid = st.get(w("styleId"))
            name_el = st.find(w("name"))
            name = val(name_el) if name_el is not None else sid
            if not sid:
                continue
            self.styles[sid] = name or sid
            ppr = st.find(w("pPr"))
            if ppr is not None:
                numpr = ppr.find(w("numPr"))
                if numpr is not None:
                    self.style_num[sid] = numpr
            based = st.find(w("basedOn"))
            if based is not None:
                self.style_based[sid] = val(based)

    def _style_id(self, ppr):
        pstyle = ppr.find(w("pStyle")) if ppr is not None else None
        return val(pstyle) if pstyle is not None else None

    def _style_name(self, p_or_tc_pr):
        """取段落样式名。"""
        pstyle = p_or_tc_pr.find(w("pStyle")) if p_or_tc_pr is not None else None
        if pstyle is None:
            return ""
        sid = val(pstyle)
        return self.styles.get(sid, sid or "")

    def _read_numbering(self):
        root = self._xml("word/numbering.xml")
        if root is None:
            return
        abstract = {}
        for an in root.findall(w("abstractNum")):
            aid = an.get(w("abstractNumId"))
            levels = {}
            for lvl in an.findall(w("lvl")):
                ilvl = int(lvl.get(w("ilvl")) or 0)
                fmt_el = lvl.find(w("numFmt"))
                start_el = lvl.find(w("start"))
                levels[ilvl] = (val(fmt_el, default="decimal"), val(start_el, default="1"))
            abstract[aid] = levels
        for num in root.findall(w("num")):
            nid = num.get(w("numId"))
            aid_el = num.find(w("abstractNumId"))
            aid = val(aid_el) if aid_el is not None else None
            for ilvl, (fmt, start) in (abstract.get(aid, {}) or {}).items():
                self.num_fmt[(nid, ilvl)] = (fmt, start)

    def _read_rels(self):
        root = self._xml("word/_rels/document.xml.rels")
        if root is None:
            return
        for rel in root.findall(f"{{{NS_PR}}}Relationship"):
            rid = rel.get("Id")
            target = rel.get("Target") or ""
            mode = rel.get("TargetMode") or "Internal"
            if mode == "External":
                self.rels[rid] = target
            else:
                # 相对 word/ 目录，转成 zip 内的路径
                self.rels[rid] = posixpath.normpath(posixpath.join("word", target))

    def _read_notes(self):
        for part, store in (("word/footnotes.xml", self.footnotes), ("word/endnotes.xml", self.endnotes)):
            root = self._xml(part)
            if root is None:
                continue
            for tag in ("footnote", "endnote"):
                for note in root.findall(w(tag)):
                    nid = note.get(w("id"))
                    ntype = note.get(w("type"))
                    if ntype in ("separator", "continuationSeparator"):
                        continue
                    if nid is not None:
                        store[nid] = note

    # ---------------- 图片导出 ----------------
    def _extract_image(self, zip_path, rid):
        if rid in self.image_cache:
            return self.image_cache[rid]
        if zip_path not in self.saved_images:
            name = os.path.basename(zip_path) or f"image{len(self.saved_images) + 1}.png"
            target_dir = self.images_dir
            os.makedirs(target_dir, exist_ok=True)
            target = os.path.join(target_dir, name)
            guard = 1
            while os.path.exists(target) and self.zip.read(zip_path) != open(target, "rb").read():
                stem, ext = os.path.splitext(name)
                target = os.path.join(target_dir, f"{stem}_{guard}{ext}")
                guard += 1
            with open(target, "wb") as fh:
                fh.write(self.zip.read(zip_path))
            self.saved_images[zip_path] = name if target.endswith(name) else os.path.basename(target)
            self.stats["images"] += 1
        ref = self.image_prefix + self.saved_images[zip_path]
        self.image_cache[rid] = ref
        return ref

    def _image_md(self, rid, alt, extent=None):
        zip_path = self.rels.get(rid)
        if not zip_path or not zip_path.startswith("word/media/"):
            return ""
        ref = self._extract_image(zip_path, rid)
        alt = (alt or "").replace("]", "\\]").replace("[", "\\[")
        if self.opts.get("image_style") == "html" and extent is not None:
            try:
                width_px = round(int(extent.get("cx") or 0) / 9525)  # EMU → px(96dpi)
            except (TypeError, ValueError):
                width_px = 0
            if width_px:
                return f'<img src="{ref}" alt="{alt}" width="{width_px}" />'
        return f"![{alt}]({ref})"

    def _drawing_md(self, node):
        """处理 w:drawing / w:pict。"""
        blip = node.find(f".//{a('blip')}")
        # 文本框（没有图片，只有 wps:txbx）
        if blip is None:
            txbx = node.find(f".//{w('txbxContent')}")
            if txbx is not None:
                self.textbox_blocks.append(self.blocks(list(txbx)))
            return ""
        rid = blip.get(r("embed")) or blip.get(r("link"))
        docpr = node.find(f".//{wp('docPr')}")
        alt = ""
        if docpr is not None:
            alt = docpr.get("descr") or docpr.get("name") or ""
        extent = node.find(f".//{wp('extent')}")
        return self._image_md(rid, alt, extent)

    def _pict_md(self, node):
        data = node.find(f".//{v('imagedata')}")
        if data is None:
            return ""
        rid = data.get(r("id"))
        title = data.get("title") or ""
        return self._image_md(rid, title)

    # ---------------- 脚注 ----------------
    def _note_marker(self, note_id, end=False):
        store = self.endnotes if end else self.footnotes
        note = store.get(note_id)
        if note is None:
            return ""
        self.stats["footnotes"] += 1
        self.footnote_order.append(note_id)
        number = len(self.footnote_order)
        self.footnote_defs.append((number, self._note_text(note)))
        return f"[^{number}]"

    def _note_text(self, note):
        text = self.blocks(list(note))
        # 去掉脚注开头自带的编号（Word 里通常是上标数字）
        text = re.sub(r"^\s*<(?:sup|sub)>\s*[0-9A-Za-z]{1,3}\s*</(?:sup|sub)>\s*", "", text)
        text = re.sub(r"\s*\n\s*", " ", text).strip()
        return text or "…"

    # ---------------- 行内渲染 ----------------
    def inline(self, nodes) -> str:
        out = []
        for node in nodes:
            tag = node.tag
            if tag == w("r"):
                out.append(self.run(node))
            elif tag == w("hyperlink"):
                inner = self.inline(list(node))
                rid = node.get(r("id"))
                anchor = node.get(w("anchor"))
                url = self.rels.get(rid) if rid else (f"#{anchor}" if anchor else None)
                if url and inner:
                    out.append(f"[{inner}]({url})")
                else:
                    out.append(inner)
            elif tag in (w("ins"), w("sdt"), w("sdtContent"), w("smartTag"), w("bdo"), w("dir")):
                out.append(self.inline(list(node)))
            elif tag in (w("del"), w("moveFrom")):
                continue
            elif tag == w("fldSimple"):
                instr = (node.get(w("instr")) or "").upper()
                if "TOC" in instr or "PAGE" in instr:
                    continue
                out.append(self.inline(list(node)))
            elif tag in (w("bookmarkStart"), w("bookmarkEnd"), w("proofErr"), w("commentRangeStart"),
                         w("commentRangeEnd"), w("commentReference"), w("rPr"), w("pPr"),
                         w("lastRenderedPageBreak"), w("fldChar"), w("instrText"), w("delText")):
                continue
            elif tag in (w("drawing"), w("pict")):
                out.append(self._drawing_md(node) if tag == w("drawing") else self._pict_md(node))
            else:
                # 未知容器：继续向下找文本
                if len(node):
                    out.append(self.inline(list(node)))
        return "".join(out)

    def run(self, r_el) -> str:
        """行内渲染。注意：图片/换行/脚注是"生成的 Markdown"，不能被转义。"""
        rpr = r_el.find(w("rPr"))
        parts = []   # ("t", 需要转义的文本) | ("raw", 已经是 Markdown)
        for child in r_el:
            tag = child.tag
            if tag == w("t"):
                parts.append(("t", child.text or ""))
            elif tag == w("tab"):
                parts.append(("t", "    "))
            elif tag == w("br"):
                if child.get(w("type")) == "page":
                    if self.opts.get("page_break") != "ignore":
                        parts.append(("raw", "\n\n---\n\n"))
                else:
                    parts.append(("raw", ("<br>" if self.opts.get("cell_br") else " ") if self._in_cell else "\\\n"))
            elif tag == w("noBreakHyphen"):
                parts.append(("t", "-"))
            elif tag == w("sym"):
                try:
                    code = int(child.get(w("char") or "0", 16))
                except (TypeError, ValueError):
                    code = 0
                if code:
                    parts.append(("t", chr(code)))
            elif tag == w("drawing"):
                md = self._drawing_md(child)
                if md:
                    parts.append(("raw", md))
            elif tag == w("pict"):
                md = self._pict_md(child)
                if md:
                    parts.append(("raw", md))
            elif tag == w("footnoteReference"):
                md = self._note_marker(child.get(w("id")), end=False)
                if md:
                    parts.append(("raw", md))
            elif tag == w("endnoteReference"):
                md = self._note_marker(child.get(w("id")), end=True)
                if md:
                    parts.append(("raw", md))
        if not parts:
            return ""

        # 代码（等宽字体 / 字符样式）
        mono = False
        if rpr is not None:
            fonts = rpr.find(w("rFonts"))
            if fonts is not None:
                names = {norm_style(fonts.get(w("ascii")) or ""), norm_style(fonts.get(w("hAnsi")) or "")}
                mono = bool(names & MONO_FONTS)
            rstyle = rpr.find(w("rStyle"))
            if rstyle is not None:
                sname = norm_style(self.styles.get(val(rstyle), "") or "")
                if "code" in sname or "代码" in sname:
                    mono = True
        vert = None
        if rpr is not None:
            va = rpr.find(w("vertAlign"))
            if va is not None:
                vert = val(va)
        bold = is_on(rpr.find(w("b"))) if rpr is not None else False
        italic = is_on(rpr.find(w("i"))) if rpr is not None else False
        strike = (is_on(rpr.find(w("strike"))) or is_on(rpr.find(w("dstrike")))) if rpr is not None else False

        out = []
        for kind, value in parts:
            if kind == "raw":
                out.append(value)
                continue
            if mono and "\n" not in value:
                out.append(self._code_span(value))
                continue
            text = esc(value)
            if text.strip():
                if strike:
                    text = f"~~{text}~~"
                if italic:
                    text = f"*{text}*"
                if bold:
                    text = f"**{text}**"
            out.append(text)
        body = "".join(out)
        if vert and self.opts.get("super_sub") != "plain":
            body = f"<sup>{body}</sup>" if vert == "superscript" else f"<sub>{body}</sub>"
        return body

    @staticmethod
    def _code_span(text: str) -> str:
        longest = max((len(m) for m in re.findall(r"`+", text)), default=0)
        ticks = "`" * (longest + 1)
        pad = " " if text.startswith("`") or text.endswith("`") else ""
        return f"{ticks}{pad}{text}{pad}{ticks}"

    # ---------------- 块级渲染 ----------------
    def blocks(self, body_children) -> str:
        out = []
        i = 0
        children = [c for c in body_children if c.tag in (w("p"), w("tbl"), w("sdt"), w("sdtContent"))]
        while i < len(children):
            node = children[i]
            if node.tag == w("tbl"):
                self.stats["tables"] += 1
                out.append(self.table(node))
                i += 1
                continue
            if node.tag in (w("sdt"), w("sdtContent")):
                # 内容控件（含复选框）：递归
                inner = [c for c in node if c.tag == w("sdtContent")]
                if inner:
                    out.append(self.blocks(list(inner[0])))
                i += 1
                continue

            p = node
            self.stats["paragraphs"] += 1
            ppr = p.find(w("pPr"))
            style_name = norm_style(self._style_name(ppr))
            text = self.inline(list(p))
            stripped = text.strip()

            # 空段落
            if not stripped:
                if self._is_hr(ppr):
                    out.append("---")
                i += 1
                continue

            # 代码块：合并连续的同款段落
            if self._is_code_style(style_name) or self._is_code_paragraph(p):
                group = [self._plain_text(p)]
                j = i + 1
                while j < len(children) and children[j].tag == w("p"):
                    nxt = children[j]
                    nxtppr = nxt.find(w("pPr"))
                    if self._is_code_style(norm_style(self._style_name(nxtppr))) or self._is_code_paragraph(nxt):
                        group.append(self._plain_text(nxt))
                        j += 1
                    else:
                        break
                out.append(self._code_block(group, style_name))
                self.stats["code_blocks"] += 1
                i = j
                continue

            level = self._heading_level(style_name, ppr)
            if level:
                out.append("#" * level + " " + stripped)
                i += 1
                continue

            if self._is_quote(style_name):
                body = "\n".join("> " + ln for ln in text.split("\n"))
                out.append(body)
                i += 1
                continue

            li = self._list_info(ppr, style_name, self._style_id(ppr))
            if li is not None:
                out.append(self._list_item(text, li))
                i += 1
                continue

            out.append(text)
            i += 1

            # 文本框内容（原位置取不到，跟在该段之后）
            while self.textbox_blocks:
                out.append(self.textbox_blocks.pop(0))
        return "\n\n".join(s for s in out if s is not None and str(s).strip())

    def _plain_text(self, p) -> str:
        """代码块的纯文本：不加任何 Markdown 标记，也不做转义。"""
        buf = []

        def walk(nodes):
            for node in nodes:
                tag = node.tag
                if tag == w("t"):
                    buf.append(node.text or "")
                elif tag == w("tab"):
                    buf.append("    ")
                elif tag == w("br"):
                    buf.append("\n")
                elif tag == w("noBreakHyphen"):
                    buf.append("-")
                elif tag == w("sym"):
                    try:
                        code = int(node.get(w("char") or "0", 16))
                    except (TypeError, ValueError):
                        code = 0
                    if code:
                        buf.append(chr(code))
                elif tag in (w("del"), w("delText"), w("drawing"), w("pict"),
                             w("footnoteReference"), w("endnoteReference"), w("instrText")):
                    continue
                elif len(node):
                    walk(list(node))

        walk(list(p))
        return "".join(buf)

    def _is_code_style(self, style_name: str) -> bool:
        keys = ("code", "preformatted", "source code", "代码", "html preformatted", "plain text")
        return any(k in style_name for k in keys)

    def _is_code_paragraph(self, p) -> bool:
        """整段都是等宽字体 → 视为代码。"""
        runs = [r_ for r_ in p.findall(w("r"))]
        if not runs:
            return False
        mono_runs = 0
        for r_el in runs:
            rpr = r_el.find(w("rPr"))
            fonts = rpr.find(w("rFonts")) if rpr is not None else None
            if fonts is None:
                continue
            names = {norm_style(fonts.get(w("ascii")) or ""), norm_style(fonts.get(w("hAnsi")) or "")}
            if names & MONO_FONTS:
                mono_runs += 1
        return mono_runs == len(runs) and mono_runs > 0

    def _code_block(self, lines, style_name: str) -> str:
        lang = ""
        m = re.search(r"(?:code|代码)\s*[:\-]?\s*([A-Za-z+#]{1,15})", style_name)
        if m and norm_style(m.group(1)) not in ("block", "char"):
            lang = m.group(1).lower()
        content = "\n".join(lines)
        longest = max((len(x) for x in re.findall(r"`+", content)), default=0)
        fence = "`" * max(3, longest + 1)
        return f"{fence}{lang}\n{content}\n{fence}"

    def _heading_level(self, style_name: str, ppr) -> int:
        if style_name:
            m = re.match(r"(?:heading|标题)\s*([1-9])", style_name)
            if m:
                return int(m.group(1))
            if style_name in ("title", "标题", "文档标题"):
                return 1
        if ppr is not None:
            lvl = ppr.find(w("outlineLvl"))
            if lvl is not None:
                try:
                    n = int(val(lvl))
                except (TypeError, ValueError):
                    return 0
                if 0 <= n <= 8:
                    return 0 if style_name in ("title", "标题") else min(n + 1, 6)
        return 0

    def _is_quote(self, style_name: str) -> bool:
        return "quote" in style_name or "引用" in style_name

    def _is_hr(self, ppr) -> bool:
        if ppr is None:
            return False
        pbdr = ppr.find(w("pBdr"))
        if pbdr is None:
            return False
        return pbdr.find(w("bottom")) is not None or pbdr.find(w("top")) is not None

    def _list_from_numpr(self, numpr):
        numid_el = numpr.find(w("numId"))
        ilvl_el = numpr.find(w("ilvl"))
        num_id = val(numid_el) if numid_el is not None else None
        if num_id in (None, "0"):
            return None
        try:
            level = int(val(ilvl_el, default=0) or 0)
        except (TypeError, ValueError):
            level = 0
        fmt, start = self.num_fmt.get((num_id, level), (None, "1"))
        return {"numId": num_id, "level": level,
                "ordered": None if fmt is None else fmt != "bullet",
                "start": int(start or 1), "fmt": fmt or "bullet"}

    def _list_from_style(self, style_id):
        """列表编号写在样式里的情况：Word 内置的 List Bullet / List Number 就是这样。"""
        seen = set()
        sid = style_id
        while sid and sid not in seen:
            seen.add(sid)
            numpr = self.style_num.get(sid)
            if numpr is not None:
                info = self._list_from_numpr(numpr)
                if info:
                    return info
            sid = self.style_based.get(sid)
        return None

    def _list_from_name(self, style_name):
        """样式名兜底：没有 numbering.xml 也能识别（List Bullet 2 → 第 2 级）。"""
        if not style_name:
            return None
        m = re.search(r"(list\s*bullet|list\s*number|项目符号|无序列表|有序列表|编号列表)\s*(\d*)", style_name)
        if not m:
            return None
        ordered = bool(re.search(r"(number|编号|有序)", m.group(1)))
        try:
            level = int(m.group(2) or 1) - 1
        except ValueError:
            level = 0
        return {"numId": "style:" + style_name, "level": max(0, level), "ordered": ordered,
                "start": 1, "fmt": "decimal" if ordered else "bullet"}

    def _list_info(self, ppr, style_name="", style_id=None):
        by_name = self._list_from_name(style_name)
        info = None
        from_para = False
        if ppr is not None:
            numpr = ppr.find(w("numPr"))
            if numpr is not None:
                info = self._list_from_numpr(numpr)
                from_para = info is not None
        if info is None:
            info = self._list_from_style(style_id)
        if info is None:
            info = by_name
        else:
            if info.get("ordered") is None and by_name:
                info["ordered"] = by_name["ordered"]
            # 编号来自样式时，级别以样式名为准（List Bullet 2 → 第 2 级）
            if by_name and not from_para and by_name["level"]:
                info["level"] = by_name["level"]
        return info

    def _list_item(self, text: str, li) -> str:
        level = li["level"]
        indent = "    " * level
        if li["ordered"]:
            key = (li["numId"], level, li["fmt"])
            n = self._list_counter.get(key, li["start"] - 1) + 1
            self._list_counter[key] = n
            # 更深层级的计数重置
            for k in list(self._list_counter):
                if k[0] == li["numId"] and k[1] > level:
                    del self._list_counter[k]
            marker = f"{n}."
        else:
            marker = "-"
        # 任务列表
        first = text.lstrip()[:1]
        if first in CHECKBOX_ON:
            marker, text = ("- [x]"), text.lstrip()[1:].lstrip()
        elif first in CHECKBOX_OFF:
            marker, text = ("- [ ]"), text.lstrip()[1:].lstrip()
        lines = text.split("\n")
        head = f"{indent}{marker} {lines[0]}"
        pad = " " * (len(indent) + len(marker) + 1)
        return "\n".join([head] + [pad + ln if ln else "" for ln in lines[1:]])

    def table(self, tbl) -> str:
        rows = []
        aligns = []
        for tr in tbl.findall(w("tr")):
            cells = []
            for tc in tr.findall(w("tc")):
                tcpr = tc.find(w("tcPr"))
                span = 1
                if tcpr is not None:
                    gs = tcpr.find(w("gridSpan"))
                    if gs is not None:
                        try:
                            span = max(1, int(val(gs)))
                        except (TypeError, ValueError):
                            span = 1
                cont = False
                if tcpr is not None:
                    vm = tcpr.find(w("vMerge"))
                    if vm is not None and (val(vm) is not True):
                        cont = True
                content = "" if cont else self._cell_text(tc)
                cells.append(content)
                for _ in range(span - 1):
                    cells.append("")
                if not rows and tcpr is not None:
                    jc = tcpr.find(w("jc"))
                    j = val(jc) if jc is not None else None
                    aligns.append({"center": ":---:", "right": "---:", "end": "---:"}.get(j or "", "---"))
            if cells:
                rows.append(cells)
        if not rows:
            return ""
        width = max(len(r_) for r_ in rows)
        rows = [r_ + [""] * (width - len(r_)) for r_ in rows]
        aligns = (aligns + ["---"] * width)[:width]
        head, body = rows[0], rows[1:]
        out = ["| " + " | ".join(head) + " |", "| " + " | ".join(aligns) + " |"]
        for row in body:
            out.append("| " + " | ".join(row) + " |")
        return "\n".join(out)

    def _cell_text(self, tc) -> str:
        parts = []
        self._in_cell = True
        try:
            for child in tc:
                if child.tag == w("p"):
                    parts.append(self.inline(list(child)).strip())
                elif child.tag == w("tbl"):
                    # 嵌套表格：拉平
                    nested = self.table(child)
                    flat = " / ".join(
                        " ".join(c for c in row.split("|") if c.strip())
                        for row in nested.splitlines()[2:]
                    )
                    parts.append(flat)
        finally:
            self._in_cell = False
        text = " ".join(p for p in parts if p)
        text = re.sub(r"\s*\n\s*", "<br>" if self.opts.get("cell_br") else " ", text)
        text = re.sub(r"\s{2,}", " ", text)
        return esc_cell(text)

    # ---------------- 入口 ----------------
    def convert(self) -> str:
        body = self.doc.find(w("body")) if self.doc is not None else None
        if body is None:
            raise ValueError("不是有效的 Word 文档：找不到 word/document.xml 的 <w:body>")
        md = self.blocks(list(body))
        if self.footnote_defs:
            defs = "\n".join(f"[^{number}]: {text}" for number, text in self.footnote_defs)
            md = md.rstrip() + "\n\n" + defs
        return md.rstrip() + "\n"


# --------------------------------------------------------------------------
# 元数据（用于 --hugo-frontmatter）
# --------------------------------------------------------------------------
def read_core_props(path):
    info = {}
    try:
        with zipfile.ZipFile(path) as z:
            if "docProps/core.xml" in z.namelist():
                root = ET.fromstring(z.read("docProps/core.xml"))
                for key, tag in (("title", f"{{{NS_DC}}}title"),
                                 ("created", f"{{{NS_DCTERMS}}}created"),
                                 ("modified", f"{{{NS_DCTERMS}}}modified")):
                    el = root.find(tag)
                    if el is not None and el.text:
                        info[key] = el.text.strip()
    except Exception:
        pass
    return info


# --------------------------------------------------------------------------
# 命令行
# --------------------------------------------------------------------------
def build_parser():
    p = argparse.ArgumentParser(
        prog="docx2md.py",
        description="把 Word (.docx) 转成 Markdown（保留 MD 支持的所有格式，忽略字体等排版属性）。",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="示例：\n"
               "  python docx2md.py 报告.docx\n"
               "  python docx2md.py 报告.docx -o content/posts/report.md --images-dir static/images/report\n"
               "  python docx2md.py 报告.docx --stdout --super-sub plain\n")
    p.add_argument("docx", help="输入的 .docx 文件")
    p.add_argument("-o", "--output", help="输出的 .md 文件（默认与输入同目录同名）")
    p.add_argument("--images-dir", help="图片导出目录（默认 <输出名>_files）")
    p.add_argument("--image-prefix", help="md 里引用图片的前缀（默认 = 图片目录名 + /）")
    p.add_argument("--image-style", choices=("md", "html"), default="md",
                   help="图片写法：md=`![alt](path)`（默认）；html=带 width 的 <img>")
    p.add_argument("--super-sub", choices=("html", "plain"), default="html",
                   help="上下标写法：html=<sup>/<sub>（默认）；plain=纯文本")
    p.add_argument("--cell-br", action="store_true", help="表格单元格内换行用 <br>（默认用空格）")
    p.add_argument("--page-break", choices=("ignore", "hr"), default="ignore",
                   help="分页符处理：ignore（默认）或转成 ---")
    p.add_argument("--hugo-frontmatter", action="store_true", help="在开头加 Hugo 的 TOML front matter")
    p.add_argument("--stdout", action="store_true", help="只打印到标准输出，不写文件")
    p.add_argument("-v", "--verbose", action="store_true", help="输出统计信息")
    return p


def main(argv=None):
    # 中文 Windows 控制台常是 GBK，遇到无法编码的字符不要让程序崩掉
    for _stream in (sys.stdout, sys.stderr):
        try:
            _stream.reconfigure(errors="replace")
        except Exception:
            pass
    args = build_parser().parse_args(argv)
    src = args.docx
    if not os.path.isfile(src):
        print(f"错误：找不到文件 {src}", file=sys.stderr)
        return 2
    if not zipfile.is_zipfile(src):
        print("错误：这不是 .docx（可能是老的 .doc）。请先用 Word 另存为 .docx。", file=sys.stderr)
        return 2

    out_path = args.output
    if out_path is None and not args.stdout:
        out_path = os.path.splitext(src)[0] + ".md"
    base_name = os.path.splitext(os.path.basename(src))[0]
    if args.images_dir:
        images_dir = args.images_dir
    elif out_path:
        images_dir = os.path.join(os.path.dirname(out_path) or ".",
                                  os.path.splitext(os.path.basename(out_path))[0] + "_files")
    else:
        # --stdout 且没指定图片目录时，图片放在输入文件旁边，避免写到当前目录
        images_dir = os.path.join(os.path.dirname(os.path.abspath(src)), base_name + "_files")

    opts = {"image_style": args.image_style, "super_sub": args.super_sub,
            "cell_br": args.cell_br, "page_break": args.page_break}

    conv = Docx2Md(src, images_dir=images_dir, image_prefix=args.image_prefix, opts=opts)
    md = conv.convert()

    if args.hugo_frontmatter:
        info = read_core_props(src)
        title = info.get("title") or os.path.splitext(os.path.basename(src))[0]
        date = info.get("created") or info.get("modified")
        try:
            when = _dt.datetime.fromisoformat(date.replace("Z", "+00:00")).astimezone().strftime("%Y-%m-%dT%H:%M:%S%z")
            when = when[:-2] + ":" + when[-2:] if len(when) > 5 else when
        except Exception:
            when = _dt.datetime.now().astimezone().strftime("%Y-%m-%dT%H:%M:%S%z")
            when = when[:-2] + ":" + when[-2:]
        fm = ["+++", f"title = '{title.replace(chr(39), chr(39) * 2)}'",
              f"date = '{when}'", "draft = true", "+++", ""]
        md = "\n".join(fm) + "\n" + md

    if args.stdout:
        sys.stdout.write(md)
    else:
        os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
        with open(out_path, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(md)

    if args.verbose:
        print(f"输入 : {src}", file=sys.stderr)
        if not args.stdout:
            print(f"输出 : {out_path}", file=sys.stderr)
            print(f"图片 : {images_dir}（导出 {conv.stats['images']} 张）", file=sys.stderr)
        s = conv.stats
        print(f"统计 : 段落 {s['paragraphs']} / 表格 {s['tables']} / 代码块 {s['code_blocks']} / 脚注 {s['footnotes']}",
              file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
