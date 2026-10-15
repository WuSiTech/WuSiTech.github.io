/**
 * Git 评论系统的自测（Node 18+ 直接跑）：
 *     node tools/git-comments/test.mjs
 *
 * 它用假的 fetch 顶替 GitHub API，把 handleComment() 的完整链路跑一遍：
 * 正常提交（direct / pr 两种模式）、冲突重试、蜜罐、各类校验、限流、报错。
 * 不需要网络、不需要任何第三方依赖。
 */

import { readFileSync } from 'node:fs';
import { handleComment, __resetRateLimit } from '../../functions/api/comment.js';

const API = 'https://api.github.com';
const REPO = 'WuSiTech/WuSiTech.github.io';
const BRANCH = 'main';

/**
 * static/admin/config.yml 里 comments 集合声明的 9 个字段。
 * Function 写出来的每条评论必须【恰好】是这 9 个键：多一个（后台保存时会丢）
 * 或少一个（后台读不到值）都算失败。
 */
const COMMENT_FIELDS = ['id', 'name', 'email', 'website', 'body', 'ts', 'ua', 'hidden', 'author'];

/** 键集合是否与 COMMENT_FIELDS 完全一致（长度 + 每个键都在，顺序不强制） */
function sameFieldSet(comment) {
  if (!comment || typeof comment !== 'object' || Array.isArray(comment)) return false;
  const got = Object.keys(comment).sort();
  const want = COMMENT_FIELDS.slice().sort();
  return got.length === want.length && got.every((k, i) => k === want[i]);
}

/** 描述实际的键，失败时方便看差在哪 */
function fieldDetail(comment) {
  if (!comment || typeof comment !== 'object') return '没有评论对象';
  return `keys=[${Object.keys(comment).join(',')}] hidden=${JSON.stringify(comment.hidden)} author=${JSON.stringify(comment.author)}`;
}

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  → ' + detail : ''}`);
}

function envOf(extra = {}) {
  return {
    GITHUB_TOKEN: 'github_pat_fake',
    GITHUB_REPO: REPO,
    GITHUB_BRANCH: BRANCH,
    ALLOWED_ORIGINS: 'https://wusitech.github.io,https://wstk.pages.dev',
    ...extra,
  };
}

/* ------------------------------------------------------------------ */
/* 假 GitHub                                                           */
/* ------------------------------------------------------------------ */

