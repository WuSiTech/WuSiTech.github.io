/**
 * 评论管理 API 的自测（Node 18+ 直接跑）：
 *     node tools/git-comments/test-admin.mjs
 *
 * 用假的 fetch 顶替 GitHub API，把 functions/api/admin.js 的完整链路跑一遍：
 * 鉴权（未配置 / 密码错 / 错太多次）、体检、列表、放行/隐藏、删除（连回复 / 只删一条）、
 * 博主回复、路径校验、CORS、GitHub 报错翻译、写冲突重试、令牌有效期解析。
 * 不需要网络、不需要任何第三方依赖。
 */

import { handleAdmin, __resetAdminAuthBuckets } from '../../functions/api/admin.js';

const API = 'https://api.github.com';
const REPO = 'WuSiTech/WuSiTech.github.io';
const BRANCH = 'main';
const ADMIN_TOKEN = 'test-admin-token-0123456789abcdef';
const ADMIN_NAME = '站长';
const ORIGIN = 'https://wstk.pages.dev';

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  → ' + detail : ''}`);
}

function envOf(extra = {}) {
  return {
    ADMIN_TOKEN,
    ADMIN_NAME,
    GITHUB_TOKEN: 'github_pat_fake',
    GITHUB_REPO: REPO,
    GITHUB_BRANCH: BRANCH,
    COMMENT_MODE: 'direct',
    COMMENT_PENDING: 'false',
    ...extra,
  };
}

/* ------------------------------------------------------------------ */
/* 假 GitHub                                                           */
/* ------------------------------------------------------------------ */

const R = (o) => ({
  id: o.id,
  replyTo: o.replyTo || '',
  name: o.name || '访客',
  email: '',
  website: '',
  body: o.body || '正文',
  ts: o.ts || '2026-10-01T00:00:00.000Z',
  ua: '',
  hidden: o.hidden === true,
  author: o.author === true,
});

function b64(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

function makeGithub(opts = {}) {
  const files = {};
  for (const [path, doc] of Object.entries(opts.files || {})) {
    files[path] = { content: JSON.stringify(doc, null, 2) + '\n', sha: opts.sha || 'sha_' + path.replace(/\W+/g, '_') };
  }
  const log = [];
  let shaSeq = 1;
  let putCount = 0;

  const json = (status, body, headers = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });

  const metaHeaders = opts.metaHeaders || {
    'github-authentication-token-expiration': '2026-10-16 12:34:56 UTC',
    'x-ratelimit-limit': '5000',
    'x-ratelimit-remaining': '4990',
    'x-ratelimit-reset': '1760000000',
  };

  async function fetchImpl(url, init = {}) {
    const u = String(url);
    if (!u.startsWith(API)) throw new Error('测试里没预期的请求: ' + u);
    const method = (init.method || 'GET').toUpperCase();
    const path = u.slice(API.length).split('?')[0];
    const query = u.includes('?') ? u.slice(u.indexOf('?') + 1) : '';
    const entry = { method, path, url: u, body: null, headers: init.headers || {} };
    if (init.body) {
      try {
        entry.body = JSON.parse(init.body);
      } catch {
        entry.body = init.body;
      }
    }
    log.push(entry);

    if (opts.failStatus) {
      return json(opts.failStatus, { message: opts.failMessage || 'Bad credentials' }, metaHeaders);
    }

    // 目录列表（体检用）
    if (path === `/repos/${REPO}/contents/static/comments` && method === 'GET') {
      const entries = [
        { name: 'about.json', type: 'file', path: 'static/comments/about.json' },
        { name: 'posts', type: 'dir', path: 'static/comments/posts' },
        { name: 'README.md', type: 'file', path: 'static/comments/README.md' },
        { name: 'admin.html', type: 'file', path: 'static/comments/admin.html' },
      ];
      return json(200, entries, metaHeaders);
    }

    // 整棵树（列表用）
    if (path === `/repos/${REPO}/git/trees/${encodeURIComponent(BRANCH)}` && method === 'GET') {
      const tree = Object.keys(files).map((p) => ({ path: p, type: 'blob', size: 1 }));
      tree.push({ path: 'static/comments/README.md', type: 'blob', size: 1 });
      tree.push({ path: 'static/comments/admin.html', type: 'blob', size: 1 });
      tree.push({ path: 'static/comments/posts', type: 'tree', size: 0 });
      tree.push({ path: 'content/posts/hello.md', type: 'blob', size: 1 });
      return json(200, { sha: 'tree_sha', tree, truncated: false }, metaHeaders);
    }

    const contentMatch = path.match(new RegExp(`^/repos/${REPO}/contents/(.+)$`));
    if (contentMatch) {
      const filePath = contentMatch[1];
      if (method === 'GET') {
        const file = files[filePath];
        if (!file) return json(404, { message: 'Not Found' }, metaHeaders);
        return json(
          200,
          { name: filePath.split('/').pop(), path: filePath, sha: file.sha, content: b64(file.content), encoding: 'base64' },
          metaHeaders,
        );
      }
      if (method === 'PUT') {
        putCount += 1;
        if (opts.putFailTimes && putCount <= opts.putFailTimes) {
          return json(409, { message: 'sha does not match' }, metaHeaders);
        }
        const stored = files[filePath];
        if (stored && stored.sha && entry.body.sha !== stored.sha) {
          return json(409, { message: 'sha does not match' }, metaHeaders);
        }
        files[filePath] = {
          content: Buffer.from(entry.body.content, 'base64').toString('utf8'),
          sha: 'sha_' + shaSeq++,
        };
        return json(
          200,
          { content: { path: filePath, sha: files[filePath].sha }, commit: { sha: 'commit_fake' } },
          metaHeaders,
        );
      }
    }

    return json(404, { message: '测试未实现的路径: ' + path }, metaHeaders);
  }

  return {
    fetchImpl,
    log,
    files,
    putCount: () => putCount,
    doc: (path) => {
      const f = files[path];
      return f ? JSON.parse(f.content) : null;
    },
    puts: () => log.filter((e) => e.method === 'PUT'),
  };
}

