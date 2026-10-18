/**
 * Cloudflare Pages Function：评论管理 API
 * ----------------------------------------------------------------------------
 * 路由：/api/admin （GET 体检 / POST 各种操作，全部要求管理密码）
 *
 * 为什么要有它：
 *   static/js/comments.js 只管「访客读取 + 提交」。站长每天要做的事是
 *   「看新评论 → 放行 / 隐藏 / 删除 → 以博主身份回复」，而评论在 JSON 里是个数组，
 *   用 Sveltia CMS 的通用列表去点这些布尔值很别扭（要逐条展开、还得等构建）。
 *   这个 Function 把这几件事包成几个动作，配套的轻量管理页是
 *   /comments/admin.html（源文件 static/comments/admin.html），一屏搞定。
 *
 * 数据依旧留在 Git：和 comment.js 走同一条路（GitHub Contents API），
 * 审核/回复/删除都是一次 commit，之后等一次构建部署即可在页面上看到。
 *
 * 鉴权（务必先做）：
 *   Cloudflare Pages 项目 → Settings → Environment variables → 加一个 Secret：
 *     ADMIN_TOKEN  管理密码，建议 32 位以上随机串（不要和 GITHUB_TOKEN 混用）
 *   可选：
 *     ADMIN_NAME   博主回复时显示的昵称，默认「博主」
 *     ADMIN_ALLOWED_ORIGINS  允许调用管理接口的来源，默认复用 ALLOWED_ORIGINS
 *   加完变量必须**重新部署**才生效（wstk 项目不跟随 push 自动构建，
 *   只在 .github/workflows/hugo.yaml 的定时任务里触发）。
 *
 * 安全要点：
 *   - 没设置 ADMIN_TOKEN 时整个接口 503（不会误开放）
 *   - 密码只从请求头 x-admin-token 读，常量时间比较；不写仓库、不进 URL、不回显
 *   - 同一 IP 10 分钟内错 12 次直接 429（内存计数，实例重启即清零，够挡暴力猜）
 *   - 只能读写 static/comments/**.json，路径/ID 都按白名单校验
 *
 * 动作一览（POST JSON，除 action 外字段见下）：
 *   { action: 'health' }                            令牌 / 仓库 / 模式体检
 *   { action: 'list' }                              列出所有评论文件（含隐藏的）
 *   { action: 'setHidden', path, id, hidden }       放行（hidden=false）/ 隐藏（true）
 *   { action: 'delete', path, id, withReplies? }    删除；withReplies 默认 true（连回复一起删），
 *                                                   传 false 时把它的回复挂到它的父评论上
 *   { action: 'reply', path, id, body }             以博主身份回复某条（author=true）
 * GET /api/admin?action=health  等价于 health（方便 curl 检查）
 *
 * 测试：node tools/git-comments/test-admin.mjs（用假的 fetch 跑完整链路，不需要网络）
 */

import {
  API,
  DEFAULT_ALLOWED_ORIGINS,
  decodeBase64Utf8,
  encodeBase64Utf8,
  ghHeaders,
  repoConfig,
  splitEnv,
} from './comment.js';

const COMMENTS_DIR = 'static/comments/';
const MAX_FILE_COUNT = 200;
const MAX_BODY_LEN = 2000;
const MAX_NAME_LEN = 40;
const MAX_ID_LEN = 64;
const WRITE_RETRY_MAX = 3;
const AUTH_FAIL_WINDOW_MS = 10 * 60 * 1000;
const AUTH_FAIL_MAX = 12;
const DEFAULT_ADMIN_NAME = '博主';

/** 同一 IP 的管理密码错误时间戳（模块级内存，实例重启清零；只防暴力猜，不做严格限流） */
const authFailBuckets = new Map();

/** 仅供测试清空认证失败计数，生产代码不会调用 */
export function __resetAdminAuthBuckets() {
  authFailBuckets.clear();
}

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