function b64encode(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

function b64decode(text) {
  return Buffer.from(String(text).replace(/\s+/g, ''), 'base64').toString('utf8');
}

/**
 * 极简版 GitHub Contents / Git refs / Pulls API。
 *
 * @param {object} opts
 *   opts.files        初始文件：{ path: { content, sha } }
 *   opts.putFailTimes 前 N 次 PUT 故意返回 409（测冲突重试）
 *   opts.failStatus   所有请求直接返回这个状态（测 401 之类）
 *   opts.failMessage  随 failStatus 一起返回的 message
 *   opts.refSha       GET git/ref 返回的 commit sha
 */
function makeGithub(opts = {}) {
  const files = {};
  for (const [p, v] of Object.entries(opts.files || {})) {
    files[p] = { content: v.content, sha: v.sha, branch: v.branch || BRANCH };
  }
  const log = [];
  let putCount = 0;
  let shaSeq = 100;

  const json = (status, body) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  async function fetchImpl(url, init = {}) {
    const u = String(url);
    if (!u.startsWith(API)) throw new Error('测试里没预期的请求: ' + u);
    const method = (init.method || 'GET').toUpperCase();
    const path = u.slice(API.length).split('?')[0];
    const query = u.includes('?') ? u.slice(u.indexOf('?') + 1) : '';
    const entry = { method, path, url: u, body: null };
    if (init.body) {
      try {
        entry.body = JSON.parse(init.body);
      } catch {
        entry.body = init.body;
      }
    }
    entry.headers = init.headers || {};
    log.push(entry);

    if (opts.failStatus) {
      return json(opts.failStatus, { message: opts.failMessage || 'Bad credentials' });
    }

    const putMatch = path.match(new RegExp(`^/repos/${REPO}/contents/(.+)$`));
    if (putMatch) {
      const filePath = putMatch[1];
      if (method === 'GET') {
        const ref = new URLSearchParams(query).get('ref') || BRANCH;
        const file = files[filePath];
        if (!file || file.branch !== ref) {
          return json(404, { message: 'Not Found' });
        }
        return json(200, {
          name: filePath.split('/').pop(),
          path: filePath,
          sha: file.sha,
          content: b64encode(file.content),
          encoding: 'base64',
        });
      }
      if (method === 'PUT') {
        putCount += 1;
        if (opts.putFailTimes && putCount <= opts.putFailTimes) {
          return json(409, { message: 'sha does not match' });
        }
        const stored = files[filePath];
        if (stored && stored.sha && entry.body.sha !== stored.sha) {
          return json(409, { message: 'sha does not match' });
        }
        const content = b64decode(entry.body.content);
        files[filePath] = {
          content,
          sha: 'sha_' + shaSeq++,
          branch: entry.body.branch || BRANCH,
        };
        return json(200, {
          content: { path: filePath, sha: files[filePath].sha },
          commit: { sha: 'commit_fake' },
        });
      }
    }

    if (path === `/repos/${REPO}/git/ref/heads/${BRANCH}` && method === 'GET') {
      return json(200, { ref: `refs/heads/${BRANCH}`, object: { sha: opts.refSha || 'base_sha_1' } });
    }

    if (path === `/repos/${REPO}/git/refs` && method === 'POST') {
      if (opts.branchExists) return json(422, { message: 'Reference already exists' });
      return json(201, { ref: entry.body.ref, object: { sha: entry.body.sha } });
    }

    if (path === `/repos/${REPO}/pulls` && method === 'POST') {
      return json(201, {
        number: 42,
        html_url: `https://github.com/${REPO}/pull/42`,
      });
    }

    return json(404, { message: '测试未实现的路径: ' + path });
  }

  return {
    fetchImpl,
    log,
    files,
    putCount: () => putCount,
    calls: (method, re) => log.filter((e) => e.method === method && re.test(e.path)),
    resets: () => log.filter((e) => e.method === 'PUT'),
  };
}

/* ------------------------------------------------------------------ */
/* 调用辅助                                                            */
/* ------------------------------------------------------------------ */

const ORIGIN = 'https://wusitech.github.io';

function depsFor(github, over = {}) {
  return {
    fetch: github.fetchImpl,
    now: () => 1750000000000,
    random: () => 0.5,
    ...over,
  };
}

let ipSeq = 0;
/** 每次调用换一个 IP，避开「同一实例内存限流」互相污染（限流本身单独测） */
function req(body, { headers = {}, method = 'POST', ip } = {}) {
  ipSeq += 1;
  const all = {
    origin: ORIGIN,
    'content-type': 'application/json',
    'cf-connecting-ip': ip || `203.0.113.${ipSeq}`,
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0) TestBrowser/1.0',
    ...headers,
  };
  const init = { method, headers: all };
  if (body !== undefined && body !== null) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  return new Request('https://wstk.pages.dev/api/comment', init);
}

const GOOD = {
  slug: 'posts/stm32f4-interrupt',
  name: '访客小明',
  email: 'a@example.com',
  website: 'https://example.com/me',
  body: '第一行\n第二行 <script>alert(1)</script>',
  hp: '',
};

