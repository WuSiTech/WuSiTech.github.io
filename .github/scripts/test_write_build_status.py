# -*- coding: utf-8 -*-
"""write_build_status.py 的自测（不联网，全部走 mock）

覆盖三类事：
  1. 状态归一：API 返回的各种 status/conclusion 落到挂件期望的取值；
  2. 降级：没 token / API 报错 / 返回垃圾，都必须 exit 0 并写出一份合法的 YAML，
     绝不能因为拿不到状态就让 CI 失败；
  3. 产物格式：UTF-8 无 BOM、LF 结尾、字段齐全、时间戳可被 Hugo 解析。

用法：python3 .github/scripts/test_write_build_status.py
"""

from __future__ import annotations

import importlib.util
import io
import json
import os
import re
import shutil
import sys
import tempfile
import urllib.error
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "write_build_status.py"

failures = []


def check(name: str, condition: bool, detail: str = "") -> None:
    if condition:
        print(f"  ok   {name}")
    else:
        print(f"  FAIL {name} {detail}")
        failures.append(name)


def load_module():
    spec = importlib.util.spec_from_file_location("write_build_status", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def fake_api_get(payloads):
    """返回一个替代 module.api_get 的函数：按 URL 子串命中固定 payload。"""

    def _get(url, token, timeout=20):
        for needle, payload in payloads.items():
            if needle in url:
                if isinstance(payload, Exception):
                    raise payload
                return payload
        raise AssertionError(f"未预期的 URL: {url}")

    return _get


def main() -> int:
    module = load_module()

    print("[1] 状态归一 run_status_from()")
    check("成功", module.run_status_from({"status": "completed", "conclusion": "success"})[0] == "success")
    check("失败", module.run_status_from({"status": "completed", "conclusion": "failure"})[0] == "failure")
    check(
        "进行中（conclusion 还为空）",
        module.run_status_from({"status": "in_progress", "conclusion": ""})[0] == "in_progress",
    )
    check("排队中", module.run_status_from({"status": "queued", "conclusion": None})[0] == "queued")
    check("空对象 -> unknown", module.run_status_from({})[0] == "unknown")
    check("垃圾输入 -> unknown", module.run_status_from({"status": "??"})[0] == "unknown")
    check(
        "取 updated_at 当采集时间",
        module.run_status_from({"status": "completed", "conclusion": "success", "updated_at": "2026-10-16T04:00:00Z"})[1]
        == "2026-10-16T04:00:00Z",
    )

    print("[2] 正常路径：两个工作流都查到了")
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "data" / "build_status.yml"
        module.api_get = fake_api_get(
            {
                "/actions/runs/12345": {
                    "status": "completed",
                    "conclusion": "success",
                    "updated_at": "2026-10-16T04:00:00Z",
                },
                "/actions/workflows/tools.yml/runs": {
                    "workflow_runs": [{"status": "completed", "conclusion": "failure"}]
                },
            }
        )
        code = module.main(["--repo", "WuSiTech/WuSiTech.github.io", "--run-id", "12345", "--token", "x", "--out", str(out)])
        text = out.read_text(encoding="utf-8")
        check("退出码 0", code == 0)
        check("本次运行写成 success", re.search(r"^status: \"success\"$", text, re.M) is not None, text[:200])
        check("采集时间用 run 的 updated_at", 'checked_at: "2026-10-16T04:00:00Z"' in text)
        check("另一个工作流写成 failure", 'status: "failure"' in text)
        check("两个工作流都在", "build_and_deploy:" in text and "tools_and_config_checks:" in text)
        check("Actions 链接就位", "actions/workflows/tools.yml" in text and "actions/workflows/hugo.yaml" in text)
        check("文件 UTF-8 无 BOM", not out.read_bytes().startswith(b"\xef\xbb\xbf"))
        check("文件是 LF 结尾", out.read_bytes().endswith(b"\n") and b"\r\n" not in out.read_bytes())

    print("[3] 降级：API 全挂也只能写 unknown，且 exit 0")
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "build_status.yml"
        module.api_get = fake_api_get(
            {
                "/actions/runs/": urllib.error.HTTPError("u", 403, "rate limited", None, None),
                "/actions/workflows/": OSError("no network"),
            }
        )
        code = module.main(["--repo", "o/r", "--run-id", "1", "--token", "x", "--out", str(out)])
        text = out.read_text(encoding="utf-8")
        check("退出码仍是 0", code == 0)
        check("本次运行 unknown", re.search(r"^status: \"unknown\"$", text, re.M) is not None, text[:200])
        check("另一个工作流 unknown", text.count('status: "unknown"') >= 3, text)
        check("文件照样写出来了", out.exists() and len(text) > 200)

    print("[4] 降级：连 repo / token 都没有（本地手动跑）")
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "build_status.yml"
        code = module.main(["--out", str(out)])
        text = out.read_text(encoding="utf-8")
        check("退出码 0", code == 0)
        check("全是 unknown", text.count('"unknown"') >= 3)
        check("checked_at 有值（用当前时间兜底）", re.search(r'^checked_at: "\d{4}-\d\d-\d\dT', text, re.M) is not None, text)

    print("[5] 采集时间能被 Hugo 解析（time.AsTime）")
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "build_status.yml"
        module.api_get = fake_api_get({"/actions/runs/": {}, "/actions/workflows/": {"workflow_runs": []}})
        module.main(["--repo", "o/r", "--run-id", "9", "--token", "x", "--out", str(out)])
        text = out.read_text(encoding="utf-8")
        stamp = re.search(r'^checked_at: "([^"]*)"$', text, re.M).group(1)
        parsed = datetime.fromisoformat(stamp)
        check("带时区偏移", parsed.tzinfo is not None, stamp)
        check("可被 fromisoformat 解析", True)

    print("[6] 写文件是原子的（不会留下 .tmp 垃圾）")
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "sub" / "build_status.yml"
        module.write_atomic(out, "a: 1\n")
        leftovers = [p.name for p in out.parent.iterdir() if p.name != out.name]
        check("目录被创建", out.parent.is_dir())
        check("没有临时文件残留", leftovers == [], str(leftovers))

    print("[7] YAML 引号转义（名字里带引号也不会写坏）")
    doc = module.build_document(
        {
            "build_and_deploy": {"status": "success", "conclusion": "success"},
            "tools_and_config_checks": {"status": "unknown", "conclusion": ""},
        },
        "2026-10-16T12:00:00+08:00",
        "abc1234",
        'we"ird/repo',
    )
    check("引号被转义", '\\"' in doc, doc)
    check("没有裸引号破坏 YAML", doc.count('"') % 2 == 0, str(doc.count('"')))

    print()
    if failures:
        print(f"RESULT: FAILED（{len(failures)} 项）：{', '.join(failures)}")
        return 1
    print("RESULT: ALL PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