/** 带 HTTP 状态码的业务错误（会被 handleAdmin 转成 JSON 响应） */
class AdminError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** 常量时间字符串比较（长度不同直接 false，长度本身不算秘密） */
function tokensMatch(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  if (!x || !y || x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

function clientIp(request) {
  return request.headers.get('cf-connecting-ip') || 'unknown';
}

function pruneFails(ip, now) {
  const list = (authFailBuckets.get(ip) || []).filter((t) => now - t < AUTH_FAIL_WINDOW_MS);
  if (list.length) authFailBuckets.set(ip, list);
  else authFailBuckets.delete(ip);
  return list;
}

function authBlocked(ip, now) {
  return pruneFails(ip, now).length >= AUTH_FAIL_MAX;
}

function noteAuthFail(ip, now) {
  const list = pruneFails(ip, now);
  list.push(now);
  authFailBuckets.set(ip, list);
}

/** 简单的并发限制（避免一次列出几十个评论文件时把 GitHub 配额打满） */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const size = Math.min(Math.max(1, limit), items.length);
  const workers = [];
  for (let w = 0; w < size; w++) {
    workers.push(
      (async () => {
        while (next < items.length) {
          const i = next++;
          out[i] = await fn(items[i], i);
        }
      })(),
    );
  }
  await Promise.all(workers);
  return out;
}

/* ------------------------------------------------------------------ */
/* 响应 / CORS                                                         */
/* ------------------------------------------------------------------ */

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = splitEnv(env.ADMIN_ALLOWED_ORIGINS || env.ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS);
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    vary: 'Origin',
    'access-control-allow-headers': 'content-type, x-admin-token',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
  };
  if (origin && allowed.includes(origin)) headers['access-control-allow-origin'] = origin;
  return headers;
}

function adminJson(request, env, status, payload) {
  return new Response(JSON.stringify(payload), { status, headers: corsHeaders(request, env) });
}

function adminOk(request, env, payload) {
  return adminJson(request, env, 200, { ok: true, ...payload });
}

function adminFail(request, env, status, code, error) {
  return adminJson(request, env, status, { ok: false, code, error });
}

/* ------------------------------------------------------------------ */
/* 鉴权 / 来源检查                                                     */
/* ------------------------------------------------------------------ */

/** 来源白名单：浏览器跨域会带 Origin；命令行 curl 没有 Origin，直接放行（靠密码保护） */
function checkOrigin(request, env) {
  const origin = request.headers.get('Origin') || '';
  if (!origin) return null;
  const allowed = splitEnv(env.ADMIN_ALLOWED_ORIGINS || env.ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS);
  if (allowed.includes(origin)) return null;
  return adminFail(
    request,
    env,
    403,
    'ORIGIN_NOT_ALLOWED',
    `来源 ${origin} 不在白名单内：请在 Cloudflare 变量里把它加进 ADMIN_ALLOWED_ORIGINS 或 ALLOWED_ORIGINS`,
  );
}

/**
 * 管理密码校验。通过返回 null，否则返回一个错误响应。
 * ADMIN_TOKEN 没设置时直接 503：宁可功能不可用，也不能变成「无密码的管理接口」。
 */