/* ------------------------------------------------------------------ */
/* 1) direct 模式：新建文件                                            */
/* ------------------------------------------------------------------ */
{
  const gh = makeGithub();
  const res = await handleComment(req(GOOD), envOf({ COMMENT_MODE: 'direct' }), depsFor(gh));
  const data = await res.json();
  const file = gh.files['static/comments/posts/stm32f4-interrupt.json'];
  let doc = null;
  try {
    doc = JSON.parse(file.content);
  } catch {
    doc = null;
  }
  const c = doc && doc.comments && doc.comments[0];
  const ok =
    res.status === 200 &&
    data.ok === true &&
    data.mode === 'direct' &&
    !!file &&
    file.content.endsWith('\n') &&
    doc.slug === 'posts/stm32f4-interrupt' &&
    doc.comments.length === 1 &&
    c &&
    c.name === '访客小明' &&
    c.website === 'https://example.com/me' &&
    typeof c.ts === 'string' &&
    /^c_\d+_[0-9a-f]{6}$/.test(c.id) &&
    !!c.ua;
  check(
    '1. direct 模式新建文件并写入评论',
    ok,
    `status=${res.status} mode=${data.mode} comments=${doc ? doc.comments.length : 'n/a'}`,
  );

  // 字段集合必须与 static/admin/config.yml 的 9 个字段完全对齐，
  // 否则后台保存这个 JSON 时会把没声明的字段（或声明了但没写的字段）弄丢
  check(
    '1b. 新评论字段集合与 CMS 声明完全一致（9 个，不多不少）',
    sameFieldSet(c),
    fieldDetail(c),
  );
  check(
    '1c. 新评论 hidden / author 都存在且都是布尔 false',
    !!c &&
      typeof c.hidden === 'boolean' &&
      typeof c.author === 'boolean' &&
      c.hidden === false &&
      c.author === false,
    `hidden=${JSON.stringify(c && c.hidden)}(${typeof (c && c.hidden)}) ` +
      `author=${JSON.stringify(c && c.author)}(${typeof (c && c.author)})`,
  );
  check(
    '1d. 新评论键顺序与 Function/CMS 约定一致（id…author）',
    !!c && Object.keys(c).join(',') === COMMENT_FIELDS.join(','),
    c ? `keys=[${Object.keys(c).join(',')}]` : '没有评论对象',
  );
}

/* ------------------------------------------------------------------ */
/* 2) pr 模式：建分支 + 写文件（带 branch）+ 开 PR                      */
/* ------------------------------------------------------------------ */
{
  const gh = makeGithub();
  const res = await handleComment(req(GOOD), envOf({ COMMENT_MODE: 'pr' }), depsFor(gh));
  const data = await res.json();
  const branchCalls = gh.calls('POST', /\/git\/refs$/);
  const puts = gh.resets();
  const pulls = gh.calls('POST', /\/pulls$/);
  const branchName = branchCalls[0] ? branchCalls[0].body.ref.replace('refs/heads/', '') : '';
  const ok =
    res.status === 200 &&
    data.ok === true &&
    data.mode === 'pr' &&
    data.pr === `https://github.com/${REPO}/pull/42` &&
    data.message.includes('审核合并后显示') &&
    branchCalls.length === 1 &&
    branchCalls[0].body.sha === 'base_sha_1' &&
    /^comment\/posts-stm32f4-interrupt-\d+$/.test(branchName) &&
    puts.length === 1 &&
    puts[0].body.branch === branchName &&
    pulls.length === 1 &&
    pulls[0].body.head === branchName &&
    pulls[0].body.base === BRANCH &&
    pulls[0].body.title.includes('新评论') &&
    pulls[0].body.body.includes('第一行');
  check('2. pr 模式建分支、在分支上写文件并开 PR', ok, `status=${res.status} branch=${branchName} pr=${data.pr}`);

  // 分支上写出来的评论，字段集合要和 direct 模式完全一样
  let prComment = null;
  try {
    const prFile = gh.files['static/comments/posts/stm32f4-interrupt.json'];
    prComment = JSON.parse(prFile.content).comments[0];
  } catch {
    prComment = null;
  }
  check(
    '2b. pr 模式写入的评论同样是 9 个字段且 hidden / author 为 false',
    sameFieldSet(prComment) && prComment.hidden === false && prComment.author === false,
    fieldDetail(prComment),
  );
}

