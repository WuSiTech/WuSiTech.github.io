#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""check_twikoo.py —— 部署评论后端后先用它自检，别等到页面上才发现问题

用法：
    python tools/check_twikoo.py https://xxx.netlify.app/.netlify/functions/twikoo

它会检查 4 件事：
  1. 地址能不能访问、返回的是不是 Twikoo 的服务（而不是 Netlify 的 404 页面）
  2. 云函数版本（GET_FUNC_VERSION），能确认前后端版本大致匹配
  3. **CORS 头**：是否允许你的博客域名跨域调用（这是最常见的坑：
     后端没配好时评论框会显示“加载失败”，但原因很难看出来）
  4. 匿名读评论接口是否正常（GET_COMMENTS_COUNT）

只用标准库，任何 Python 3.8+ 都能跑。
"""

from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request

SITE_ORIGINS = ["https://wusitech.github.io", "https://wstk.pages.dev"]


def post(url: str, payload: dict, origin: str, timeout: int = 20):
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Origin": origin,
            "User-Agent": "check_twikoo.py",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read().decode("utf-8", "replace")
        try:
            return resp.status, dict(resp.headers), json.loads(raw)
        except json.JSONDecodeError:
            return resp.status, dict(resp.headers), {"_raw": raw[:300]}


def main(argv=None) -> int:
    # 中文 Windows 控制台常是 GBK，遇到无法编码的字符不要让程序崩掉
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except Exception:
            pass
    argv = argv if argv is not None else sys.argv[1:]
    if not argv:
        print(__doc__)
        return 2
    env_id = argv[0].rstrip("/")
    origin = SITE_ORIGINS[0]
    ok = True

    print(f"检查目标：{env_id}\n")

    # 1) 可访问性
    try:
        req = urllib.request.Request(env_id, headers={"User-Agent": "check_twikoo.py"})
        with urllib.request.urlopen(req, timeout=20) as resp:
            text = resp.read().decode("utf-8", "replace")
            status = resp.status
        looks_like_twikoo = ("Twikoo" in text) or ("twikoo" in text.lower())
        print(f"  1) 可访问性: HTTP {status}  {'[OK] 看起来是 Twikoo 服务' if looks_like_twikoo else '[!] 返回内容里没看到 Twikoo 字样'}")
        if not looks_like_twikoo:
            print(f"     返回片段: {text[:200]!r}")
            ok = False
    except urllib.error.HTTPError as exc:
        print(f"  1) 可访问性: HTTP {exc.code} [X]（地址可能不对；Netlify 的 404 通常就是路径写错）")
        ok = False
    except Exception as exc:  # noqa: BLE001
        print(f"  1) 可访问性: 连接失败 [X] {type(exc).__name__}: {exc}")
        return 1

    # 2) 云函数版本
    try:
        status, headers, data = post(env_id, {"event": "GET_FUNC_VERSION"}, origin)
        code = data.get("code")
        if code == 0:
            print(f"  2) 云函数版本: [OK] {data.get('data')}")
        else:
            print(f"  2) 云函数版本: [!] code={code} message={data.get('message') or data.get('_raw')}")
            ok = False
    except Exception as exc:  # noqa: BLE001
        print(f"  2) 云函数版本: 请求失败 [X] {type(exc).__name__}: {exc}")
        ok = False

    # 3) CORS（最容易踩的坑）
    try:
        status, headers, data = post(env_id, {"event": "GET_FUNC_VERSION"}, origin)
        allow = headers.get("Access-Control-Allow-Origin") or headers.get("access-control-allow-origin")
        if allow in ("*", origin):
            print(f"  3) CORS: [OK] Access-Control-Allow-Origin = {allow}")
        else:
            print(f"  3) CORS: [X] 没看到允许 {origin} 的跨域头（浏览器会拦下请求，评论区会显示加载失败）")
            print(f"     实际返回的头: {allow!r}；所有响应头: {list(headers)[:8]}")
            ok = False
    except Exception as exc:  # noqa: BLE001
        print(f"  3) CORS: 无法判断 [X] {type(exc).__name__}: {exc}")
        ok = False

    # 4) 读接口
    try:
        status, headers, data = post(
            env_id,
            {"event": "GET_COMMENTS_COUNT", "url": "/", "includeReply": False},
            origin,
        )
        if data.get("code") == 0:
            print("  4) 读评论接口: [OK] 正常返回")
        else:
            print(f"  4) 读评论接口: [!] code={data.get('code')} message={data.get('message') or data.get('_raw')}")
            ok = False
    except Exception as exc:  # noqa: BLE001
        print(f"  4) 读评论接口: 请求失败 [X] {type(exc).__name__}: {exc}")
        ok = False

    print()
    if ok:
        print("结论：后端可用 [OK] 把上面这个地址填进 config/_default/params.yml 的 twikoo.envId 即可。")
        print("      （如果还没配 MongoDB，评论能读不能写，发送时才会报错）")
        return 0
    print("结论：还有问题 [X] 先按上面提示排查，再填进配置。")
    return 1


if __name__ == "__main__":
    sys.exit(main())