function checkAuth(request, env, now) {
  const expected = String(env.ADMIN_TOKEN || '').trim();
  if (!expected) {
    return adminFail(
      request,
      env,
      503,
      'ADMIN_DISABLED',
      '管理接口未启用：请先在 Cloudflare Pages 环境变量里设置 ADMIN_TOKEN（Secret），然后重新部署。',
    );
  }

  const ip = clientIp(request);
  if (authBlocked(ip, now)) {
    return adminFail(request, env, 429, 'TOO_MANY_ATTEMPTS', '管理密码错误次数太多，请 10 分钟后再试。');
  }

  const given = String(request.headers.get('x-admin-token') || '').trim();
  if (!tokensMatch(given, expected)) {
    noteAuthFail(ip, now);
    return adminFail(request, env, 401, 'BAD_ADMIN_TOKEN', '管理密码不正确（页面里的密码要与环境变量 ADMIN_TOKEN 完全一致）。');
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* GitHub API                                                          */
/* ------------------------------------------------------------------ */

/** 发一个 GitHub 请求，同时把响应头里的「令牌有效期 / 配额」记到 meta 里（用于体检） */
async function ghRequest(deps, env, path, init, meta) {
  const res = await deps.fetch(API + path, init);
  const text = await res.text().catch(() => '');
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (meta) {
    const expiry = res.headers.get('github-authentication-token-expiration');
    if (expiry) meta.tokenExpiration = expiry;
    const limit = res.headers.get('x-ratelimit-limit');
    if (limit !== null && limit !== undefined) meta.rateLimit = Number(limit) || limit;
    const remaining = res.headers.get('x-ratelimit-remaining');
    if (remaining !== null && remaining !== undefined) meta.rateRemaining = Number(remaining);
    const reset = res.headers.get('x-ratelimit-reset');
    if (reset !== null && reset !== undefined) meta.rateReset = Number(reset);
  }
  return { res, data: data || {} };
}

/** 把 GitHub 的错误翻译成站长看得懂的话（401 基本就是令牌过期） */
function githubErrorFor(res, data, step) {
  const message = (data && data.message) || res.statusText || '未知错误';
  if (res.status === 401) {
    return new AdminError(
      502,
      'GITHUB_TOKEN_INVALID',
      `GitHub 令牌无效或已过期（HTTP 401 Bad credentials）：请更新 Cloudflare 的 GITHUB_TOKEN 并重新部署。原始信息：${message}`,
    );
  }
  if (res.status === 403) {
    return new AdminError(
      502,
      'GITHUB_FORBIDDEN',
      `GitHub 拒绝了这个操作（HTTP 403）：多半是令牌权限不足（需要 Contents 读写）或 API 配额用完。原始信息：${message}`,
    );
  }
  if (res.status === 404) {
    return new AdminError(
      502,
      'GITHUB_NOT_FOUND',
      `GitHub 找不到目标（HTTP 404）：检查 GITHUB_REPO / GITHUB_BRANCH / 文件路径。原始信息：${message}`,
    );
  }
  return new AdminError(502, 'GITHUB_ERROR', `GitHub ${step} 失败（HTTP ${res.status}）：${message}`);
}

function baseMeta(env, nowMs) {
  const cfg = repoConfig(env);
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  return {
    repo: cfg.repo,
    branch: cfg.branch,
    mode: cfg.mode,
    pending: cfg.pending,
    adminName: String(env.ADMIN_NAME || DEFAULT_ADMIN_NAME).trim() || DEFAULT_ADMIN_NAME,
    tokenExpiration: null,
    tokenExpirationIso: null,
    tokenDaysLeft: null,
    rateLimit: null,
    rateRemaining: null,
    rateReset: null,
    checkedAt: new Date(now).toISOString(),
    nowMs: now,
  };
}

/**
 * GitHub 细粒度令牌的响应头形如 `2026-10-16 12:34:56 UTC`，换算成天数放进 meta，
 * 管理页据此提示「令牌快过期了，该轮换了」。
 */
function withTokenDaysLeft(meta) {
  const nowMs = Number.isFinite(meta.nowMs) ? meta.nowMs : Date.now();
  delete meta.nowMs;
  if (!meta.tokenExpiration) return meta;
  const raw = String(meta.tokenExpiration).trim();
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC$/.test(raw)
    ? raw.replace(' ', 'T').replace(' UTC', 'Z')
    : raw;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return meta;
  meta.tokenExpirationIso = new Date(ms).toISOString();
  meta.tokenDaysLeft = Math.floor((ms - nowMs) / 86400000);
  return meta;
}

/* ------------------------------------------------------------------ */
/* 校验                                                                */
/* ------------------------------------------------------------------ */

function slugFromPath(path) {
  return path.slice(COMMENTS_DIR.length).replace(/\.json$/, '');
}

/** 只允许 static/comments/**.json，且不含 .. 之类危险片段 */
function checkFilePath(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AdminError(400, 'BAD_PATH', '缺少评论文件路径（path）');
  }
  const path = value.trim().replace(/^\/+/, '');
  if (!path.startsWith(COMMENTS_DIR)) throw new AdminError(400, 'BAD_PATH', '评论文件必须位于 static/comments/ 下');
  if (!path.endsWith('.json')) throw new AdminError(400, 'BAD_PATH', '评论文件必须以 .json 结尾');
  if (path.includes('..') || !/^[A-Za-z0-9._/-]+$/.test(path)) {
    throw new AdminError(400, 'BAD_PATH', '评论文件路径含有不允许的字符');
  }
  return path;
}

function checkId(value) {
  if (typeof value !== 'string') throw new AdminError(400, 'BAD_ID', '缺少要操作的评论 id');
  const id = value.trim();
  if (!id || id.length > MAX_ID_LEN || !/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new AdminError(400, 'BAD_ID', '评论 id 不合法');
  }
  return id;
}

/** 后台写评论正文：去掉控制字符、保留换行，长度按前端同一套规则 */
function cleanBody(value) {
  if (typeof value !== 'string') return '';
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0);
    if (code === 9 || code === 10 || (code >= 32 && code !== 127)) out += ch;
  }
  return out.trim().slice(0, MAX_BODY_LEN);
}

/** 旧评论可能没有 replyTo / author，写回前补齐成和 Function 一致的字段集合 */
function normalizeComment(c) {
  if (!c || typeof c !== 'object') return c;
  if (typeof c.replyTo !== 'string') c.replyTo = '';
  if (typeof c.hidden !== 'boolean') c.hidden = false;
  if (typeof c.author !== 'boolean') c.author = false;
  return c;
}