/* ------------------------------------------------------------------ */
/* 请求 / 调用辅助                                                     */
/* ------------------------------------------------------------------ */

let ipSeq = 0;

function req(body, { action = '', ip, headers = {}, method = 'POST' } = {}) {
  ipSeq += 1;
  const all = {
    origin: ORIGIN,
    'content-type': 'application/json',
    'cf-connecting-ip': ip || `203.0.113.${ipSeq}`,
    'x-admin-token': ADMIN_TOKEN,
    ...headers,
  };
  let url = 'https://wstk.pages.dev/api/admin';
  if (action) url += '?action=' + encodeURIComponent(action);
  const init = { method, headers: all };
  if (body !== undefined && body !== null) init.body = typeof body === 'string' ? body : JSON.stringify(body);
  return new Request(url, init);
}

function depsFor(github, over = {}) {
  return {
    fetch: github.fetchImpl,
    now: () => Date.parse('2026-10-01T00:00:00.000Z'),
    random: () => 0.5,
    ...over,
  };
}

const FILES = {
  'static/comments/about.json': {
    slug: 'about',
    comments: [R({ id: 'c_about_1', name: '访客A', body: '关于页的评论', hidden: true })],
  },
  'static/comments/posts/hello.json': {
    slug: 'posts/hello',
    comments: [
      R({ id: 'c_root', name: '楼主', body: '主评论', ts: '2026-10-01T00:00:00.000Z' }),
      R({ id: 'c_child1', replyTo: 'c_root', name: '回复者1', body: '一层回复', ts: '2026-10-01T01:00:00.000Z' }),
      R({ id: 'c_child2', replyTo: 'c_child1', name: '回复者2', body: '二层回复', ts: '2026-10-01T02:00:00.000Z' }),
      R({ id: 'c_other', name: '路人', body: '另一条主评论', hidden: true, ts: '2026-10-01T03:00:00.000Z' }),
    ],
  },
};

