# Sveltia CMS 登录中转（Vercel 版）

Cloudflare Worker 版（`../cms-oauth-worker/worker.js`）的等价实现，用于 workers.dev 在部分网络下不可达时替换。

## 部署

1. Vercel → Add New → Project → 选本仓库（`WuSiTech/WuSiTech.github.io`）
2. **Root Directory** 填 `tools/cms-oauth-vercel`，Framework 选 Other
3. Environment Variables：

| 变量 | 值 |
| --- | --- |
| `GITHUB_CLIENT_ID` | GitHub OAuth App 的 Client ID |
| `GITHUB_CLIENT_SECRET` | Client Secret |
| `ALLOWED_GITHUB_USERS` | `WuSiTech` |
| `ALLOWED_ORIGINS` | `https://wstek.win,https://wusitech.github.io,https://wstk.pages.dev,http://localhost:1313` |

4. Deploy → 访问 `https://<项目>.vercel.app/` 应返回 `sveltia-cms-auth (vercel): ok`

## 切换后台配置

1. GitHub OAuth App → Authorization callback URL 改为 `https://<项目>.vercel.app/callback`
2. 仓库 `static/admin/config.yml` → `backend.base_url` 改为 `https://<项目>.vercel.app`
3. 重新构建部署