/**
 * Sveltia CMS 的 GitHub OAuth 中转 —— Vercel 版（与 Cloudflare Worker 版逻辑一致）
 *
 * 路由（由 vercel.json 重写到这里）：
 *   GET /           自检
 *   GET /auth       跳转 GitHub 授权页
 *   GET /callback   换 token → 校验账号 → 把 token 交回 CMS 窗口
 *
 * Vercel 环境变量：GITHUB_CLIENT_ID、GITHUB_CLIENT_SECRET、ALLOWED_GITHUB_USERS、ALLOWED_ORIGINS
 */
const GITHUB_AUTHORIZE = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN = 'https://github.com/login/oauth/access_token';
const GITHUB_USER = 'https://api.github.com/user';
const STATE_TTL_MS = 10 * 60 * 1000;

function splitEnv(v) {
  return (v || '').split(',').map((s) => s.trim()).filter(Boolean);
}

async function hmacHex(secret, data) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function b64urlEncode(text) {
  return Buffer.from(text, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(text) {
  const p = text.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(p, 'base64').toString('utf8');
}

function html(res, body) {
  res.statusCode = 200;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><meta charset="utf-8"><title>后台登录</title><body style="font:14px/1.8 system-ui,-apple-system,'Microsoft YaHei',sans-serif;padding:28px;color:#444">${body}</body>`);
}

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

module.exports = async function handler(req, res) {
  const url = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
  const env = process.env;
  const allowedOrigins = splitEnv(env.ALLOWED_ORIGINS);
  const origin = req.headers.origin || '';

  if (url.pathname === '/' || url.pathname === '/api/index' || url.pathname === '/api') {
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    return res.end('sveltia-cms-auth (vercel): ok\n');
  }

  if (url.pathname === '/auth') {
    const provider = url.searchParams.get('provider') || 'github';
    if (provider !== 'github') { res.statusCode = 400; return res.end('unsupported provider'); }
    if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
      res.statusCode = 500;
      return res.end('缺少 GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET 环境变量');
    }
    const siteId = url.searchParams.get('site_id') || '';
    const scope = url.searchParams.get('scope') || 'repo';
    if (allowedOrigins.length && origin && !allowedOrigins.includes(origin)) {
      res.statusCode = 403; return res.end('origin not allowed: ' + origin);
    }
    const ts = Date.now().toString();
    const payload = [siteId, origin, ts].join('|');
    const state = b64urlEncode(payload + '|' + (await hmacHex(env.GITHUB_CLIENT_SECRET, payload)));
    const redirect = new URL(GITHUB_AUTHORIZE);
    redirect.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
    redirect.searchParams.set('redirect_uri', `${url.origin}/callback`);
    redirect.searchParams.set('scope', scope);
    redirect.searchParams.set('state', state);
    res.writeHead(302, { location: redirect.toString() });
    return res.end();
  }

  if (url.pathname === '/callback') {
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state') || '';
    if (!code || !state) { res.statusCode = 400; return res.end('missing code or state'); }
    let decoded;
    try { decoded = b64urlDecode(state); } catch { res.statusCode = 400; return res.end('bad state encoding'); }
    const parts = decoded.split('|');
    if (parts.length !== 4) { res.statusCode = 400; return res.end('bad state'); }
    const [siteId, cbOrigin, ts, sig] = parts;
    const expected = await hmacHex(env.GITHUB_CLIENT_SECRET, [siteId, cbOrigin, ts].join('|'));
    if (expected !== sig) { res.statusCode = 403; return res.end('state signature mismatch'); }
    if (Date.now() - Number(ts) > STATE_TTL_MS) { res.statusCode = 403; return res.end('state expired'); }
    if (allowedOrigins.length && cbOrigin && !allowedOrigins.includes(cbOrigin)) {
      res.statusCode = 403; return res.end('origin not allowed: ' + cbOrigin);
    }
    const tokenRes = await fetch(GITHUB_TOKEN, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'sveltia-cms-auth' },
      body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code }),
    });
    const tokenJson = await tokenRes.json().catch(() => ({}));
    const token = tokenJson.access_token;
    if (!token) {
      return html(res, '<p>换取 GitHub token 失败。</p><pre>' + JSON.stringify(tokenJson, null, 2) + '</pre>');
    }
    const allowedUsers = splitEnv(env.ALLOWED_GITHUB_USERS).map((u) => u.toLowerCase());
    if (allowedUsers.length) {
      const userRes = await fetch(GITHUB_USER, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'sveltia-cms-auth' },
      });
      const user = await userRes.json().catch(() => ({}));
      if (!user.login || !allowedUsers.includes(user.login.toLowerCase())) {
        return html(res, '<p>这个 GitHub 账号（' + (user.login || '未知') + '）没有后台权限。</p>');
      }
    }
    res.statusCode = 200;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    return res.end(popupPage(cbOrigin, token));
  }

  res.statusCode = 404;
  res.end('Not Found');
};