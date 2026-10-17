/**
 * Cloudflare Pages Function：把评论写进 Git 仓库
 * ----------------------------------------------------------------------------
 * 路由：POST /api/comment
 *
 * 设计思路：站点是纯静态的，没有数据库。评论的「读」直接读静态 JSON 文件
 * （static/comments/<slug>.json → 线上 /comments/<slug>.json），
 * 「写」则由这个 Function 调用 GitHub Contents API 提交到仓库：
 *   - COMMENT_MODE=pr     新建分支 → 写文件 → 开 PR，你在 GitHub 上审核合并后才上线（默认）
 *   - COMMENT_MODE=direct 直接写 GITHUB_BRANCH，等一次构建部署即可看到
 *
 * COMMENT_MODE=direct 时还可以再叠加 COMMENT_PENDING（新评论默认隐藏，站长在后台放行）：
 *   - COMMENT_PENDING=true（未设置时的默认值）：新评论照常写进 JSON，但 hidden 落成 true，
 *     前端 comments.js 不渲染 hidden===true 的条目 —— 也就是「直接提交、默认隐藏」。
 *     站长在后台 CMS（/admin/ → 评论）把这条的「隐藏」关掉并保存后，
 *     等一次构建部署（约 1 分钟）就会出现在页面上。数据一直都在仓库里，不会丢。
 *   - COMMENT_PENDING=false：新评论 hidden=false，等一次构建（约 1 分钟）直接显示。
 *   取值大小写不敏感：true / TRUE / True 都算「开」，false / FALSE / False 都算「关」；
 *   其他任何值（含空字符串、yes、1、拼错的值）一律按默认值 true 处理
 *   —— 拿不准时宁可先隐藏，不要让垃圾评论直接上线。
 *   COMMENT_MODE=pr 不受 COMMENT_PENDING 影响：评论本来就停在分支上等人合并，
 *   PR 本身就是待审状态，所以 pr 模式写出来的评论始终 hidden=false。
 *
 * 需要配置的环境变量（Cloudflare Pages → Settings → Environment variables）：
 *   GITHUB_TOKEN    必填。细粒度令牌，只选 WuSiTech.github.io，
 *                   权限：Contents 读写 + Pull requests 读写
 *   GITHUB_REPO     默认 WuSiTech/WuSiTech.github.io
 *   GITHUB_BRANCH   默认 main
 *   COMMENT_MODE    pr / direct，默认 pr
 *   COMMENT_PENDING 仅对 direct 生效，true / false，默认 true（待站长审核）
 *   ALLOWED_ORIGINS 逗号分隔，默认 https://wusitech.github.io,https://wstk.pages.dev
 *
 * 核心逻辑写成可注入依赖的纯函数 handleComment(request, env, deps)，
 * 方便 tools/git-comments/test.mjs 用假的 fetch 完整跑一遍（见该文件）。
 */

const DEFAULT_ALLOWED_ORIGINS = 'https://wstek.win,https://www.wstek.win,https://wusitech.github.io,https://wstk.pages.dev';
const DEFAULT_REPO = 'WuSiTech/WuSiTech.github.io';
const DEFAULT_BRANCH = 'main';
const API = 'https://api.github.com';

const MAX_SLUG_LEN = 200;
const MAX_NAME_LEN = 40;
const MAX_BODY_LEN = 2000;
const MAX_OPTIONAL_LEN = 200;
const MAX_LINKS = 5;

const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 3;

const PUT_RETRY_MAX = 3;

// 同一 IP 的提交时间戳。
// 注意：Functions 是无状态的，这里只是个模块级内存 Map，
// 同一个实例上才有效，实例重启（或请求落到另一个实例）即清零，
// 所以它只是「基本防刷」，挡不住认真刷的人。要严格限流得上 KV / Durable Objects。
const rateBuckets = new Map();