/* ------------------------------------------------------------------ */
/* 3) 已有文件（direct）：带 sha，追加而不是覆盖                        */
/* ------------------------------------------------------------------ */
{
  const old = {
    slug: 'posts/stm32f4-interrupt',
    comments: [
      {
        id: 'c_1_aaaaaa',
        name: '老访客',
        email: '',
        website: '',
        body: '旧评论',
        ts: '2026-01-01T00:00:00.000Z',
      },
    ],
  };
  const gh = makeGithub({
    files: {
      'static/comments/posts/stm32f4-interrupt.json': {
        content: JSON.stringify(old, null, 2) + '\n',
        sha: 'sha_old',
        branch: BRANCH,
      },
    },
  });
  const res = await handleComment(req(GOOD), envOf({ COMMENT_MODE: 'direct' }), depsFor(gh));
  const put = gh.resets()[0];
  const doc = JSON.parse(gh.files['static/comments/posts/stm32f4-interrupt.json'].content);
  const ok =
    res.status === 200 &&
    !!put &&
    put.body.sha === 'sha_old' &&
    doc.comments.length === 2 &&
    doc.comments[0].body === '旧评论' &&
    doc.comments[1].name === '访客小明';
  check(
    '3. 已有文件时带上 sha 并追加，不覆盖旧评论',
    ok,
    `comments=${doc.comments.length} PUT 带 sha=${put && put.body.sha}`,
  );

  // 追加（旧文件已有评论）这条路径写出来的新评论，字段也必须补齐
  const appended = doc.comments[1];
  check(
    '3b. 追加写入的评论同样带齐 9 个字段且 hidden / author 为 false',
    sameFieldSet(appended) && appended.hidden === false && appended.author === false,
    fieldDetail(appended),
  );
}

/* ------------------------------------------------------------------ */
/* 4) 409 冲突重试                                                     */
/* ------------------------------------------------------------------ */
{
  const gh = makeGithub({ putFailTimes: 1 });
  const res = await handleComment(req(GOOD), envOf({ COMMENT_MODE: 'direct' }), depsFor(gh));
  const data = await res.json();
  const doc = JSON.parse(gh.files['static/comments/posts/stm32f4-interrupt.json'].content);
  const ok =
    res.status === 200 &&
    data.ok === true &&
    gh.putCount() === 2 &&
    doc.comments.length === 1;
  check('4. PUT 409 后重新 GET 合并重试成功', ok, `PUT 次数=${gh.putCount()} status=${res.status}`);
}

/* ------------------------------------------------------------------ */
/* 5) 蜜罐命中：返回成功但不发任何 GitHub 写请求                        */
/* ------------------------------------------------------------------ */
{
  const gh = makeGithub();
  const res = await handleComment(
    req({ ...GOOD, hp: 'http://spam.example.com' }),
    envOf({ COMMENT_MODE: 'pr' }),
    depsFor(gh),
  );
  const data = await res.json();
  const writeish = gh.log.filter((e) => e.method !== 'GET');
  const ok = res.status === 200 && data.ok === true && gh.log.length === 0 && writeish.length === 0;
  check('5. 蜜罐命中：假装成功且不调用 GitHub', ok, `status=${res.status} GitHub 请求数=${gh.log.length}`);
}