/* ------------------------------------------------------------------ */
/* 1) 鉴权                                                             */
/* ------------------------------------------------------------------ */
{
  __resetAdminAuthBuckets();
  const gh = makeGithub({ files: FILES });

  // 1a. 没配置 ADMIN_TOKEN → 503，且不碰 GitHub
  const resA = await handleAdmin(req({ action: 'list' }), envOf({ ADMIN_TOKEN: '' }), depsFor(gh));
  const dataA = await resA.json();
  check(
    '1a. 未配置 ADMIN_TOKEN → 503 ADMIN_DISABLED（不会无密码开放）',
    resA.status === 503 && dataA.ok === false && dataA.code === 'ADMIN_DISABLED' && gh.log.length === 0,
    `status=${resA.status} code=${dataA.code}`,
  );

  // 1b. 密码错 → 401，且不碰 GitHub
  const ghB = makeGithub({ files: FILES });
  const resB = await handleAdmin(
    req({ action: 'list' }, { headers: { 'x-admin-token': 'wrong' } }),
    envOf(),
    depsFor(ghB),
  );
  const dataB = await resB.json();
  check(
    '1b. 密码错 → 401 BAD_ADMIN_TOKEN',
    resB.status === 401 && dataB.code === 'BAD_ADMIN_TOKEN' && ghB.log.length === 0,
    `status=${resB.status} code=${dataB.code}`,
  );

  // 1c. 同一 IP 连续错太多次 → 429
  __resetAdminAuthBuckets();
  const ghC = makeGithub({ files: FILES });
  const statuses = [];
  for (let i = 0; i < 13; i++) {
    const res = await handleAdmin(
      req({ action: 'health' }, { ip: '198.51.100.9', headers: { 'x-admin-token': 'nope' } }),
      envOf(),
      depsFor(ghC),
    );
    statuses.push(res.status);
  }
  check(
    '1c. 同一 IP 密码错 12 次后 → 429（防暴力猜）',
    statuses.slice(0, 12).every((s) => s === 401) && statuses[12] === 429,
    statuses.join(' '),
  );
}

/* ------------------------------------------------------------------ */
/* 2) 体检：令牌有效期 / 配额 / 模式                                    */
/* ------------------------------------------------------------------ */
{
  __resetAdminAuthBuckets();
  const gh = makeGithub({ files: FILES });
  const res = await handleAdmin(req({ action: 'health' }), envOf(), depsFor(gh));
  const data = await res.json();
  const meta = data.meta || {};
  check(
    '2a. health 返回仓库 / 分支 / 模式 / 博主昵称',
    res.status === 200 &&
      data.ok === true &&
      meta.repo === REPO &&
      meta.branch === BRANCH &&
      meta.mode === 'direct' &&
      meta.adminName === ADMIN_NAME,
    `repo=${meta.repo} mode=${meta.mode} adminName=${meta.adminName}`,
  );
  check(
    '2b. health 解析出令牌有效期与剩余天数（令牌轮换的哨兵）',
    meta.tokenExpiration === '2026-10-16 12:34:56 UTC' &&
      typeof meta.tokenDaysLeft === 'number' &&
      meta.tokenDaysLeft === 15 &&
      meta.tokenExpirationIso === '2026-10-16T12:34:56.000Z',
    `exp=${meta.tokenExpiration} daysLeft=${meta.tokenDaysLeft} iso=${meta.tokenExpirationIso}`,
  );
  check(
    '2c. health 带上 GitHub 配额（rateLimit / rateRemaining）',
    meta.rateLimit === 5000 && meta.rateRemaining === 4990,
    `limit=${meta.rateLimit} remaining=${meta.rateRemaining}`,
  );
  // 目录接口返回 4 项里只有 1 个 json 文件（README.md / admin.html 不算）
  check('2d. health 统计评论文件数量', meta.commentFileCount === 1, `count=${meta.commentFileCount}`);
}

/* ------------------------------------------------------------------ */
/* 3) 列表                                                             */
/* ------------------------------------------------------------------ */
{
  __resetAdminAuthBuckets();
  const gh = makeGithub({ files: FILES });
  const res = await handleAdmin(req({ action: 'list' }), envOf(), depsFor(gh));
  const data = await res.json();
  const files = data.files || [];
  const paths = files.map((f) => f.path);
  check(
    '3a. list 只列出 static/comments/**.json（跳过 README / admin.html / 文章）',
    res.status === 200 &&
      data.ok === true &&
      paths.join(',') === 'static/comments/about.json,static/comments/posts/hello.json',
    paths.join(' | '),
  );
  const hello = files.find((f) => f.slug === 'posts/hello');
  check(
    '3b. list 返回每条评论内容 + slug + sha（含待审核的隐藏评论）',
    !!hello && hello.comments.length === 4 && hello.comments.some((c) => c.hidden === true) && !!hello.sha,
    hello ? `comments=${hello.comments.length} sha=${hello.sha}` : '缺 posts/hello',
  );
  check('3c. list 响应里也带 meta（令牌有效期）', !!data.meta && data.meta.tokenExpiration === '2026-10-16 12:34:56 UTC');
}