/* ------------------------------------------------------------------ */
/* 读写评论文件                                                        */
/* ------------------------------------------------------------------ */

function parseDoc(path, base64) {
  let doc;
  try {
    doc = JSON.parse(decodeBase64Utf8(base64));
  } catch {
    throw new AdminError(500, 'BAD_JSON', `文件 ${path} 不是合法 JSON，请先在 GitHub 上手工修好再操作。`);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new AdminError(500, 'BAD_JSON', `文件 ${path} 结构不对（应为 { "slug": ..., "comments": [...] }）。`);
  }
  if (!Array.isArray(doc.comments)) doc.comments = [];
  if (!doc.slug) doc.slug = slugFromPath(path);
  return doc;
}

async function readDoc(deps, env, path, meta) {
  const { repo, branch } = repoConfig(env);
  const { res, data } = await ghRequest(
    deps,
    env,
    `/repos/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`,
    { method: 'GET', headers: ghHeaders(env) },
    meta,
  );
  if (res.status === 404) return null;
  if (!res.ok) throw githubErrorFor(res, data, '读取评论文件');
  return { sha: data.sha || '', doc: parseDoc(path, data.content) };
}

async function putDoc(deps, env, path, doc, sha, message, meta) {
  const { repo, branch } = repoConfig(env);
  const payload = {
    message,
    content: encodeBase64Utf8(JSON.stringify(doc, null, 2) + '\n'),
    branch,
  };
  if (sha) payload.sha = sha;
  const { res, data } = await ghRequest(
    deps,
    env,
    `/repos/${repo}/contents/${path}`,
    { method: 'PUT', headers: ghHeaders(env), body: JSON.stringify(payload) },
    meta,
  );
  if (res.ok) return data;
  if (res.status === 409 || res.status === 422) {
    const err = new AdminError(409, 'WRITE_CONFLICT', '并发冲突');
    err.retryable = true;
    throw err;
  }
  throw githubErrorFor(res, data, '写入评论文件');
}

/**
 * 「读 → 改 → 写」的通用封装。
 * 写冲突（409/422，比如刚好有人在发评论）时重新读最新文件、把 mutate 再跑一遍，
 * 最多 WRITE_RETRY_MAX 次；mutate 必须只依赖传入的 doc，不能有额外副作用。
 */
async function mutateDoc(deps, env, path, meta, mutate, message) {
  for (let attempt = 0; attempt < WRITE_RETRY_MAX; attempt++) {
    const current = await readDoc(deps, env, path, meta);
    if (!current) throw new AdminError(404, 'FILE_NOT_FOUND', `评论文件 ${path} 不存在（可能已经被删了）。`);
    const result = mutate(current.doc);
    try {
      const written = await putDoc(deps, env, path, current.doc, current.sha, message, meta);
      return {
        doc: current.doc,
        sha: (written && written.content && written.content.sha) || '',
        result,
      };
    } catch (err) {
      if (err && err.retryable && attempt < WRITE_RETRY_MAX - 1) continue;
      throw err;
    }
  }
  throw new AdminError(409, 'WRITE_CONFLICT', '并发冲突：重试多次仍被拒绝，请稍后再试一次。');
}

/* ------------------------------------------------------------------ */
/* 动作实现                                                            */
/* ------------------------------------------------------------------ */

/** 体检：读一次评论目录，顺带拿到令牌有效期 / 配额（这是 A 方案「令牌轮换」的哨兵） */
async function healthInfo(deps, env, meta) {
  const { repo, branch } = repoConfig(env);
  const { res, data } = await ghRequest(
    deps,
    env,
    `/repos/${repo}/contents/static/comments?ref=${encodeURIComponent(branch)}`,
    { method: 'GET', headers: ghHeaders(env) },
    meta,
  );
  if (!res.ok) throw githubErrorFor(res, data, '体检');
  if (Array.isArray(data)) {
    meta.commentFileCount = data.filter((x) => x && typeof x.name === 'string' && x.name.endsWith('.json')).length;
    meta.hasPostsDir = data.some((x) => x && x.name === 'posts' && x.type === 'dir');
  }
  return meta;
}