/* ------------------------------------------------------------------ */
/* 6) 非法 slug                                                        */
/* ------------------------------------------------------------------ */
{
  const cases = [
    ['../../etc/passwd', '含 ..'],
    ['../../etc', '含 ..'],
    ['/posts/abs', '绝对路径'],
    ['posts/has space', '含空格'],
  ];
  let allOk = true;
  const details = [];
  for (const [slug, label] of cases) {
    const gh = makeGithub();
    const res = await handleComment(req({ ...GOOD, slug }), envOf(), depsFor(gh));
    const data = await res.json();
    const pass = res.status === 400 && data.ok === false && typeof data.error === 'string' && gh.log.length === 0;
    if (!pass) allOk = false;
    details.push(`${label}:${res.status}`);
  }
  check('6. 非法 slug（../绝对路径/空格）一律 400', allOk, details.join(' '));
}

/* ------------------------------------------------------------------ */
/* 7) 必填缺失 / 超长                                                  */
/* ------------------------------------------------------------------ */
{
  const ghA = makeGithub();
  const resA = await handleComment(req({ ...GOOD, name: '   ' }), envOf(), depsFor(ghA));
  const dataA = await resA.json();

  const ghB = makeGithub();
  const resB = await handleComment(req({ ...GOOD, body: '字'.repeat(2001) }), envOf(), depsFor(ghB));
  const dataB = await resB.json();

  const ghC = makeGithub();
  const resC = await handleComment(req({ ...GOOD, name: '名'.repeat(41) }), envOf(), depsFor(ghC));
  const dataC = await resC.json();

  const ok =
    resA.status === 400 &&
    dataA.error.includes('昵称') &&
    ghA.log.length === 0 &&
    resB.status === 400 &&
    dataB.error.includes('太长') &&
    ghB.log.length === 0 &&
    resC.status === 400 &&
    ghC.log.length === 0;
  check('7. 昵称为空 / 正文 2001 字 / 昵称 41 字 → 400', ok, `${resA.status} ${resB.status} ${resC.status}`);
}

/* ------------------------------------------------------------------ */
/* 8) 链接过多                                                         */
/* ------------------------------------------------------------------ */
{
  const many = '看这里 ' + Array.from({ length: 6 }, (_, i) => `http://a${i}.example.com`).join(' ');
  const gh = makeGithub();
  const res = await handleComment(req({ ...GOOD, body: many }), envOf(), depsFor(gh));
  const data = await res.json();
  check(
    '8. 正文 6 个链接 → 400',
    res.status === 400 && data.error.includes('链接') && gh.log.length === 0,
    `status=${res.status} error=${data.error}`,
  );
}

/* ------------------------------------------------------------------ */
/* 9) 来源不在白名单                                                    */
/* ------------------------------------------------------------------ */
{
  const gh = makeGithub();
  const res = await handleComment(
    req(GOOD, { headers: { origin: 'https://evil.example.com' } }),
    envOf(),
    depsFor(gh),
  );
  const data = await res.json();
  check(
    '9. 非白名单来源 → 403',
    res.status === 403 && data.ok === false && gh.log.length === 0,
    `status=${res.status} error=${data.error}`,
  );
}

/* ------------------------------------------------------------------ */
/* 10) 频率限制：同一 IP 第 4 次 429                                    */
/* ------------------------------------------------------------------ */
{
  __resetRateLimit();
  const gh = makeGithub();
  const env = envOf({ COMMENT_MODE: 'direct' });
  const deps = depsFor(gh);
  const statuses = [];
  for (let i = 0; i < 4; i++) {
    const res = await handleComment(req(GOOD, { ip: '198.51.100.7' }), env, deps);
    statuses.push(res.status);
    if (i === 3) {
      const data = await res.json();
      statuses.push(data.error);
    }
  }
  const ok =
    statuses[0] === 200 &&
    statuses[1] === 200 &&
    statuses[2] === 200 &&
    statuses[3] === 429 &&
    String(statuses[4]).includes('频繁');
  check('10. 同一 IP 60 秒内第 4 次提交 → 429', ok, statuses.slice(0, 4).join(' '));

  // 换个 IP 不受影响
  const other = await handleComment(req(GOOD, { ip: '198.51.100.8' }), env, deps);
  check('10b. 换一个 IP 不受限流影响', other.status === 200, `status=${other.status}`);
}