/* ------------------------------------------------------------------ */
/* 4) 放行 / 隐藏                                                      */
/* ------------------------------------------------------------------ */
{
  __resetAdminAuthBuckets();
  const gh = makeGithub({ files: FILES });
  const res = await handleAdmin(
    req({ action: 'setHidden', path: 'static/comments/about.json', id: 'c_about_1', hidden: false }),
    envOf(),
    depsFor(gh),
  );
  const data = await res.json();
  const doc = gh.doc('static/comments/about.json');
  const c = doc.comments[0];
  const put = gh.puts()[0];
  check(
    '4a. 放行：hidden 改成 false 并带 sha 提交（一次 PUT）',
    res.status === 200 && data.ok === true && c.hidden === false && !!put && put.body.sha && data.file.comments[0].hidden === false,
    `status=${res.status} hidden=${c.hidden} sha=${put && put.body.sha}`,
  );
  check(
    '4b. 提交信息里写明是放行哪个页面（方便翻 Git 历史）',
    !!put && /关于|about/.test(String(put.body.message)) && /通过/.test(String(put.body.message)),
    put && put.body.message,
  );

  // 4c. 隐藏
  const gh2 = makeGithub({ files: FILES });
  const res2 = await handleAdmin(
    req({ action: 'setHidden', path: 'static/comments/posts/hello.json', id: 'c_root', hidden: true }),
    envOf(),
    depsFor(gh2),
  );
  const data2 = await res2.json();
  check(
    '4c. 隐藏：hidden 改成 true',
    res2.status === 200 && gh2.doc('static/comments/posts/hello.json').comments[0].hidden === true && data2.ok === true,
  );

  // 4d. 不存在的评论 id → 404 且不写
  const gh3 = makeGithub({ files: FILES });
  const res3 = await handleAdmin(
    req({ action: 'setHidden', path: 'static/comments/about.json', id: 'c_nope', hidden: false }),
    envOf(),
    depsFor(gh3),
  );
  const data3 = await res3.json();
  check(
    '4d. 不存在的评论 id → 404，不写文件',
    res3.status === 404 && data3.code === 'COMMENT_NOT_FOUND' && gh3.putCount() === 0,
    `status=${res3.status} code=${data3.code}`,
  );

  // 4e. hidden 不是布尔 → 400
  const gh4 = makeGithub({ files: FILES });
  const res4 = await handleAdmin(
    req({ action: 'setHidden', path: 'static/comments/about.json', id: 'c_about_1', hidden: 'yes' }),
    envOf(),
    depsFor(gh4),
  );
  check('4e. hidden 不是布尔 → 400', res4.status === 400, `status=${res4.status}`);
}

