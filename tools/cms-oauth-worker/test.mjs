/**
 * cms-oauth-worker 的自测（Node 18+ 直接跑）：
 *     node tools/cms-oauth-worker/test.mjs
 *
 * 它用假的 fetch 顶替 GitHub，把「登录中转」的完整链路和几种攻击场景都跑一遍，
 * 这样你在 Cloudflare 上部署之前就能确认逻辑没问题。
 */

import worker from './worker.js';

const WORKER = 'https://wusitech-cms-auth.example.workers.dev';
const SITE = 'https://wusitech.github.io';

const env = {
  GITHUB_CLIENT_ID: 'test_client_id',
  GITHUB_CLIENT_SECRET: 'test_client_secret',
  ALLOWED_GITHUB_USERS: 'WuSiTech',
  ALLOWED_ORIGINS: 'https://wusitech.github.io,https://wstk.pages.dev,http://localhost:1313',
};

let fakeUser = { login: 'WuSiTech' };
let tokenResponse = { access_token: 'gho_faketoken123' };

globalThis.fetch = async (url, init) => {
  const target = String(url);
  if (target.startsWith('https://github.com/login/oauth/access_token')) {
    return new Response(JSON.stringify(tokenResponse), { headers: { 'content-type': 'application/json' } });
  }
  if (target.startsWith('https://api.github.com/user')) {
    return new Response(JSON.stringify(fakeUser), { headers: { 'content-type': 'application/json' } });
  }
  throw new Error('测试里没预期的请求: ' + target);
};

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  → ' + detail : ''}`);
}

async function call(path, headers = {}) {
  return worker.fetch(new Request(WORKER + path, { headers }), env);
}

// 1) 自检路由
{
  const res = await call('/');
  const body = await res.text();
  check('GET / 自检', res.status === 200 && body.includes('ok'), `${res.status} ${body.trim()}`);
}

// 2) /auth 跳转参数
let state = '';
{
  const res = await call('/auth?provider=github&site_id=test&scope=repo', { Origin: SITE });
  const loc = res.headers.get('location') || '';
  const u = new URL(loc);
  state = u.searchParams.get('state') || '';
  const ok =
    res.status === 302 &&
    u.origin === 'https://github.com' &&
    u.searchParams.get('client_id') === env.GITHUB_CLIENT_ID &&
    u.searchParams.get('redirect_uri') === WORKER + '/callback' &&
    u.searchParams.get('scope') === 'repo' &&
    state.length > 10;
  check('/auth 跳转 GitHub 参数正确', ok, `${res.status} redirect_uri=${u.searchParams.get('redirect_uri')}`);
}

// 3) 正常回调：换 token 并把身份交回 CMS
{
  const res = await call(`/callback?code=goodcode&state=${encodeURIComponent(state)}`);
  const body = await res.text();
  const ok =
    res.status === 200 &&
    body.includes('authorization:github:success:') &&
    body.includes('gho_faketoken123') &&
    body.includes('authorizing:github');
  check('正常回调返回 token 给 CMS', ok, `status=${res.status}`);
}

// 4) 篡改 state → 拒绝
{
  const tampered = state.slice(0, -2) + (state.endsWith('00') ? '11' : '00');
  const res = await call(`/callback?code=goodcode&state=${encodeURIComponent(tampered)}`);
  check('篡改 state 被拒绝', res.status === 403, `status=${res.status}`);
}

// 5) 伪造 state（自己 btoa 一个合法结构）→ 拒绝
{
  const fake = Buffer.from(`test|${SITE}|${Date.now()}|deadbeef`).toString('base64url');
  const res = await call(`/callback?code=goodcode&state=${encodeURIComponent(fake)}`);
  check('伪造签名被拒绝', res.status === 403, `status=${res.status}`);
}

// 6) 过期 state（>10 分钟）→ 拒绝（需要用真签名，所以拿 auth 生成后改时间戳不可行，
//    改为验证「签名覆盖了时间戳」：改动时间戳必然签名不匹配）
{
  const [siteId, origin, ts, sig] = Buffer.from(state, 'base64url').toString('utf8').split('|');
  const older = [siteId, origin, String(Number(ts) - 11 * 60 * 1000), sig].join('|');
  const res = await call(`/callback?code=goodcode&state=${encodeURIComponent(Buffer.from(older).toString('base64url'))}`);
  check('改动时间戳会失败（时间戳在签名内）', res.status === 403, `status=${res.status}`);
}

// 7) 不在白名单的来源 → 拒绝
{
  const res = await call('/auth?provider=github&site_id=test', { Origin: 'https://evil.example.com' });
  check('非白名单来源被拒绝', res.status === 403, `status=${res.status}`);
}

// 8) 非白名单 GitHub 账号 → 不给 token
{
  fakeUser = { login: 'someone-else' };
  const res = await call(`/callback?code=goodcode&state=${encodeURIComponent(state)}`);
  const body = await res.text();
  check('非白名单账号无法登录', res.status === 200 && !body.includes('gho_faketoken123') && body.includes('没有后台权限'), `status=${res.status}`);
  fakeUser = { login: 'WuSiTech' };
}

// 9) token 交换失败 → 有可读报错
{
  tokenResponse = { error: 'bad_verification_code' };
  const res = await call(`/callback?code=bad&state=${encodeURIComponent(state)}`);
  const body = await res.text();
  check('token 交换失败时有可读提示', res.status === 200 && body.includes('换取 GitHub token 失败'), `status=${res.status}`);
  tokenResponse = { access_token: 'gho_faketoken123' };
}

// 10) 不支持的后端
{
  const res = await call('/auth?provider=gitlab');
  check('不支持的后端返回 400', res.status === 400, `status=${res.status}`);
}

// 11) 缺参数
{
  const res = await call('/callback?code=only');
  check('缺 state 返回 400', res.status === 400, `status=${res.status}`);
}

// 12) 源码卫生：不能出现 Workers 里不保证存在的遗留函数
{
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./worker.js', import.meta.url), 'utf8');
  const bad = /\b(unescape|escape|decodeURIComponent\(escape)\s*\(/.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, ''))
    && /unescape\(|escape\(/.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, ''));
  check('没有使用 escape/unescape（workerd 不保证存在）', !bad);
}

const failed = results.filter((r) => !r.pass);
console.log(`\nRESULT: ${failed.length === 0 ? 'ALL PASS' : failed.length + ' FAILED'}  (${results.length} 项)`);
process.exit(failed.length === 0 ? 0 : 1);