/** 列出所有评论文件（含内容），按 slug 排序 */
async function listFiles(deps, env, meta) {
  const { repo, branch } = repoConfig(env);
  const { res, data } = await ghRequest(
    deps,
    env,
    `/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    { method: 'GET', headers: ghHeaders(env) },
    meta,
  );
  if (!res.ok) throw githubErrorFor(res, data, '列出仓库文件');

  const paths = (Array.isArray(data.tree) ? data.tree : [])
    .filter(
      (entry) =>
        entry &&
        entry.type === 'blob' &&
        typeof entry.path === 'string' &&
        entry.path.startsWith(COMMENTS_DIR) &&
        entry.path.endsWith('.json'),
    )
    .map((entry) => entry.path)
    .sort()
    .slice(0, MAX_FILE_COUNT);

  const files = await mapLimit(paths, 6, async (path) => {
    try {
      const current = await readDoc(deps, env, path, meta);
      if (!current) return null;
      return { path, slug: slugFromPath(path), sha: current.sha, comments: current.doc.comments };
    } catch (err) {
      // 单个文件坏了不要让整个管理页打不开：把错误挂在文件上，页面单独提示
      return { path, slug: slugFromPath(path), sha: '', comments: [], error: err && err.message };
    }
  });
  return files.filter(Boolean);
}

/* ------------------------------------------------------------------ */
/* 请求入口                                                            */
/* ------------------------------------------------------------------ */

/**
 * @param {Request} request
 * @param {object} env
 * @param {{fetch?:Function, now?:Function, random?:Function}} [deps]
 * @returns {Promise<Response>}
 */
export async function handleAdmin(request, env, deps) {
  const d = {
    fetch: (deps && deps.fetch) || globalThis.fetch,
    now: (deps && deps.now) || Date.now,
    random: (deps && deps.random) || Math.random,
  };

  const originError = checkOrigin(request, env);
  if (originError) return originError;

  const authError = checkAuth(request, env, d.now());
  if (authError) return authError;

  // 1) 取 action 与参数
  let action = '';
  let payload = {};
  if (request.method === 'GET') {
    let url;
    try {
      url = new URL(request.url);
    } catch {
      return adminFail(request, env, 400, 'BAD_URL', '请求地址不合法');
    }
    action = (url.searchParams.get('action') || 'health').trim();
  } else if (request.method === 'POST') {
    try {
      payload = await request.json();
    } catch {
      return adminFail(request, env, 400, 'BAD_JSON', '请求体不是合法 JSON');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return adminFail(request, env, 400, 'BAD_JSON', '请求体格式不对');
    }
    if (typeof payload.action === 'string') action = payload.action.trim();
  } else {
    return adminFail(request, env, 405, 'METHOD_NOT_ALLOWED', '管理接口只接受 GET / POST');
  }

  if (!action) {
    return adminFail(request, env, 400, 'MISSING_ACTION', '缺少 action（health / list / setHidden / delete / reply）');
  }

  const meta = baseMeta(env, d.now());

  try {
    // 2) 体检
    if (action === 'health') {
      const info = await healthInfo(d, env, meta);
      return adminOk(request, env, { meta: withTokenDaysLeft(info) });
    }

    // 3) 列表
    if (action === 'list') {
      const files = await listFiles(d, env, meta);
      return adminOk(request, env, { meta: withTokenDaysLeft(meta), files });
    }

    // 4) 放行 / 隐藏
    if (action === 'setHidden') {
      const path = checkFilePath(payload.path);
      const id = checkId(payload.id);
      if (typeof payload.hidden !== 'boolean') {
        throw new AdminError(400, 'BAD_HIDDEN', 'hidden 必须是 true 或 false');
      }
      const slug = slugFromPath(path);
      const { doc, sha } = await mutateDoc(
        d,
        env,
        path,
        meta,
        (current) => {
          const target = current.comments.find((c) => c && c.id === id);
          if (!target) throw new AdminError(404, 'COMMENT_NOT_FOUND', '这条评论已经不存在了（可能刚被其他操作删掉）。');
          normalizeComment(target);
          target.hidden = payload.hidden;
          return target;
        },
        `评论${payload.hidden ? '隐藏' : '通过'}: ${slug}`,
      );
      return adminOk(request, env, {
        meta: withTokenDaysLeft(meta),
        file: { path, slug, sha, comments: doc.comments },
      });
    }

    // 5) 删除
    if (action === 'delete') {
      const path = checkFilePath(payload.path);
      const id = checkId(payload.id);
      const withReplies = payload.withReplies !== false;
      const slug = slugFromPath(path);
      const { doc, sha, result } = await mutateDoc(
        d,
        env,
        path,
        meta,
        (current) => {
          const index = current.comments.findIndex((c) => c && c.id === id);
          if (index < 0) throw new AdminError(404, 'COMMENT_NOT_FOUND', '这条评论已经不存在了。');
          const target = normalizeComment(current.comments[index]);

          if (!withReplies) {
            // 只删这一条：把它的直接回复挂到它的父评论上，别让回复变成孤儿
            const parent = typeof target.replyTo === 'string' ? target.replyTo : '';
            current.comments.forEach((c) => {
              if (c && c.replyTo === target.id) c.replyTo = parent;
            });
            current.comments.splice(index, 1);
            return { removed: [target.id] };
          }

          // 默认连整串回复一起删（否则删掉主评论后，下面的回复会变成一堆顶层评论）
          const children = new Map();
          current.comments.forEach((c) => {
            if (!c || typeof c.replyTo !== 'string' || !c.replyTo) return;
            const arr = children.get(c.replyTo) || [];
            arr.push(c);
            children.set(c.replyTo, arr);
          });
          const doomed = new Set([target.id]);
          const stack = [target.id];
          while (stack.length) {
            const cur = stack.pop();
            const kids = children.get(cur) || [];
            for (const kid of kids) {
              if (kid && typeof kid.id === 'string' && !doomed.has(kid.id)) {
                doomed.add(kid.id);
                stack.push(kid.id);
              }
            }
          }
          current.comments = current.comments.filter((c) => !(c && doomed.has(c.id)));
          return { removed: Array.from(doomed) };
        },
        `删除评论: ${slug}`,
      );
      return adminOk(request, env, {
        meta: withTokenDaysLeft(meta),
        file: { path, slug, sha, comments: doc.comments },
        removed: result.removed,
      });
    }

    // 6) 博主回复
    if (action === 'reply') {
      const path = checkFilePath(payload.path);
      const parentId = checkId(payload.id);
      const body = cleanBody(payload.body);
      if (!body) throw new AdminError(400, 'EMPTY_BODY', '回复内容不能为空');
      if (body.length > MAX_BODY_LEN) {
        throw new AdminError(400, 'BODY_TOO_LONG', `回复内容太长（最多 ${MAX_BODY_LEN} 字）`);
      }
      const slug = slugFromPath(path);
      const adminName = String(env.ADMIN_NAME || DEFAULT_ADMIN_NAME).trim().slice(0, MAX_NAME_LEN) || DEFAULT_ADMIN_NAME;
      const now = d.now();
      const suffix = Math.floor(d.random() * 0xffffff)
        .toString(16)
        .padStart(6, '0');
      const comment = {
        id: `c_${now}_${suffix}`,
        replyTo: parentId,
        name: adminName,
        email: '',
        website: '',
        body,
        ts: new Date(now).toISOString(),
        ua: 'admin-console',
        hidden: false,
        author: true,
      };
      const { doc, sha } = await mutateDoc(
        d,
        env,
        path,
        meta,
        (current) => {
          const parent = current.comments.find((c) => c && c.id === parentId);
          if (!parent) throw new AdminError(404, 'COMMENT_NOT_FOUND', '要回复的那条评论已经不存在了。');
          current.comments.push(comment);
          return comment;
        },
        `博主回复: ${slug}`,
      );
      return adminOk(request, env, {
        meta: withTokenDaysLeft(meta),
        file: { path, slug, sha, comments: doc.comments },
        comment,
      });
    }

    throw new AdminError(400, 'UNKNOWN_ACTION', `不认识的 action：${action}`);
  } catch (err) {
    if (err instanceof AdminError) return adminFail(request, env, err.status, err.code, err.message);
    const message = err && err.message ? err.message : String(err);
    return adminFail(request, env, 500, 'INTERNAL', `管理操作失败：${message}`);
  }
}

/* ------------------------------------------------------------------ */
/* Pages Functions 入口（薄封装）                                       */
/* ------------------------------------------------------------------ */

export async function onRequestGet(context) {
  return handleAdmin(context.request, context.env);
}

export async function onRequestPost(context) {
  return handleAdmin(context.request, context.env);
}

export async function onRequestOptions(context) {
  const { request, env } = context;
  const originError = checkOrigin(request, env);
  if (originError) return originError;
  return new Response(null, { status: 204, headers: corsHeaders(request, env) });
}

export async function onRequest(context) {
  const { request, env } = context;
  return adminFail(request, env, 405, 'METHOD_NOT_ALLOWED', '管理接口只接受 GET / POST');
}