/* ------------------------------------------------------------------ */
/* 5) 删除                                                             */
/* ------------------------------------------------------------------ */
{
  __resetAdminAuthBuckets();
  // 5a. 默认连整串回复一起删
  const gh = makeGithub({ files: FILES });
  const res = await handleAdmin(
    req({ action: 'delete', path: 'static/comments/posts/hello.json', id: 'c_child1' }),
    envOf(),
    depsFor(gh),
  );
  const data = await res.json();
  const ids = gh.doc('static/comments/posts/hello.json').comments.map((c) => c.id);
  check(
    '5a. 删除默认连它的所有下级回复一起删（c_child1 + c_child2）',
    res.status === 200 &&
      data.ok === true &&
      ids.includes('c_root') &&
      !ids.includes('c_child1') &&
      !ids.includes('c_child2') &&
      data.removed.length === 2,
    `剩下=${ids.join(',')} removed=${(data.removed || []).join(',')}`,
  );

  // 5b. withReplies=false：只删自己，回复挂到上一层
  const gh2 = makeGithub({ files: FILES });
  const res2 = await handleAdmin(
    req({ action: 'delete', path: 'static/comments/posts/hello.json', id: 'c_child1', withReplies: false }),
    envOf(),
    depsFor(gh2),
  );
  const doc2 = gh2.doc('static/comments/posts/hello.json');
  const child2 = doc2.comments.find((c) => c.id === 'c_child2');
  const ids2 = doc2.comments.map((c) => c.id);
  check(
    '5b. withReplies=false：只删这条，回复挂到它的父评论上（不会变成孤儿）',
    res2.status === 200 && !ids2.includes('c_child1') && ids2.includes('c_child2') && child2.replyTo === 'c_root',
    `剩下=${ids2.join(',')} c_child2.replyTo=${child2 && child2.replyTo}`,
  );

  // 5c. 路径穿越拒绝
  const gh3 = makeGithub({ files: FILES });
  const res3 = await handleAdmin(
    req({ action: 'delete', path: 'static/comments/../../content/x.json', id: 'c_root' }),
    envOf(),
    depsFor(gh3),
  );
  const data3 = await res3.json();
  check(
    '5c. 越界路径（../）→ 400，不碰 GitHub',
    res3.status === 400 && data3.code === 'BAD_PATH' && gh3.log.length === 0,
    `status=${res3.status} code=${data3.code}`,
  );
}

/* ------------------------------------------------------------------ */
/* 6) 博主回复                                                         */
/* ------------------------------------------------------------------ */
{
  __resetAdminAuthBuckets();
  const gh = makeGithub({ files: FILES });
  const res = await handleAdmin(
    req({ action: 'reply', path: 'static/comments/posts/hello.json', id: 'c_child2', body: '我是站长，回复你' }),
    envOf(),
    depsFor(gh),
  );
  const data = await res.json();
  const doc = gh.doc('static/comments/posts/hello.json');
  const added = doc.comments[doc.comments.length - 1];
  const want = ['id', 'replyTo', 'name', 'email', 'website', 'body', 'ts', 'ua', 'hidden', 'author'];
  check(
    '6a. 博主回复：replyTo 指向被回复的评论、author=true、hidden=false、10 个字段顺序正确',
    res.status === 200 &&
      data.ok === true &&
      added.replyTo === 'c_child2' &&
      added.author === true &&
      added.hidden === false &&
      added.name === ADMIN_NAME &&
      Object.keys(added).join(',') === want.join(','),
    `replyTo=${added.replyTo} author=${added.author} keys=${Object.keys(added).join(',')}`,
  );
  check(
    '6b. 回复内容原样保存（换行保留、长度限制内）',
    added.body === '我是站长，回复你',
    JSON.stringify(added.body),
  );

  // 6c. 空回复 → 400
  const gh2 = makeGithub({ files: FILES });
  const res2 = await handleAdmin(
    req({ action: 'reply', path: 'static/comments/posts/hello.json', id: 'c_root', body: '   ' }),
    envOf(),
    depsFor(gh2),
  );
  check('6c. 空回复 → 400，不写文件', res2.status === 400 && gh2.putCount() === 0, `status=${res2.status}`);

  // 6d. 回复不存在的评论 → 404
  const gh3 = makeGithub({ files: FILES });
  const res3 = await handleAdmin(
    req({ action: 'reply', path: 'static/comments/posts/hello.json', id: 'c_nope', body: '回复空气' }),
    envOf(),
    depsFor(gh3),
  );
  const data3 = await res3.json();
  check(
    '6d. 回复不存在的评论 → 404',
    res3.status === 404 && data3.code === 'COMMENT_NOT_FOUND' && gh3.putCount() === 0,
    `status=${res3.status} code=${data3.code}`,
  );
}

