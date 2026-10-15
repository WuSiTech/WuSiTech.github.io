/**
 * Cloudflare Worker：给 Sveltia CMS 的 GitHub 登录做 OAuth 中转
 * ----------------------------------------------------------------------------
 * 为什么需要它：GitHub OAuth 换 token 必须用到 Client Secret，
 * 而 Secret 不能写进公开的静态页面里，所以用一个免费 Worker 代劳。
 *
 * 路由：
 *   GET /           自检，返回 "sveltia-cms-auth: ok"
 *   GET /auth       跳转 GitHub 授权页（CMS 会打开它）
 *   GET /callback   GitHub 回调：换 token → 校验账号 → 把 token 交回 CMS 窗口
 *
 * 需要在 Worker 的 Settings → Variables and secrets 里配置：
 *   GITHUB_CLIENT_ID       GitHub OAuth App 的 Client ID            （Text）
 *   GITHUB_CLIENT_SECRET   GitHub OAuth App 的 Client Secret        （Secret，务必用加密类型）
 *   ALLOWED_GITHUB_USERS   允许登录的 GitHub 用户名，逗号分隔       （如 WuSiTech）
 *   ALLOWED_ORIGINS        允许发起登录的站点，逗号分隔             （如 https://wusitech.github.io,https://wstk.pages.dev,http://localhost:1313）
 *
 * 安全设计：
 *   - state 用 HMAC-SHA256 签名（密钥复用 Client Secret），防止伪造回调；10 分钟过期
 *   - 只有 ALLOWED_ORIGINS 里的站点能发起登录
 *   - 登录后还要查一次 /user，只放行 ALLOWED_GITHUB_USERS 里的账号
 *   - Worker 本身不存任何数据（无数据库、无 KV）
 */

const GITHUB_AUTHORIZE = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN = 'https://github.com/login/oauth/access_token';
const GITHUB_USER = 'https://api.github.com/user';
const STATE_TTL_MS = 10 * 60 * 1000;

function splitEnv(value) {
  return (value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function hmacHex(secret, data) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 注意：这里刻意不用 escape()/unescape()——它们是 Node/浏览器遗留函数，
// Cloudflare Workers（workerd）里不保证存在，用 TextEncoder/TextDecoder 才稳。
function b64urlEncode(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(text) {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function html(body) {
  return new Response(`<!doctype html><meta charset="utf-8"><title>后台登录</title>
<body style="font:14px/1.8 system-ui,-apple-system,'Microsoft YaHei',sans-serif;padding:28px;color:#444">${body}</body>`,
  { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

/** 回调页：先告诉 CMS「开始授权了」，收到 CMS 的回应后把 token 传给它 */
function popupPage(origin, token) {
  const message = 'authorization:github:success:' + JSON.stringify({ token, provider: 'github' });
  const target = origin || '*';
  return `<!doctype html><meta charset="utf-8"><title>登录成功</title>
<body style="font:14px/1.8 system-ui,-apple-system,'Microsoft YaHei',sans-serif;padding:28px;color:#444">
登录成功，正在把身份交回后台…这个窗口会自动关闭。
<script>
  (function () {
    var payload = ${JSON.stringify(message)};
    function receiveMessage(e) {
      if (${JSON.stringify(origin)} && e.origin !== ${JSON.stringify(origin)}) return;
      window.opener.postMessage(payload, e.origin);
      window.removeEventListener('message', receiveMessage, false);
      setTimeout(function () { window.close(); }, 200);
    }
    window.addEventListener('message', receiveMessage, false);
    window.opener.postMessage('authorizing:github', ${JSON.stringify(target)});
  })();
</script>`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const allowedOrigins = splitEnv(env.ALLOWED_ORIGINS);

    if (url.pathname === '/') {
      return new Response('sveltia-cms-auth: ok\n', {
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }

    if (url.pathname === '/auth') {
      const provider = url.searchParams.get('provider') || 'github';
      if (provider !== 'github') return new Response('unsupported provider', { status: 400 });
      if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
        return new Response('Worker 缺少 GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET 环境变量', { status: 500 });
      }
      const siteId = url.searchParams.get('site_id') || '';
      const scope = url.searchParams.get('scope') || 'repo';
      const origin = request.headers.get('Origin') || '';
      if (allowedOrigins.length && origin && !allowedOrigins.includes(origin)) {
        return new Response('origin not allowed: ' + origin, { status: 403 });
      }
      const ts = Date.now().toString();
      const payload = [siteId, origin, ts].join('|');
      const state = b64urlEncode(payload + '|' + (await hmacHex(env.GITHUB_CLIENT_SECRET, payload)));

      const redirect = new URL(GITHUB_AUTHORIZE);
      redirect.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
      redirect.searchParams.set('redirect_uri', `${url.origin}/callback`);
      redirect.searchParams.set('scope', scope);
      redirect.searchParams.set('state', state);
      return Response.redirect(redirect.toString(), 302);
    }

    if (url.pathname === '/callback') {
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state') || '';
      if (!code || !state) return new Response('missing code or state', { status: 400 });

      let decoded;
      try {
        decoded = b64urlDecode(state);
      } catch {
        return new Response('bad state encoding', { status: 400 });
      }
      const parts = decoded.split('|');
      if (parts.length !== 4) return new Response('bad state', { status: 400 });
      const [siteId, origin, ts, sig] = parts;
      const expected = await hmacHex(env.GITHUB_CLIENT_SECRET, [siteId, origin, ts].join('|'));
      if (expected !== sig) return new Response('state signature mismatch', { status: 403 });
      if (Date.now() - Number(ts) > STATE_TTL_MS) return new Response('state expired', { status: 403 });
      if (allowedOrigins.length && origin && !allowedOrigins.includes(origin)) {
        return new Response('origin not allowed: ' + origin, { status: 403 });
      }

      const tokenRes = await fetch(GITHUB_TOKEN, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'sveltia-cms-auth' },
        body: JSON.stringify({
          client_id: env.GITHUB_CLIENT_ID,
          client_secret: env.GITHUB_CLIENT_SECRET,
          code,
        }),
      });
      const tokenJson = await tokenRes.json().catch(() => ({}));
      const token = tokenJson.access_token;
      if (!token) {
        return html('<p>换取 GitHub token 失败。</p><pre>' + JSON.stringify(tokenJson, null, 2) + '</pre>');
      }

      const allowedUsers = splitEnv(env.ALLOWED_GITHUB_USERS).map((u) => u.toLowerCase());
      if (allowedUsers.length) {
        const userRes = await fetch(GITHUB_USER, {
          headers: {
            authorization: `Bearer ${token}`,
            accept: 'application/vnd.github+json',
            'user-agent': 'sveltia-cms-auth',
          },
        });
        const user = await userRes.json().catch(() => ({}));
        if (!user.login || !allowedUsers.includes(user.login.toLowerCase())) {
          return html('<p>这个 GitHub 账号（' + (user.login || '未知') + '）没有后台权限。</p>');
        }
      }

      return new Response(popupPage(origin, token), {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }

    return new Response('Not Found', { status: 404 });
  },
};