/** 仅供测试清空内存限流状态，生产代码不会调用 */
export function __resetRateLimit() {
  rateBuckets.clear();
}

function splitEnv(value) {
  return (value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

/** 去掉控制字符（含 \r），保留 \n \t，避免脏字节进入 JSON */
function stripControl(text) {
  let out = '';
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    if (code === 9 || code === 10) {
      out += ch;
    } else if (code < 32 || code === 127) {
      continue;
    } else {
      out += ch;
    }
  }
  return out;
}

/** UTF-8 文本 → base64（不用 escape/unescape，Node 与 Workers 都能跑） */
function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function encodeBase64Utf8(text) {
  return bytesToBase64(new TextEncoder().encode(text));
}

/** base64 → UTF-8 文本；GitHub 返回的内容里会带换行，先去掉 */
function decodeBase64Utf8(base64) {
  const clean = String(base64 || '').replace(/[\r\n\s]/g, '');
  if (!clean) return '';
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** 统计正文里 http 出现次数（粗略判断刷链接） */
function countLinks(body) {
  const matches = String(body).match(/http/gi);
  return matches ? matches.length : 0;
}

/** 把 nickname/name 变成可以进分支名的安全片段 */
function safeBranchPart(slug) {
  return slug
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'comment';
}

function shortUa(ua) {
  const clean = stripControl(ua || '').replace(/\s+/g, ' ').trim();
  return clean.slice(0, 120);
}

/* ------------------------------------------------------------------ */
/* 校验                                                                */
/* ------------------------------------------------------------------ */

/**
 * slug 必须是安全的相对路径：
 * 只允许 [A-Za-z0-9._/-]，不能以 / 开头，不能含 ..，长度 <= 200
 */
function validateSlug(slug) {
  if (typeof slug !== 'string') return '文章标识（slug）不合法';
  const s = slug.trim();
  if (!s) return '缺少文章标识（slug）';
  if (s.length > MAX_SLUG_LEN) return '文章标识（slug）过长';
  if (s.startsWith('/')) return '文章标识（slug）不能以斜杠开头';
  if (s.includes('..')) return '文章标识（slug）不能包含 ..';
  if (!/^[A-Za-z0-9._/-]+$/.test(s)) return '文章标识（slug）含有不允许的字符';
  return '';
}

/** 网址字段只收 http(s)://，其它一律当空丢掉（不报错） */
function normalizeWebsite(value) {
  if (value === undefined || value === null) return '';
  const s = stripControl(value).trim().slice(0, MAX_OPTIONAL_LEN);
  if (!/^https?:\/\//i.test(s)) return '';
  return s;
}

/* ------------------------------------------------------------------ */
/* 响应                                                                */
/* ------------------------------------------------------------------ */

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    vary: 'Origin',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'POST, OPTIONS',
  };
  if (origin) headers['access-control-allow-origin'] = origin;
  return headers;
}

function jsonResponse(request, env, status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: corsHeaders(request, env),
  });
}

function ok(request, env, payload) {
  return jsonResponse(request, env, 200, { ok: true, ...payload });
}

function fail(request, env, status, error) {
  return jsonResponse(request, env, status, { ok: false, error });
}

/* ------------------------------------------------------------------ */
/* GitHub API                                                          */
/* ------------------------------------------------------------------ */

/**
 * COMMENT_PENDING 是否开启（只对 COMMENT_MODE=direct 有意义）。
 *   - 未设置 / 空字符串 / 其他任何拼错的值 → true（默认：新评论先隐藏，等站长放行）
 *   - 'true'（大小写不敏感）→ true
 *   - 'false'（大小写不敏感）→ false
 * 也就是说：只有明确写成 false / FALSE / False 才会「提交即公开」。
 */
function pendingEnabled(env) {
  const raw = env.COMMENT_PENDING;
  if (raw === undefined || raw === null) return true;
  return String(raw).trim().toLowerCase() !== 'false';
}