/* ------------------------------------------------------------------ */
/* 7) 来源 / 方法 / CORS                                               */
/* ------------------------------------------------------------------ */
{
  __resetAdminAuthBuckets();
  const gh = makeGithub({ files: FILES });

  // 7a. 非白名单来源 → 403（在鉴权之前就拒绝）
  const res = await handleAdmin(
    req({ action: 'list' }, { headers: { origin: 'https://evil.example.com' } }),
    envOf(),
    depsFor(gh),
  );
  const data = await res.json();
  check(
    '7a. 非白名单 Origin → 403，不碰 GitHub',
    res.status === 403 && data.code === 'ORIGIN_NOT_ALLOWED' && gh.log.length === 0,
    `status=${res.status} code=${data.code}`,
  );

  // 7b. GET ?action=health 也能用（方便 curl 检查）
  const gh2 = makeGithub({ files: FILES });
  const res2 = await handleAdmin(req(null, { action: 'health', method: 'GET' }), envOf(), depsFor(gh2));
  const data2 = await res2.json();
  check('7b. GET ?action=health 可用（curl 体检）', res2.status === 200 && data2.ok === true, `status=${res2.status}`);

  // 7c. PUT 之类的方法 → 405
  const res3 = await handleAdmin(req(null, { method: 'PUT' }), envOf(), depsFor(makeGithub()));
  check('7c. 其它方法 → 405', res3.status === 405, `status=${res3.status}`);

  // 7d. 未知 action → 400
  const res4 = await handleAdmin(req({ action: 'rm-rf' }), envOf(), depsFor(makeGithub()));
  const data4 = await res4.json();
  check('7d. 未知 action → 400', res4.status === 400 && data4.code === 'UNKNOWN_ACTION', `status=${res4.status}`);
}

/* ------------------------------------------------------------------ */
/* 8) GitHub 报错翻译 / 写冲突重试                                     */
/* ------------------------------------------------------------------ */
{
  __resetAdminAuthBuckets();
  // 8a. GITHUB_TOKEN 过期（401）→ 502 + 可操作的提示
  const gh = makeGithub({ failStatus: 401, failMessage: 'Bad credentials' });
  const res = await handleAdmin(req({ action: 'list' }), envOf(), depsFor(gh));
  const data = await res.json();
  check(
    '8a. GitHub 401 → 502 GITHUB_TOKEN_INVALID，提示更新令牌并重新部署',
    res.status === 502 &&
      data.code === 'GITHUB_TOKEN_INVALID' &&
      /过期/.test(data.error) &&
      /重新部署/.test(data.error),
    `status=${res.status} code=${data.code}`,
  );

  // 8b. 首次 PUT 409 → 重新读取合并后重试成功
  const gh2 = makeGithub({ files: FILES, putFailTimes: 1 });
  const res2 = await handleAdmin(
    req({ action: 'setHidden', path: 'static/comments/about.json', id: 'c_about_1', hidden: false }),
    envOf(),
    depsFor(gh2),
  );
  const data2 = await res2.json();
  check(
    '8b. 写冲突（409）自动重读 + 重试成功',
    res2.status === 200 && data2.ok === true && gh2.putCount() === 2 && gh2.doc('static/comments/about.json').comments[0].hidden === false,
    `PUT 次数=${gh2.putCount()}`,
  );
}

/* ------------------------------------------------------------------ */
/* 9) 请求体校验                                                       */
/* ------------------------------------------------------------------ */
{
  __resetAdminAuthBuckets();
  const gh = makeGithub({ files: FILES });

  const resA = await handleAdmin(req('{not json'), envOf(), depsFor(gh));
  check('9a. 请求体不是 JSON → 400', resA.status === 400, `status=${resA.status}`);

  const resB = await handleAdmin(req({}), envOf(), depsFor(gh));
  const dataB = await resB.json();
  check('9b. 缺 action → 400', resB.status === 400 && dataB.code === 'MISSING_ACTION', `status=${resB.status}`);

  const resC = await handleAdmin(
    req({ action: 'setHidden', path: 'static/comments/about.json', id: 'c_about_1', hidden: false }, { headers: { 'x-admin-token': '' } }),
    envOf(),
    depsFor(makeGithub({ files: FILES })),
  );
  check('9c. 没带密码 → 401', resC.status === 401, `status=${resC.status}`);
}

const failed = results.filter((r) => !r.pass);
console.log(`\nRESULT: ${failed.length === 0 ? 'ALL PASS' : failed.length + ' FAILED'}  (${results.length} 项)`);
process.exit(failed.length === 0 ? 0 : 1);
