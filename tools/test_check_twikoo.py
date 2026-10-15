# -*- coding: utf-8 -*-
"""用一个假的 Twikoo 后端验证 tools/check_twikoo.py 的判断是否正确"""

import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "tools"))
import check_twikoo  # noqa: E402

PORT = 8199
SEND_CORS = {"value": True}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, body, ctype="application/json", status=200):
        data = body.encode("utf-8") if isinstance(body, str) else body
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        if SEND_CORS["value"]:
            self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self._send("Twikoo 云函数运行正常，请参考 https://twikoo.js.org/", "text/html; charset=utf-8")

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        payload = json.loads(self.rfile.read(length) or b"{}")
        event = payload.get("event")
        if event == "GET_FUNC_VERSION":
            self._send(json.dumps({"code": 0, "data": "2.0.15"}))
        elif event == "GET_COMMENTS_COUNT":
            self._send(json.dumps({"code": 0, "data": []}))
        else:
            self._send(json.dumps({"code": 100, "message": "unknown event"}))


def main():
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{PORT}/.netlify/functions/twikoo"

    print("=== 场景 1：后端正常且有 CORS（应全部通过）===")
    SEND_CORS["value"] = True
    rc1 = check_twikoo.main([url])
    print(f"   退出码 = {rc1}（期望 0）")

    print("\n=== 场景 2：后端没发 CORS 头（应准确指出跨域问题）===")
    SEND_CORS["value"] = False
    rc2 = check_twikoo.main([url])
    print(f"   退出码 = {rc2}（期望 1）")

    print("\n=== 场景 3：地址不存在（应给出清晰错误而不是崩栈）===")
    rc3 = check_twikoo.main(["http://127.0.0.1:1/.netlify/functions/twikoo"])
    print(f"   退出码 = {rc3}（期望 1）")

    print("\n=== 场景 4：不带参数（应打印用法）===")
    rc4 = check_twikoo.main([])
    print(f"   退出码 = {rc4}（期望 2）")

    srv.shutdown()
    ok = rc1 == 0 and rc2 == 1 and rc3 == 1 and rc4 == 2
    print("\nRESULT:", "ALL PASS" if ok else "FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