function repoConfig(env) {
  return {
    repo: env.GITHUB_REPO || DEFAULT_REPO,
    branch: env.GITHUB_BRANCH || DEFAULT_BRANCH,
    mode: (env.COMMENT_MODE || 'pr').toLowerCase() === 'direct' ? 'direct' : 'pr',
    // pr 模式与 pending 无关（PR 本身待审），这里只记录 direct 模式要用的开关
    pending: pendingEnabled(env),
  };
}

function ghHeaders(env) {
  return {
    authorization: 'Bearer ' + env.GITHUB_TOKEN,
    accept: 'application/vnd.github+json',
    'content-type': 'application/json',
    'user-agent': 'wusitech-git-comments',
    'x-github-api-version': '2022-11-28',
  };
}

/** 抛出带中文说明的 GitHub 错误（信息里带上 GitHub 自己的 message） */
class GitHubError extends Error {
  constructor(step, status, message) {
    super(`GitHub ${step} 失败（HTTP ${status}）：${message}`);
    this.step = step;
    this.status = status;
  }
}

async function ghJson(deps, env, url, init, step) {
  const res = await deps.fetch(url, init);
  // 204 之类没有 body，json 解析会抛错，这里吞掉按空对象处理
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new GitHubError(step, res.status, data.message || res.statusText || '未知错误');
  }
  return data;
}

/** GET /repos/{repo}/contents/{path}?ref=...；不存在返回 null */
async function readCommentFile(deps, env, path, ref) {
  const { repo } = repoConfig(env);
  const url = `${API}/repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`;
  const res = await deps.fetch(url, { method: 'GET', headers: ghHeaders(env) });
  if (res.status === 404) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new GitHubError('读取现有评论文件', res.status, data.message || res.statusText || '未知错误');
  }
  return data;
}

/**
 * 把评论追加进文件并 PUT 上去。
 * PUT 返回 409/422（并发提交撞车）时重新 GET 再合并重试，最多 PUT_RETRY_MAX 次。
 */
/** static/comments/posts/xxx.json → posts/xxx */
function slugFromPath(path) {
  return path.replace(/^static\/comments\//, '').replace(/\.json$/, '');
}

async function appendCommentToFile(deps, env, path, comment, name, writeRef) {
  const { repo, branch } = repoConfig(env);
  const ref = writeRef || branch;

  for (let attempt = 0; attempt < PUT_RETRY_MAX; attempt++) {
    const existing = await readCommentFile(deps, env, path, ref);

    let sha = '';
    let doc = { slug: slugFromPath(path), comments: [] };
    if (existing) {
      sha = existing.sha;
      try {
        const decoded = decodeBase64Utf8(existing.content);
        const parsed = JSON.parse(decoded);
        if (parsed && typeof parsed === 'object' && Array.isArray(parsed.comments)) {
          doc = parsed;
        }
      } catch {
        // 文件坏了（手改坏 / 半截写入）：不覆盖，直接报错让人去修
        throw new GitHubError('解析现有评论文件', 500, `文件 ${path} 不是合法 JSON，请先手工修复`);
      }
    }
    if (!Array.isArray(doc.comments)) doc.comments = [];
    doc.slug = doc.slug || slugFromPath(path);
    doc.comments.push(comment);

    const payload = {
      message: `评论: ${doc.slug} 来自 ${name}`,
      content: encodeBase64Utf8(JSON.stringify(doc, null, 2) + '\n'),
      branch: ref,
    };
    if (sha) payload.sha = sha;

    const res = await deps.fetch(`${API}/repos/${repo}/contents/${path}`, {
      method: 'PUT',
      headers: ghHeaders(env),
      body: JSON.stringify(payload),
    });

    if (res.ok) {
      return await res.json().catch(() => ({}));
    }
    if (res.status === 409 || res.status === 422) {
      // 撞车了：下一轮重新读一遍，把评论合到最新内容上
      continue;
    }
    const data = await res.json().catch(() => ({}));
    throw new GitHubError('写入评论文件', res.status, data.message || res.statusText || '未知错误');
  }

  throw new GitHubError('写入评论文件', 409, '并发冲突，重试后仍未成功，请稍后再提交一次');
}

/** 开一个评论分支，返回分支名；分支已存在也当作成功 */
async function createCommentBranch(deps, env, ref, slug) {
  const { repo, branch } = repoConfig(env);
  const refRes = await deps.fetch(`${API}/repos/${repo}/git/ref/heads/${branch}`, {
    method: 'GET',
    headers: ghHeaders(env),
  });
  const refData = await refRes.json().catch(() => ({}));
  if (!refRes.ok) {
    throw new GitHubError('读取基准分支', refRes.status, refData.message || refRes.statusText || '未知错误');
  }
  const baseSha = (refData.object || {}).sha;
  if (!baseSha) throw new GitHubError('读取基准分支', 500, '没有拿到基准分支的 commit sha');

  const branchName = `comment/${safeBranchPart(slug)}-${ref.timestamp}`;
  const createRes = await deps.fetch(`${API}/repos/${repo}/git/refs`, {
    method: 'POST',
    headers: ghHeaders(env),
    body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: baseSha }),
  });
  if (!createRes.ok) {
    const data = await createRes.json().catch(() => ({}));
    // 422 = Reference already exists：忽略，继续用这个分支
    if (createRes.status !== 422) {
      throw new GitHubError('创建评论分支', createRes.status, data.message || createRes.statusText || '未知错误');
    }
  }
  return branchName;
}

