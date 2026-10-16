#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""write_build_status.py —— 把两个 GitHub Actions 工作流的最近结论写进 data/build_status.yml

用法（CI 里在 `hugo` 构建之前跑一次）：

    python .github/scripts/write_build_status.py \
        --repo WuSiTech/WuSiTech.github.io \
        --run-id "$GITHUB_RUN_ID" \
        --token "$GITHUB_TOKEN" \
        --out data/build_status.yml

它做两件事：
  1. 读/写 data/build_status.yml（Hugo 构建时把它渲染成 /build-status.json，
     供右下角「构建状态」挂件显示）；
  2. 「Build and deploy」用**本次运行的结论**（GITHUB_RUN_ID），
     「Tools and config checks」用 GitHub REST API 查最近一次运行的结论。

设计原则：**绝不阻塞构建**
  - 任何一步失败（没网、API 限流、token 没权限、返回的 JSON 不符合预期）都只打一条
    警告，然后把对应状态写成 unknown，脚本本身始终 exit 0；
  - 写文件是「先写临时文件再替换」，不会留下半截 YAML；
  - data/build_status.yml 里本来就有仓库提交的默认值，即使这个脚本整个跑挂，
    Hugo 也能正常构建，只是挂件显示「未知」。

只用标准库（urllib），Python 3.8+ 都能跑。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

API = "https://api.github.com"

# 工作流文件 → data/build_status.yml 里的键 / 挂件胶囊的 data-item-key
WORKFLOWS = {
    "build_and_deploy": {
        "name": "Build and deploy",
        "file": "hugo.yaml",
    },
    "tools_and_config_checks": {
        "name": "Tools and config checks",
        "file": "tools.yml",
    },
}

# 会写进 YAML 的结论白名单；不在名单里的（API 抽风、字段改名）一律当 unknown
KNOWN_CONCLUSIONS = {"success", "failure", "cancelled", "timed_out", "action_required", "skipped", "neutral", "stale"}


def log(msg: str) -> None:
    print(f"[build-status] {msg}")


def warn(msg: str) -> None:
    # 用 ::warning:: 让 GitHub Actions 在页面上标出来，但不让这一步失败
    print(f"::warning::write_build_status: {msg}")
    log(f"WARN {msg}")


def normalize(value, default: str = "unknown") -> str:
    """把 API/环境变量里的状态值归一成小写字符串。"""
    if value is None:
        return default
    text = str(value).strip().lower()
    return text or default


def api_get(url: str, token: str, timeout: int = 20):
    """GET 一个 GitHub API 地址；失败抛异常，由调用方兜住。"""
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "wusitech-build-status",
            "Authorization": f"Bearer {token}",
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8", "replace"))


def run_status_from(payload: dict) -> tuple[str, str]:
    """从一次 workflow run 的 JSON 里取 (status, checked_at)。

    运行还没结束时，conclusion 是空字符串而 status 是 queued/in_progress，
    这时返回 status，让挂件显示「排队中 / 进行中」而不是「未知」。
    """
    if not isinstance(payload, dict):
        return "unknown", ""
    status = normalize(payload.get("status"))
    conclusion = normalize(payload.get("conclusion"), default="")
    when = payload.get("updated_at") or payload.get("run_started_at") or payload.get("created_at") or ""
    if conclusion and conclusion in KNOWN_CONCLUSIONS:
        return conclusion, str(when)
    if status in ("queued", "in_progress", "requested", "waiting", "pending"):
        return status, str(when)
    if conclusion and conclusion != "unknown":
        return conclusion, str(when)
    return "unknown", str(when)


def fetch_latest_run(repo: str, workflow_file: str, token: str, branch: str) -> tuple[str, str]:
    """查某个工作流在指定分支上最近一次运行（含正在跑的）的结论。"""
    query = f"{API}/repos/{repo}/actions/workflows/{workflow_file}/runs?per_page=1"
    if branch:
        query += f"&branch={branch}"
    payload = api_get(query, token)
    runs = payload.get("workflow_runs") if isinstance(payload, dict) else None
    if not runs:
        return "unknown", ""
    return run_status_from(runs[0])