/* ------------------------------------------------------------------ */
/* 11) GitHub 401 → 502 且可读                                         */
/* ------------------------------------------------------------------ */
{
  const gh = makeGithub({ failStatus: 401, failMessage: 'Bad credentials' });
  const res = await handleComment(req(GOOD), envOf({ COMMENT_MODE: 'direct' }), depsFor(gh));
  const data = await res.json();
  const ok =
    res.status === 502 &&
    data.ok === false &&
    data.error.includes('GitHub') &&
    data.error.includes('Bad credentials');
  check('11. 令牌无效（401）→ 502 且错误可读', ok, `status=${res.status} error=${data.error}`);
}

/* ------------------------------------------------------------------ */
/* 12) 非 POST → 405                                                   */
/* ------------------------------------------------------------------ */
{
  const gh = makeGithub();
  const res = await handleComment(req(null, { method: 'GET' }), envOf(), depsFor(gh));
  const data = await res.json();
  check(
    '12. GET 请求 → 405',
    res.status === 405 && data.ok === false && gh.log.length === 0,
    `status=${res.status}`,
  );
}

/* ------------------------------------------------------------------ */
/* 13) 附加：坏 JSON、website 非 http、optional 超长、CORS 头           */
/* ------------------------------------------------------------------ */
{
  const gh = makeGithub();
  const resBad = await handleComment(req('{not json'), envOf(), depsFor(gh));
  check('13a. 请求体不是 JSON → 400', resBad.status === 400, `status=${resBad.status}`);

  const gh2 = makeGithub();
  const res2 = await handleComment(
    req({ ...GOOD, website: 'javascript:alert(1)', email: 'x'.repeat(250) }),
    envOf({ COMMENT_MODE: 'direct' }),
    depsFor(gh2),
  );
  const doc2 = JSON.parse(gh2.files['static/comments/posts/stm32f4-interrupt.json'].content);
  const c2 = doc2.comments[0];
  check(
    '13b. website 非 http(s) 被丢弃、email 截断到 200',
    res2.status === 200 && c2.website === '' && c2.email.length === 200,
    `website="${c2.website}" email.len=${c2.email.length}`,
  );

  const gh3 = makeGithub();
  const res3 = await handleComment(
    req(GOOD, { headers: { origin: 'https://wstk.pages.dev' } }),
    envOf({ COMMENT_MODE: 'direct' }),
    depsFor(gh3),
  );
  const acao = res3.headers.get('access-control-allow-origin');
  const vary = res3.headers.get('vary');
  check(
    '13c. 响应带 CORS 头（Allow-Origin / Vary: Origin）',
    acao === 'https://wstk.pages.dev' && /origin/i.test(vary || ''),
    `ACAO=${acao} Vary=${vary}`,
  );
}

/* ------------------------------------------------------------------ */
/* 14) 源码卫生：Workers 里不能有 Buffer / escape / unescape            */
/* ------------------------------------------------------------------ */
{
  const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const fnSrc = strip(readFileSync(new URL('../../functions/api/comment.js', import.meta.url), 'utf8'));
  const jsSrc = strip(readFileSync(new URL('../../static/js/comments.js', import.meta.url), 'utf8'));
  const badFn = /\bBuffer\b|\bunescape\s*\(|\bescape\s*\(/.test(fnSrc);
  const badJs = /\bunescape\s*\(|\bescape\s*\(/.test(jsSrc);
  check('14. 不用 Buffer / escape / unescape（Node 与 Workers 通用）', !badFn && !badJs,
    `function=${badFn} frontend=${badJs}`);
}

const failed = results.filter((r) => !r.pass);
console.log(`\nRESULT: ${failed.length === 0 ? 'ALL PASS' : failed.length + ' FAILED'}  (${results.length} 项)`);
process.exit(failed.length === 0 ? 0 : 1);