async function openPullRequest(deps, env, branchName, form, ref) {
  const { repo, branch } = repoConfig(env);
  const bodyLines = [
    '来自站点评论框的提交。',
    '',
    '----',
    '',
    form.body,
  ];
  if (form.email) bodyLines.push('', `邮箱：${form.email}`);
  if (form.website) bodyLines.push(`网址：${form.website}`);
  if (form.ua) bodyLines.push(`UA：${form.ua}`);
  bodyLines.push('', `时间：${ref.iso}`, `页面：/${form.slug}/`);

  const data = await ghJson(
    deps,
    env,
    `${API}/repos/${repo}/pulls`,
    {
      method: 'POST',
      headers: ghHeaders(env),
      body: JSON.stringify({
        title: `💬 新评论：${form.name} 于 ${form.slug}`,
        head: branchName,
        base: branch,
        body: bodyLines.join('\n'),
      }),
    },
    '创建 Pull Request',
  );
  return data;
}

/* ------------------------------------------------------------------ */
/* 核心                                                                */
/* ------------------------------------------------------------------ */

/**
 * @param {Request} request
 * @param {object} env
 * @param {{fetch?:Function, now?:Function, random?:Function}} [deps]
 * @returns {Promise<Response>}
 */
export async function handleComment(request, env, deps) {
  const d = {
    fetch: (deps && deps.fetch) || globalThis.fetch,
    now: (deps && deps.now) || Date.now,
    random: (deps && deps.random) || Math.random,
  };
  const cfg = repoConfig(env);

  // 1) 方法
  if (request.method !== 'POST') {
    return fail(request, env, 405, '只接受 POST 请求');
  }

  // 2) 来源白名单（没有 Origin 头的请求，比如命令行 curl，放行；浏览器跨域一定带 Origin）
  const origin = request.headers.get('Origin') || '';
  const allowed = splitEnv(env.ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS);
  if (origin && !allowed.includes(origin)) {
    return fail(request, env, 403, '来源不在白名单内，拒绝提交');
  }

  // 3) 解析请求体
  let raw;
  try {
    raw = await request.json();
  } catch {
    return fail(request, env, 400, '请求体不是合法的 JSON');
  }
  if (!raw || typeof raw !== 'object') {
    return fail(request, env, 400, '请求体格式不对');
  }

  // 4) 蜜罐：隐藏字段被填了说明是机器人。
  //    直接当成功返回，但什么都不写（也不做任何 GitHub 请求），让脚本以为提交成功了。
  //    这里的响应形状与真提交成功时保持一致（含 direct 模式的 pending 字段）。
  if (typeof raw.hp === 'string' && raw.hp.trim() !== '') {
    return ok(request, env, {
      mode: cfg.mode,
      ...(cfg.mode === 'direct' ? { pending: cfg.pending } : {}),
      message: '评论已提交',
    });
  }

  // 5) 字段校验
  const slug = typeof raw.slug === 'string' ? raw.slug.trim() : '';
  const slugError = validateSlug(slug);
  if (slugError) return fail(request, env, 400, slugError);

  const name = stripControl(typeof raw.name === 'string' ? raw.name : '').trim();
  if (!name) return fail(request, env, 400, '昵称不能为空');
  if (name.length > MAX_NAME_LEN) return fail(request, env, 400, `昵称太长（最多 ${MAX_NAME_LEN} 字）`);

  const body = stripControl(typeof raw.body === 'string' ? raw.body : '').trim();
  if (!body) return fail(request, env, 400, '评论内容不能为空');
  if (body.length > MAX_BODY_LEN) return fail(request, env, 400, `评论内容太长（最多 ${MAX_BODY_LEN} 字）`);

  const email = stripControl(typeof raw.email === 'string' ? raw.email : '').trim().slice(0, MAX_OPTIONAL_LEN);
  const website = normalizeWebsite(raw.website);
  const replyTo = typeof raw.replyTo === 'string' ? stripControl(raw.replyTo).trim().slice(0, 64) : '';
  const ua = shortUa(request.headers.get('user-agent') || '');

  // 6) 正文里的链接数量（粗略防广告）
  if (countLinks(body) > MAX_LINKS) {
    return fail(request, env, 400, `评论里的链接太多了（最多 ${MAX_LINKS} 个）`);
  }

  // 7) 内存限流：同一 IP 60 秒内最多 RATE_MAX 条
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const now = d.now();
  const stamps = (rateBuckets.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (stamps.length >= RATE_MAX) {
    return fail(request, env, 429, '提交太频繁了，请等一分钟再试');
  }
  stamps.push(now);
  rateBuckets.set(ip, stamps);

  // 8) 组装评论
  const tsMs = now;
  const suffix = Math.floor(d.random() * 0xffffff)
    .toString(16)
    .padStart(6, '0');
  const ref = {
    timestamp: tsMs,
    iso: new Date(tsMs).toISOString(),
  };
  // 字段必须与 static/admin/config.yml 里 comments 集合声明的完全一致：
  // 严格包含且只包含这 9 个键，顺序也保持一致（多一个或少一个，后台保存该文件时
  // 都会把多出来的字段丢掉，所以这里不能省字段、也不能顺手加字段）。
  //   - hidden：true 时前端不渲染这一条
  //   - author：true 时前端在昵称旁边显示「博主」标记
  // 新评论的 hidden 由模式决定（author 一律 false，这两个开关之后都由后台人工调整）：
  //   - direct + pending（默认）：hidden=true。评论【仍然照常写进 JSON】，数据一点不丢，
  //     只是前端 comments.js 会把 hidden===true 的条目过滤掉（不渲染）。
  //     站长在后台 /admin/ → 评论 里把「隐藏」关掉并保存后，等一次构建部署
  //     （约 1 分钟）这条评论才会出现在页面上。
  //   - direct + 不 pending：hidden=false，等一次构建（约 1 分钟）直接显示。
  //   - pr：hidden=false。评论停在分支上等人合并，PR 本身就是待审状态，
  //     所以 COMMENT_PENDING 对 pr 模式没有任何影响。
  const hidden = cfg.mode === 'direct' && cfg.pending;
  const comment = {
    id: `c_${tsMs}_${suffix}`,
    name,
    email,
    website,
    body,
    ts: ref.iso,
    ua,
    hidden,
    author: false,
    replyTo,
  };

  const path = `static/comments/${slug}.json`;
  const form = { slug, name, email, website, body, ua };

  try {
    if (cfg.mode === 'direct') {
      // 直接写主分支：等一次构建部署就能看到
      await appendCommentToFile(d, env, path, comment, name, cfg.branch);
      return ok(request, env, {
        mode: 'direct',
        pending: cfg.pending,
        message: cfg.pending
          ? '评论已提交，待站长审核后显示'
          : '评论已提交，约 1 分钟后显示',
      });
    }

    // PR 模式：新建分支 → 在分支上写文件 → 开 PR
    // 这里刻意不看 COMMENT_PENDING：评论根本还没进 main，合并与否由站长在 GitHub 上决定。
    const branchName = await createCommentBranch(d, env, ref, slug);
    await appendCommentToFile(d, env, path, comment, name, branchName);
    const pr = await openPullRequest(d, env, branchName, form, ref);
    return ok(request, env, {
      mode: 'pr',
      pr: pr.html_url || '',
      message: '评论已提交，审核合并后显示',
    });
  } catch (err) {
    const detail = err && err.message ? err.message : String(err);
    return fail(request, env, 502, `提交到 GitHub 失败：${detail}`);
  }
}

/* ------------------------------------------------------------------ */
/* Pages Functions 入口（薄封装）                                       */
/* ------------------------------------------------------------------ */

export async function onRequestPost(context) {
  const { request, env } = context;
  return handleComment(request, env, {
    fetch: (...args) => fetch(...args),
    now: () => Date.now(),
    random: () => Math.random(),
  });
}

export async function onRequestOptions(context) {
  const { request, env } = context;
  const origin = request.headers.get('Origin') || '';
  const allowed = splitEnv(env.ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS);
  if (origin && !allowed.includes(origin)) {
    return fail(request, env, 403, '来源不在白名单内，拒绝提交');
  }
  return new Response(null, { status: 204, headers: corsHeaders(request, env) });
}

// 兜底：GET/PUT/DELETE 等一律 405（行为保持不变）。
//
// 事实说明（别被「Pages 会优先调 onRequest，所以必须在这里分发给 POST」误导）：
// Cloudflare Pages 是按请求方法分发的 —— POST 直接命中上面的 onRequestPost，
// 不会先进 onRequest；没有对应方法处理器的请求，Pages 自己也会回 405。
// 之前实测到的 POST 405，真实原因是那一次部署还没跑完，不是路由问题：
// 部署完成后 POST 一直由 onRequestPost 正常处理。
// 这里显式写 onRequest 只是为了把非 POST/OPTIONS 的响应统一成中文 JSON，
// 顺带把 OPTIONS 转给 onRequestOptions；删掉它 Pages 依旧 405，只是错误信息变英文。
export async function onRequest(context) {
  const { request } = context;
  if (request.method === 'OPTIONS') return onRequestOptions(context);
  return fail(request, context.env, 405, '只接受 POST 请求');
}

// 前端用它决定表单下方的提示文案（是否走审核）。GET ?config=1 返回当前模式。
// Cloudflare Pages 按请求方法分发：GET 命中这个 onRequestGet，不影响 POST 那条路径。
export async function onRequestGet(context) {
  const { request, env } = context;
  const cfgUrl = new URL(request.url);
  if (cfgUrl.searchParams.get('config') === '1') {
    const mode = String(env.COMMENT_MODE || 'direct').toLowerCase() === 'pr' ? 'pr' : 'direct';
    return jsonResponse(request, env, 200, { ok: true, mode, pending: pendingEnabled(env) });
  }
  return jsonResponse(request, env, 400, { ok: false, error: '不支持的请求' });
}