def yaml_quote(text: str) -> str:
    """把字符串安全地写成 YAML 双引号标量。"""
    escaped = text.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def build_document(statuses: dict, checked_at: str, commit: str, repo: str) -> str:
    lines = [
        "# 构建状态（供右下角「构建状态」挂件显示）",
        "# ---------------------------------------------------------------------------",
        "# ⚠️ 这个文件在 CI 里由 .github/scripts/write_build_status.py 覆盖生成（不提交），",
        "#    每次运行都会重写；要改字段含义请改那个脚本 / layouts/_default/single.buildstatus.json。",
        "#    仓库里提交的那份只是**本地构建的默认值**（status: unknown）。",
        "#",
        "# 字段说明：",
        "#   status      当前这次 “Build and deploy” 运行的结论",
        "#   checked_at  状态采集时间（ISO 8601，带时区）；空字符串表示没采到数据",
        "#   commit      触发本次运行的提交短 SHA",
        "#   workflows   另一个工作流（Tools and config checks）的最近一次结论",
        "status: " + yaml_quote(statuses["build_and_deploy"]["status"]),
        "checked_at: " + yaml_quote(checked_at),
        "commit: " + yaml_quote(commit),
        "workflows:",
    ]
    for key, meta in WORKFLOWS.items():
        info = statuses[key]
        lines.append(f"  {key}:")
        lines.append(f"    name: {yaml_quote(meta['name'])}")
        lines.append(f"    status: {yaml_quote(info['status'])}")
        lines.append(f"    conclusion: {yaml_quote(info['conclusion'])}")
        lines.append(
            "    href: " + yaml_quote(f"https://github.com/{repo}/actions/workflows/{meta['file']}")
        )
    lines.append("")
    return "\n".join(lines)


def write_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=str(path.parent), prefix=".build_status.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
        os.replace(tmp_name, path)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="写 data/build_status.yml（构建状态挂件的数据源）")
    parser.add_argument("--repo", default=os.environ.get("GITHUB_REPOSITORY", ""), help="owner/repo")
    parser.add_argument("--run-id", default=os.environ.get("GITHUB_RUN_ID", ""), help="本次运行 ID")
    parser.add_argument(
        "--token",
        default=os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN") or "",
        help="GitHub token（默认读 GH_TOKEN / GITHUB_TOKEN）",
    )
    parser.add_argument("--branch", default="", help="只查该分支上的运行（默认查所有分支）")
    parser.add_argument("--out", default="data/build_status.yml", help="输出文件")
    args = parser.parse_args(argv)

    checked_at = datetime.now(timezone.utc).astimezone().replace(microsecond=0).isoformat()
    commit = (os.environ.get("GITHUB_SHA") or "")[:7]

    statuses = {
        "build_and_deploy": {"status": "unknown", "conclusion": ""},
        "tools_and_config_checks": {"status": "unknown", "conclusion": ""},
    }

    # 1) 本次运行：优先直接问 API（这样即使更早的步骤失败也能拿到真实 conclusion）
    got_current = False
    if args.repo and args.run_id and args.token:
        try:
            payload = api_get(f"{API}/repos/{args.repo}/actions/runs/{args.run_id}", args.token)
            status, when = run_status_from(payload)
            statuses["build_and_deploy"] = {"status": status, "conclusion": normalize(payload.get("conclusion"), "")}
            if when:
                checked_at = when
            got_current = True
        except Exception as exc:  # noqa: BLE001 —— 任何异常都要降级，不能中断构建
            warn(f"读取本次运行状态失败（{exc}）；改用环境变量兜底")
    else:
        warn("缺少 repo / run-id / token，跳过本次运行状态的 API 查询")

    if not got_current:
        # 兜底：只有本步骤之前所有步骤都成功时，GITHUB_RUN_ID 才一定存在；
        # 拿不到真实 conclusion 就写 unknown，宁缺毋滥。
        statuses["build_and_deploy"] = {"status": "unknown", "conclusion": ""}

    # 2) 另一个工作流：查最近一次运行
    if args.repo and args.token:
        try:
            status, _ = fetch_latest_run(
                args.repo, WORKFLOWS["tools_and_config_checks"]["file"], args.token, args.branch
            )
            statuses["tools_and_config_checks"] = {"status": status, "conclusion": status}
        except Exception as exc:  # noqa: BLE001
            warn(f"读取 Tools and config checks 最近状态失败（{exc}）；该项显示为「未知」")
    else:
        warn("缺少 repo / token，跳过另一个工作流的状态查询")

    document = build_document(statuses, checked_at, commit, args.repo or "WuSiTech/WuSiTech.github.io")
    try:
        write_atomic(Path(args.out), document)
    except Exception as exc:  # noqa: BLE001
        warn(f"写入 {args.out} 失败（{exc}）；保留仓库里的默认值，构建继续")
        return 0

    log(
        "已写入 {path}：build_and_deploy={a}，tools_and_config_checks={b}，checked_at={c}".format(
            path=args.out,
            a=statuses["build_and_deploy"]["status"],
            b=statuses["tools_and_config_checks"]["status"],
            c=checked_at,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
