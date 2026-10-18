/**
 * 评论前端（static/js/comments.js）的自测：node tools/git-comments/test-frontend.mjs
 *
 * 没有浏览器也能跑：这里手写了一个极简 DOM（只实现 comments.js 用得到的那部分 API），
 * 把真实的 comments.js 用 vm 加载进去，然后像用户一样点「回复」、提交表单、翻页，
 * 断言渲染结果和实际发给后端的请求体。
 *
 * 重点覆盖（都是 v15 修的问题）：
 *   - 点「回复」后提交的 payload 里必须带 replyTo（否则后端存不出嵌套关系）
 *   - 连点不同评论的「回复」时，正文里 @昵称 前缀不会越堆越多；取消回复能去掉前缀
 *   - 嵌套渲染：回复紧跟主评论、缩进、↑ 标记、线程排序、分页、隐藏评论不渲染
 *   - 提交成功后清空输入并退出回复状态
 */

import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../../static/js/comments.js', import.meta.url), 'utf8');

/* ------------------------------------------------------------------ */
/* 极简 DOM                                                           */
/* ------------------------------------------------------------------ */

function parseCompound(sel) {
  const s = String(sel).trim();
  if (s === '*') return { tag: null, id: null, classes: [], attrs: [] };
  const out = { tag: null, id: null, classes: [], attrs: [] };
  let rest = s;
  const tagMatch = /^([a-zA-Z][a-zA-Z0-9-]*)/.exec(rest);
  if (tagMatch) {
    out.tag = tagMatch[1].toUpperCase();
    rest = rest.slice(tagMatch[0].length);
  }
  let m;
  while ((m = /^([#.])([\w-]+)/.exec(rest))) {
    if (m[1] === '#') out.id = m[2];
    else out.classes.push(m[2]);
    rest = rest.slice(m[0].length);
  }
  while ((m = /^\[([\w-]+)(?:="([^"]*)")?\]/.exec(rest))) {
    out.attrs.push([m[1], m[2] === undefined ? null : m[2]]);
    rest = rest.slice(m[0].length);
  }
  return rest ? null : out;
}

function matchesSimple(node, sel) {
  const p = parseCompound(sel);
  if (!p || !node || node.tagName === '#TEXT' || node.tagName === '#DOCUMENT') return false;
  if (p.tag && node.tagName !== p.tag) return false;
  if (p.id && String(node.id || node.attributes.id || '') !== p.id) return false;
  if (p.classes.length) {
    const list = String(node.className || '').split(/\s+/).filter(Boolean);
    for (const c of p.classes) if (!list.includes(c)) return false;
  }
  for (const [key, value] of p.attrs) {
    const got = node.attributes[key];
    if (value === null ? got === undefined : got !== value) return false;
  }
  return true;
}

function matchesChain(node, parts) {
  if (!matchesSimple(node, parts[parts.length - 1])) return false;
  let i = parts.length - 2;
  let parent = node.parentNode;
  while (i >= 0 && parent) {
    if (matchesSimple(parent, parts[i])) i -= 1;
    parent = parent.parentNode;
  }
  return i < 0;
}

function walk(root, visit) {
  for (const child of root.children || []) {
    visit(child);
    walk(child, visit);
  }
}

class DomNode {
  constructor(tag) {
    this.tagName = String(tag || '').toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.className = '';
    this.id = '';
    this._text = '';
    this.style = {};
    this.attributes = {};
    this.listeners = {};
    this.value = '';
    this.disabled = false;
    this.checked = false;
    this.type = '';
    this.name = '';
    this.maxLength = 0;
  }

  get firstChild() {
    return this.children.length ? this.children[0] : null;
  }

  get nextSibling() {
    if (!this.parentNode) return null;
    const i = this.parentNode.children.indexOf(this);
    return i < 0 ? null : this.parentNode.children[i + 1] || null;
  }

  appendChild(node) {
    node.parentNode = this;
    this.children.push(node);
    return node;
  }

  insertBefore(node, ref) {
    node.parentNode = this;
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) this.children.push(node);
    else this.children.splice(i, 0, node);
    return node;
  }

  remove() {
    if (!this.parentNode) return;
    const i = this.parentNode.children.indexOf(this);
    if (i >= 0) this.parentNode.children.splice(i, 1);
    this.parentNode = null;
  }

  setAttribute(key, value) {
    this.attributes[key] = String(value);
  }

  getAttribute(key) {
    return Object.prototype.hasOwnProperty.call(this.attributes, key) ? this.attributes[key] : null;
  }

  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }

  focus() {}
  setSelectionRange() {}

  get textContent() {
    if (!this.children.length) return String(this._text || '');
    return this.children.map((c) => c.textContent).join('');
  }

  set textContent(value) {
    this.children = [];
    this._text = value === undefined || value === null ? '' : String(value);
  }

  querySelector(sel) {
    let found = null;
    const parts = String(sel).trim().split(/\s+/);
    walk(this, (node) => {
      if (!found && matchesChain(node, parts)) found = node;
    });
    return found;
  }

  querySelectorAll(sel) {
    const out = [];
    const parts = String(sel).trim().split(/\s+/);
    walk(this, (node) => {
      if (matchesChain(node, parts)) out.push(node);
    });
    return out;
  }
}

function createDocument() {
  const doc = new DomNode('#document');
  doc.createElement = (tag) => new DomNode(tag);
  doc.createTextNode = (text) => {
    const node = new DomNode('#text');
    node._text = String(text);
    return node;
  };
  doc.readyState = 'complete';
  doc.addEventListener = () => {};
  doc.querySelector = (sel) => {
    let found = null;
    walk(doc, (node) => {
      if (!found && matchesChain(node, String(sel).trim().split(/\s+/))) found = node;
    });
    return found;
  };
  doc.querySelectorAll = (sel) => {
    const out = [];
    walk(doc, (node) => {
      if (matchesChain(node, String(sel).trim().split(/\s+/))) out.push(node);
    });
    return out;
  };

  const html = new DomNode('html');
  const head = new DomNode('head');
  const body = new DomNode('body');
  doc.appendChild(html);
  html.appendChild(head);
  html.appendChild(body);
  doc.body = body;
  doc.head = head;

  const meta = new DomNode('meta');
  meta.attributes.property = 'og:url';
  meta.attributes.content = 'https://wusitech.github.io/posts/test-post/';
  head.appendChild(meta);

  const article = new DomNode('article');
  const entry = new DomNode('div');
  entry.className = 'article-entry';
  article.appendChild(entry);
  body.appendChild(article);

  return doc;
}

/* ------------------------------------------------------------------ */
/* 事件 / 查询辅助                                                     */
/* ------------------------------------------------------------------ */

function fire(node, type, event) {
  const ev = event || { preventDefault() {} };
  const list = (node && node.listeners[type]) || [];
  for (const fn of list) fn(ev);
}

function findAll(root, predicate) {
  const out = [];
  walk(root, (node) => {
    if (predicate(node)) out.push(node);
  });
  return out;
}

function byClass(root, cls) {
  return findAll(root, (n) => String(n.className || '').split(/\s+/).includes(cls));
}

function text(node) {
  return node ? node.textContent : '';
}

/* ------------------------------------------------------------------ */
/* 加载 comments.js 的沙箱                                             */
/* ------------------------------------------------------------------ */

function makeResponse(json) {
  return {
    ok: true,
    status: 200,
    headers: { get() { return null; } },
    json: () => Promise.resolve(json),
    text: () => Promise.resolve(JSON.stringify(json)),
  };
}

function loadComments(options) {
  const doc = createDocument();
  const calls = [];
  const postResponse = options.postResponse || {
    ok: true,
    mode: 'direct',
    pending: false,
    id: 'c_new_1',
    message: '评论已提交，约 1 分钟后显示',
  };

  const fetchImpl = (url, init) => {
    const u = String(url);
    calls.push({ url: u, init: init || {} });
    if (u.indexOf('?config=1') >= 0) {
      return Promise.resolve(makeResponse({ ok: true, mode: 'direct', pending: false }));
    }
    const method = (init && init.method) || 'GET';
    if (method === 'POST') return Promise.resolve(makeResponse(postResponse));
    return Promise.resolve(makeResponse(options.data));
  };

  const location = {
    href: 'https://wusitech.github.io/posts/test-post/',
    host: 'wusitech.github.io',
    hostname: 'wusitech.github.io',
    pathname: '/posts/test-post/',
    search: '',
  };

  const sandbox = {
    document: doc,
    location,
    fetch: fetchImpl,
    setTimeout,
    clearTimeout,
    Date,
    Math,
    JSON,
    String,
    Number,
    Array,
    Object,
    RegExp,
    Error,
    isNaN,
    URL,
    console,
    encodeURIComponent,
    decodeURIComponent,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.GIT_COMMENTS_ENDPOINT = 'https://wstk.pages.dev/api/comment';
  sandbox.GIT_COMMENTS_DATA_BASE = 'https://wstk.pages.dev';

  vm.runInNewContext(SRC, sandbox, { filename: 'static/js/comments.js' });

  return {
    doc,
    calls,
    section: doc.querySelector('#git-comments'),
    postCalls: () => calls.filter((c) => (c.init.method || 'GET') === 'POST' && c.url.indexOf('?config=1') < 0),
    form: () => doc.querySelector('#git-comments form'),
    bodyInput: () => doc.querySelector('#git-comments textarea'),
    replyBar: () => doc.querySelector('#git-comments .gc-reply-bar'),
    names: () =>
      byClass(doc, 'gc-name').map((n) => n.textContent),
    items: () => byClass(doc, 'gc-item'),
    msg: () => doc.querySelector('#git-comments .gc-msg'),
    count: () => doc.querySelector('#git-comments .gc-count'),
    async flush() {
      for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
    },
  };
}

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  → ' + detail : ''}`);
}

function comment(o) {
  return {
    id: o.id,
    replyTo: o.replyTo || '',
    name: o.name,
    email: '',
    website: '',
    body: o.body || '',
    ts: o.ts,
    ua: '',
    hidden: o.hidden === true,
    author: o.author === true,
  };
}

/* ------------------------------------------------------------------ */
/* 1) 渲染：嵌套 / 排序 / 隐藏 / 计数                                  */
/* ------------------------------------------------------------------ */
{
  const data = {
    slug: 'posts/test-post',
    comments: [
      comment({ id: 'c_a', name: '甲', body: '第一条', ts: '2026-10-01T00:00:00.000Z' }),
      comment({ id: 'c_b', replyTo: 'c_a', name: '乙', body: '回复甲', ts: '2026-10-01T01:00:00.000Z' }),
      comment({ id: 'c_c', name: '丙', body: '第二条', ts: '2026-10-01T02:00:00.000Z', author: true }),
      comment({ id: 'c_h', name: '隐藏的', body: '不该出现', ts: '2026-10-01T03:00:00.000Z', hidden: true }),
    ],
  };

  const env = loadComments({ data });
  await env.flush();

  const names = env.names();
  check(
    '1a. 线程渲染：最新主评论在前，回复紧跟它自己的主评论',
    names.join(',') === '丙,甲,乙',
    `渲染顺序=${names.join(',')}`,
  );

  const items = env.items();
  const replyItem = items.find((n) => text(n).indexOf('乙') >= 0);
  check(
    '1b. 回复项带 gc-reply-item 类、有缩进和 ↑ 标记',
    !!replyItem &&
      String(replyItem.className).indexOf('gc-reply-item') >= 0 &&
      replyItem.style.marginLeft === '18px' &&
      text(replyItem.querySelector('.gc-head')).indexOf('\u2191') >= 0,
    replyItem ? `class="${replyItem.className}" margin=${replyItem.style.marginLeft}` : '没找到回复项',
  );

  check(
    '1c. 回复项显示「回复 @被回复人」',
    !!replyItem && text(replyItem).indexOf('回复 @甲') >= 0,
    replyItem ? text(replyItem.querySelector('.gc-head')) : '',
  );

  check(
    '1d. hidden=true 的评论不渲染',
    names.indexOf('隐藏的') < 0,
    `names=${names.join(',')}`,
  );

  check('1e. 计数只算可见评论', /共 3 条/.test(text(env.count())), text(env.count()));

  check(
    '1f. 博主评论带「博主」徽章',
    !!(env.items().find((n) => text(n).indexOf('丙') >= 0) || {}).querySelector &&
      byClass(env.section, 'gc-badge').some((b) => b.textContent === '博主'),
    byClass(env.section, 'gc-badge').map((b) => b.textContent).join(','),
  );

  check(
    '1g. 数据源：同域 /comments/<slug>.json 与跨域两份都请求（主来源失败会回退）',
    env.calls.some((c) => c.url.indexOf('/comments/posts/test-post.json') >= 0),
    env.calls.map((c) => c.url.split('?')[0]).join(' | '),
  );
}

/* ------------------------------------------------------------------ */
/* 2) 点「回复」→ 提交：payload 必须带 replyTo（v15 核心修复）          */
/* ------------------------------------------------------------------ */
{
  const data = {
    slug: 'posts/test-post',
    comments: [
      comment({ id: 'c_a', name: '甲', body: '第一条', ts: '2026-10-01T00:00:00.000Z' }),
      comment({ id: 'c_b', replyTo: 'c_a', name: '乙', body: '回复甲', ts: '2026-10-01T01:00:00.000Z' }),
    ],
  };

  const env = loadComments({ data });
  await env.flush();

  // 找到「甲」那条上的回复按钮
  const items = env.items();
  const itemA = items.find((n) => text(n.querySelector('.gc-name')) === '甲');
  const replyBtnA = itemA && itemA.querySelector('.gc-reply-btn');
  check('2a. 每条评论都有「回复」按钮', !!replyBtnA);

  fire(replyBtnA, 'click');

  check(
    '2b. 点回复后正文自动填「@甲 」',
    env.bodyInput().value === '@甲 ',
    JSON.stringify(env.bodyInput().value),
  );
  check(
    '2c. 点回复后出现「正在回复 @甲」状态条（可取消）',
    env.replyBar().style.display === '' && text(env.replyBar()).indexOf('正在回复 @甲') >= 0,
    text(env.replyBar()),
  );

  // 用户继续输入并提交
  env.bodyInput().value = '@甲 我也想知道';
  const nameInput = findAll(env.form(), (n) => n.name === 'name')[0];
  nameInput.value = '测试访客';
  fire(env.form(), 'submit');
  await env.flush();

  const call = env.postCalls()[0];
  let payload = null;
  try {
    payload = JSON.parse(call.init.body);
  } catch {
    payload = null;
  }
  check(
    '2d. 提交请求体里带 replyTo=被回复评论 id（这是嵌套关系能存下来的关键）',
    !!payload && payload.replyTo === 'c_a',
    payload ? `replyTo=${JSON.stringify(payload.replyTo)}` : '没有 POST 请求',
  );
  check(
    '2e. 其余字段照常提交（slug/name/body/hp）',
    !!payload &&
      payload.slug === 'posts/test-post' &&
      payload.name === '测试访客' &&
      payload.body === '@甲 我也想知道' &&
      payload.hp === '',
    payload ? JSON.stringify({ slug: payload.slug, name: payload.name, hp: payload.hp }) : '',
  );
  check(
    '2f. 提交成功后清空正文、隐藏回复状态条',
    env.bodyInput().value === '' && env.replyBar().style.display === 'none',
    `value=${JSON.stringify(env.bodyInput().value)} bar=${env.replyBar().style.display}`,
  );
  check(
    '2g. 提交成功后显示后端返回的提示文案',
    /评论已提交/.test(text(env.msg())),
    text(env.msg()),
  );
}

/* ------------------------------------------------------------------ */
/* 3) @ 前缀：换目标不堆叠、取消能清掉、不误删用户内容                  */
/* ------------------------------------------------------------------ */
{
  const data = {
    slug: 'posts/test-post',
    comments: [
      comment({ id: 'c_a', name: '甲', body: '第一条', ts: '2026-10-01T00:00:00.000Z' }),
      comment({ id: 'c_c', name: '丙', body: '第二条', ts: '2026-10-01T01:00:00.000Z' }),
    ],
  };
  const env = loadComments({ data });
  await env.flush();
  const items = env.items();
  const replyOf = (name) => items.find((n) => text(n.querySelector('.gc-name')) === name).querySelector('.gc-reply-btn');

  fire(replyOf('甲'), 'click');
  check('3a. 第一次回复：@甲 ', env.bodyInput().value === '@甲 ', JSON.stringify(env.bodyInput().value));

  // 用户打了半句话，然后改主意去回复另一条
  env.bodyInput().value = '@甲 我想说的事';
  fire(replyOf('丙'), 'click');
  check(
    '3b. 换回复目标：旧的 @甲 前缀被替换成 @丙，不会堆成 @丙 @甲',
    env.bodyInput().value === '@丙 我想说的事',
    JSON.stringify(env.bodyInput().value),
  );

  // 再点回甲，仍然只有一个前缀
  fire(replyOf('甲'), 'click');
  check(
    '3c. 反复换目标：正文里始终只有一个 @昵称 前缀',
    env.bodyInput().value === '@甲 我想说的事' &&
      env.bodyInput().value.split('@').length === 2,
    JSON.stringify(env.bodyInput().value),
  );

  // 取消回复：前缀去掉，用户正文保留
  const cancel = byClass(env.replyBar(), 'gc-reply-cancel')[0];
  fire(cancel, 'click');
  check(
    '3d. 取消回复：只去掉自动加的 @前缀，用户自己写的内容保留',
    env.bodyInput().value === '我想说的事' && env.replyBar().style.display === 'none',
    JSON.stringify(env.bodyInput().value),
  );

  // 不点回复直接提交：replyTo 应该是空字符串
  env.bodyInput().value = '普通评论';
  const nameInput = findAll(env.form(), (n) => n.name === 'name')[0];
  nameInput.value = '路人';
  fire(env.form(), 'submit');
  await env.flush();
  const payload = JSON.parse(env.postCalls()[0].init.body);
  check(
    '3e. 不回复任何人时 replyTo 是空字符串（顶层评论）',
    payload.replyTo === '',
    JSON.stringify(payload.replyTo),
  );
}

/* ------------------------------------------------------------------ */
/* 4) 分页：以线程为单位，第 1 页 10 条、第 2 页剩下                 */
/* ------------------------------------------------------------------ */
{
  const comments = [];
  for (let i = 0; i < 12; i++) {
    comments.push(
      comment({
        id: 'c_' + i,
        name: '用户' + i,
        body: '第 ' + i + ' 条',
        ts: '2026-10-01T00:' + String(i).padStart(2, '0') + ':00.000Z',
      }),
    );
  }
  // 给第 0 条挂一个回复：分页不能把回复和主评论拆开
  comments.push(
    comment({ id: 'c_reply', replyTo: 'c_0', name: '回复者', body: '回复第 0 条', ts: '2026-10-01T01:00:00.000Z' }),
  );

  const env = loadComments({ data: { slug: 'posts/test-post', comments } });
  await env.flush();
  const page1 = env.items().length;
  const pager = env.section.querySelector('.gc-pager');
  check(
    '4a. 12 个线程分 2 页：第 1 页是最新的 10 个线程',
    page1 === 10 && !!pager,
    `第 1 页条目=${page1} pager=${!!pager}`,
  );
  check(
    '4b. 分页条显示「第 1 / 2 页」',
    !!pager && /第 1 \/ 2 页/.test(text(pager)),
    pager ? text(pager) : '',
  );

  const nextBtn = findAll(pager, (n) => n.tagName === 'BUTTON' && n.textContent === '下一页')[0];
  fire(nextBtn, 'click');
  await env.flush();
  const page2 = env.items().length;
  const pager2 = env.section.querySelector('.gc-pager');
  const page2Text = page2 > 0 ? text(env.items()[0].parentNode) : '';
  check(
    '4c. 第 2 页：剩下的 2 个线程 = 3 项（第 0 条 + 它的回复 + 第 1 条），回复没被拆到上一页',
    page2 === 3 && /第 2 \/ 2 页/.test(text(pager2)),
    `第 2 页条目=${page2} pager=${text(pager2)}`,
  );
  check(
    '4d. 分页切换后没有重复叠出第二个分页条',
    env.section.querySelectorAll('.gc-pager').length === 1,
    `pager 数量=${env.section.querySelectorAll('.gc-pager').length}`,
  );
}

/* ------------------------------------------------------------------ */
/* 5) 没有评论 / 全部隐藏：显示空状态，不报错                          */
/* ------------------------------------------------------------------ */
{
  const env = loadComments({ data: { slug: 'posts/test-post', comments: [] } });
  await env.flush();
  check(
    '5a. 没有评论时显示「还没有评论」并计数 0',
    /还没有评论/.test(text(env.section)) && /共 0 条/.test(text(env.count())),
    text(env.count()),
  );

  const env2 = loadComments({
    data: {
      slug: 'posts/test-post',
      comments: [comment({ id: 'c_h', name: '隐藏', body: 'x', ts: '2026-10-01T00:00:00.000Z', hidden: true })],
    },
  });
  await env2.flush();
  check(
    '5b. 全部隐藏时也显示「还没有评论」（数据没丢，只是不渲染）',
    /还没有评论/.test(text(env2.section)) && /共 0 条/.test(text(env2.count())),
    text(env2.count()),
  );
}

/* ------------------------------------------------------------------ */
/* 6) 提交失败：保留输入、显示错误                                     */
/* ------------------------------------------------------------------ */
{
  const env = loadComments({
    data: { slug: 'posts/test-post', comments: [] },
    postResponse: { ok: false, error: '提交到 GitHub 失败：GitHub 读取现有评论文件 失败（HTTP 401）：Bad credentials' },
  });
  await env.flush();
  const nameInput = findAll(env.form(), (n) => n.name === 'name')[0];
  nameInput.value = '测试';
  env.bodyInput().value = '要保留的内容';
  fire(env.form(), 'submit');
  await env.flush();
  check(
    '6a. 提交失败：显示后端错误、正文不清空（方便直接重试）',
    /401|Bad credentials/.test(text(env.msg())) && env.bodyInput().value === '要保留的内容',
    `msg=${text(env.msg())} value=${JSON.stringify(env.bodyInput().value)}`,
  );
}

const failed = results.filter((r) => !r.pass);
console.log(`\nRESULT: ${failed.length === 0 ? 'ALL PASS' : failed.length + ' FAILED'}  (${results.length} 项)`);
process.exit(failed.length === 0 ? 0 : 1);
