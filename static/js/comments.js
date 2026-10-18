'use strict';
/**
 * 自建评论系统前端（原生 JS，无依赖）
 * ----------------------------------------------------------------------------
 * 版本：v15（2026-10-18）
 *   - 修复「点回复后提交的评论没有带 replyTo」——这会让所有回复都变成顶层评论，
 *     嵌套关系（父子指针）永远存不进仓库。这是本版最重要的一处修复。
 *   - 修复连点两条评论的「回复」时正文里 @昵称 前缀越堆越多
 *   - 修复分页按钮描边用了不存在的 CSS 变量（--gc-border）
 *   - 提交成功后（direct + 不需审核）按新评论 id 轮询，构建部署完成会自动刷新并提示
 *   - 回复状态条：显示「正在回复 @XX」并可一键取消
 *
 * 「读」：取静态文件 /comments/<slug>.json（由 Hugo 从 static/comments/ 发布）。
 *        读取顺序是**同源优先、跨域回落**：先读自己域名下的那份（github.io 随 push 构建、最新），
 *        取不到再回落 https://wstk.pages.dev 的那份（详见下面 GC_DATA_BASE 的注释）。
 * 「写」：POST 到 Cloudflare Pages Function /api/comment，
 *        由它调用 GitHub API 把评论写进仓库（默认 COMMENT_MODE=direct + COMMENT_PENDING=true，
 *        即「直接入库 + 默认隐藏」，站长在后台放行后才会出现在页面上）
 *
 * GitHub Pages 那边只能托管静态文件、跑不了 Functions，所以提交地址写死到
 * Cloudflare 域名，同时允许用 window.GIT_COMMENTS_ENDPOINT 覆盖（本地调试用）。
 *
 * 如果页面上已经存在主题内置的评论区（#comments 且里面有内容），
 * 本脚本就什么都不做 —— 否则会出现两套评论区同时显示。
 */
(function () {
  var DEFAULT_ENDPOINT = 'https://wstk.pages.dev/api/comment';
  var MAX_NAME = 40;
  var MAX_BODY = 2000;

  /**
   * 跨域回落的数据源（默认 Cloudflare 域名）
   * ------------------------------------------------------------------
   * 同一份代码部署在两个域名上（Cloudflare Pages 的 wstk.pages.dev 和 GitHub Pages 的
   * wusitech.github.io），两边各自构建、先后必然不一致（wstk 只在定时任务里构建，最多滞后 2 小时）。
   * 所以列表按「同源优先、跨域回落」读：
   *   1) 先读当前域名下的 /comments/<slug>.json —— github.io 随 push 构建，通常最新；
   *   2) 同源失败（404 / 跨域被拦 / JSON 坏了）再读 `${GC_DATA_BASE}/comments/<slug>.json`。
   * 这样两个域名都不会因为对方没构建完而把评论显示成「没有了」。
   *
   * 跨域读要对方允许：static/_headers 里给 /comments/* 加了
   * `Access-Control-Allow-Origin: *`（Cloudflare Pages 会在构建产物根目录读这个文件；
   * GitHub Pages 会忽略它，没有任何副作用）。
   *
   * 本机预览（hugo server / wrangler pages dev）想固定读本地那份数据，就在引入本脚本**之前**加一行：
   *   window.GIT_COMMENTS_DATA_BASE = 'http://localhost:1313';
   * （写成页面里的内联脚本，或直接在浏览器控制台执行后刷新。）
   */
  const GC_DATA_BASE =
    (typeof window !== 'undefined' && window.GIT_COMMENTS_DATA_BASE) || 'https://wstk.pages.dev';

  /** 当前页面是不是就在数据源域名上（是的话同域读，省一次跨域） */
  function onDataHost() {
    try {
      return new URL(GC_DATA_BASE, location.href).host === location.host;
    } catch (e) {
      return false;
    }
  }

  /* ---------------------------------------------------------------- */
  /* 定位当前文章                                                      */
  /* ---------------------------------------------------------------- */

  function normalizeSlug(raw) {
    var s = String(raw || '');
    // 去掉查询串与锚点
    s = s.replace(/[?#].*$/, '');
    // 去掉协议与域名部分（如果传进来的是完整 URL）
    s = s.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]*/, '');
    // 去掉首尾斜杠
    s = s.replace(/^\/+/, '').replace(/\/+$/, '');
    // 折叠连续斜杠
    s = s.replace(/\/{2,}/g, '/');
    // index.html / index 结尾也去掉
    s = s.replace(/\/?index\.html?$/i, '');
    // 只保留安全字符
    s = s.replace(/[^A-Za-z0-9._/-]/g, '');
    return s.replace(/^\/+/, '').replace(/\/+$/, '');
  }

  function currentSlug() {
    // 优先用 og:url：主题的固定链接经过 canonical 处理，比 location.pathname 准
    var meta = document.querySelector('meta[property="og:url"]');
    var fromMeta = '';
    if (meta && meta.getAttribute('content')) {
      try {
        fromMeta = normalizeSlug(new URL(meta.getAttribute('content'), location.href).pathname);
      } catch (e) {
        fromMeta = '';
      }
    }
    if (fromMeta) return fromMeta;
    return normalizeSlug(location.pathname);
  }

  /* ---------------------------------------------------------------- */
  /* 样式                                                              */
  /* ---------------------------------------------------------------- */

  var CSS = [
    '#git-comments{--gc-accent:#e06c75;--gc-fg:#4a4a4a;--gc-muted:#8a8a8a;',
    '--gc-bg:#faf7f7;--gc-line:rgba(0,0,0,.1);--gc-radius:12px;',
    'box-sizing:border-box;margin:32px auto 0;padding:20px 22px;max-width:100%;',
    'background:var(--gc-bg);border:1px solid var(--gc-line);border-radius:var(--gc-radius);',
    'color:var(--gc-fg);font-size:14px;line-height:1.75}',
    'html[data-theme="dark"] #git-comments{--gc-fg:#c9c9c9;--gc-muted:#8c8c8c;',
    '--gc-bg:#2b2b2b;--gc-line:rgba(255,255,255,.12)}',
    '#git-comments *{box-sizing:border-box}',
    '#git-comments .gc-title{margin:0 0 14px;font-size:1.05em;font-weight:600;color:var(--gc-accent)}',
    '#git-comments .gc-count{color:var(--gc-muted);font-weight:400;font-size:.9em}',
    '#git-comments .gc-list{list-style:none;margin:0 0 20px;padding:0}',
    '#git-comments .gc-item{padding:12px 0;border-top:1px dashed var(--gc-line)}',
    '#git-comments .gc-item:first-child{border-top:0}',
    '#git-comments .gc-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px}',
    '#git-comments .gc-name{font-weight:600}',
    '#git-comments .gc-badge{flex:none;background:var(--gc-accent);color:#fff;',
    'border-radius:4px;padding:1px 6px;font-size:.75em;line-height:1.5;font-weight:400}',
    '#git-comments .gc-time{color:var(--gc-muted);font-size:.85em}',
    '#git-comments .gc-replying{color:var(--gc-muted);font-size:.82em;margin-left:6px}',
    '#git-comments .gc-reply-bar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;',
    'color:var(--gc-muted);font-size:.88em}',
    '#git-comments .gc-reply-cancel{background:none;border:0;padding:0;color:var(--gc-accent);',
    'cursor:pointer;font-size:.9em}',
    '#git-comments .gc-reply-cancel:hover{text-decoration:underline}',
    '#git-comments .gc-reply-item{border-left:2px solid var(--gc-line);padding-left:12px}',
    '#git-comments .gc-reply-btn{margin-left:8px;background:none;border:0;padding:0;color:var(--gc-accent);cursor:pointer;font-size:.82em}',
    '#git-comments .gc-reply-btn:hover{text-decoration:underline}',
    '#git-comments .gc-up{color:var(--gc-accent);font-weight:600}',
    '#git-comments .gc-pager{display:flex;gap:10px;align-items:center;justify-content:center;margin-top:14px}',
    '#git-comments .gc-pager button{padding:4px 12px;border-radius:6px;border:1px solid var(--gc-line);background:transparent;color:inherit;cursor:pointer}',
    '#git-comments .gc-pager button:disabled{opacity:.4;cursor:default}',
    '#git-comments .gc-site{color:var(--gc-accent);font-size:.85em;text-decoration:none}',
    '#git-comments .gc-body{margin-top:6px;white-space:pre-wrap;word-break:break-word}',
    '#git-comments .gc-empty{color:var(--gc-muted);margin:0 0 18px}',
    '#git-comments .gc-form{display:flex;flex-direction:column;gap:10px}',
    '#git-comments .gc-row{display:flex;flex-wrap:wrap;gap:10px}',
    '#git-comments .gc-row input{flex:1 1 180px;min-width:0}',
    '#git-comments input,#git-comments textarea{width:100%;padding:8px 10px;',
    'border:1px solid var(--gc-line);border-radius:8px;background:transparent;',
    'color:inherit;font:inherit;outline:none}',
    '#git-comments input:focus,#git-comments textarea:focus{border-color:var(--gc-accent)}',
    '#git-comments textarea{min-height:96px;resize:vertical}',
    '#git-comments .gc-actions{display:flex;flex-wrap:wrap;align-items:center;gap:12px}',
    '#git-comments .gc-submit{padding:8px 20px;border:0;border-radius:8px;cursor:pointer;',
    'background:var(--gc-accent);color:#fff;font:inherit}',
    '#git-comments .gc-submit[disabled]{opacity:.6;cursor:default}',
    '#git-comments .gc-msg{font-size:.9em}',
    '#git-comments .gc-msg.is-ok{color:#3a9d5d}',
    '#git-comments .gc-msg.is-err{color:var(--gc-accent)}',
    '#git-comments .gc-hp{position:absolute;left:-9999px;top:-9999px;width:1px;height:1px;',
    'overflow:hidden;tab-size:0}',
    '#git-comments .gc-hp-hint{position:absolute;left:-9999px;top:-9999px;width:1px;height:1px;overflow:hidden}',
    '#git-comments .gc-tip{color:var(--gc-muted);font-size:.85em}',
  ].join('\n');

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  /* ---------------------------------------------------------------- */
  /* 渲染                                                              */
  /* ---------------------------------------------------------------- */

  function formatTime(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso || '');
    try {
      return d.toLocaleString();
    } catch (e) {
      return d.toISOString();
    }
  }

  /* ---- 回复功能：扁平存储 + replyTo 父子指针 → 递归渲染成任意深度 ---- */
  var replyToId = '';
  var replyToName = '';
  // 点「回复」时自动塞进正文开头的「@昵称 」。换回复目标/取消/提交成功时要精确去掉这一段，
  // 不能简单去掉所有 "@xxx"，否则会把用户自己打的内容也删了。
  var mentionPrefix = '';
  var gcPage = 1;

  /** 正文输入框（回复时要把 @昵称 塞进同一个 textarea） */
  function gcBodyInput() {
    return document.querySelector('#git-comments textarea');
  }

  /** 回复状态条（「正在回复 @XX 取消」） */
  function gcReplyBar() {
    return document.querySelector('#git-comments .gc-reply-bar');
  }

  /** 去掉上一次自动加的 @昵称 前缀（只认我们自己加的那一段） */
  function gcStripMention() {
    var ta = gcBodyInput();
    if (ta && mentionPrefix && ta.value.indexOf(mentionPrefix) === 0) {
      ta.value = ta.value.slice(mentionPrefix.length);
    }
    mentionPrefix = '';
  }

  /**
   * 点某条评论的「回复」：
   *   1) 记住被回复评论的 id（提交时放进 payload.replyTo，后端据此建立父子关系）
   *   2) 把「@昵称 」塞到正文最前面（可以继续编辑，也可以删掉）
   *   3) 显示回复状态条，让用户知道自己在回复谁
   * 之前这里只改了输入框文字、提交时却没把 replyTo 发给后端 —— 所以回复永远存成顶层评论。
   */
  function gcStartReply(c) {
    var id = String((c && c.id) || '');
    if (!id) { return; }
    gcStripMention();
    replyToId = id;
    replyToName = String((c && c.name) || '匿名');
    mentionPrefix = '@' + replyToName + ' ';
    var ta = gcBodyInput();
    if (ta) {
      ta.value = mentionPrefix + ta.value;
      try { ta.focus(); } catch (e) { /* 老浏览器忽略 */ }
      try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch (e) { /* 同上 */ }
    }
    var bar = gcReplyBar();
    if (bar) {
      bar.style.display = '';
      var label = bar.querySelector('.gc-reply-bar-text');
      if (label) { label.textContent = '正在回复 @' + replyToName; }
    }
  }

  /** 取消回复：清目标 + 清掉自动加的 @ 前缀 */
  function gcCancelReply() {
    gcStripMention();
    replyToId = '';
    replyToName = '';
    var bar = gcReplyBar();
    if (bar) { bar.style.display = 'none'; }
  }

  function gcNode(c, depth, byId) {
    var li = el('li', depth > 0 ? 'gc-item gc-reply-item' : 'gc-item');
    if (depth > 0) { li.style.marginLeft = (Math.min(depth, 4) * 18) + 'px'; }
    var head = el('div', 'gc-head');
    head.appendChild(el('span', 'gc-name', String(c.name || '匿名')));
    if (c.author === true) { head.appendChild(el('span', 'gc-badge', '博主')); }
    head.appendChild(el('span', 'gc-time', formatTime(c.ts)));
    var parent = c.replyTo && byId[c.replyTo];
    if (parent) { head.appendChild(el('span', 'gc-replying', '回复 @' + String(parent.name || '匿名'))); }
    var btn = el('button', 'gc-reply-btn', '回复');
    btn.type = 'button';
    btn.addEventListener('click', function () { gcStartReply(c); });
    head.appendChild(btn);
    li.appendChild(head);
    li.appendChild(el('div', 'gc-body', String(c.body || '')));
    return li;
  }

  /* 线程 + 分页渲染（gcNode 之上的唯一实现） */
  function renderListPatched(listNode, comments) {
    /* 线程 + 分页渲染
     *   - 线程 = 主评论 + 它的所有回复（递归）；回复永远紧跟主评论
     *   - 线程内：主评论在前，回复按时间从旧到新
     *   - 线程之间：按主评论时间从新到旧（所以第 1 页是最新的一批）
     *   - 分页以「线程」为单位，绝不把回复和它的主评论拆到两页
     *   - 回复的头部加一个 ↑，表示「回复上面的评论」
     */
    var PAGE_SIZE = 10;
    if (!gcPage) { gcPage = 1; }
    var all = (comments || []).filter(function (c) { return c && c.hidden !== true; });
    var byId = {};
    all.forEach(function (c) { if (c.id) { byId[c.id] = c; } });
    var kids = {};
    all.forEach(function (c) {
      var p = (c.replyTo && byId[c.replyTo]) ? c.replyTo : '__root__';
      (kids[p] = kids[p] || []).push(c);
    });
    function ms(s) { var d = new Date(s); return isNaN(d.getTime()) ? 0 : d.getTime(); }
    Object.keys(kids).forEach(function (k) {
      kids[k].sort(function (a, b) { return ms(a.ts) - ms(b.ts); });
    });
    var roots = (kids['__root__'] || []).slice().sort(function (a, b) { return ms(b.ts) - ms(a.ts); });
    var threads = roots.map(function (r) {
      var arr = [];
      (function walk(c, depth) {
        arr.push({ c: c, depth: depth });
        (kids[c.id] || []).forEach(function (x) { walk(x, depth + 1); });
      })(r, 0);
      return arr;
    });
    var pages = Math.max(1, Math.ceil(threads.length / PAGE_SIZE));
    if (gcPage > pages) { gcPage = pages; }
    var start = (gcPage - 1) * PAGE_SIZE;
    listNode.textContent = '';
    threads.slice(start, start + PAGE_SIZE).forEach(function (thread) {
      thread.forEach(function (item) {
        var li = gcNode(item.c, item.depth, byId);
        if (item.depth > 0) {
          var head = li.querySelector('.gc-head');
          if (head) {
            var up = document.createElement('span');
            up.className = 'gc-up';
            up.textContent = '\u2191 ';
            head.insertBefore(up, head.firstChild);
          }
        }
        listNode.appendChild(li);
      });
    });
    var host = listNode.parentNode;
    var bar = host ? host.querySelector('.gc-pager') : null;
    if (bar) { bar.remove(); }
    if (pages > 1 && host) {
      bar = document.createElement('div');
      bar.className = 'gc-pager';
      var prev = document.createElement('button');
      prev.type = 'button'; prev.textContent = '上一页';
      prev.disabled = gcPage <= 1;
      prev.addEventListener('click', function () { gcPage = Math.max(1, gcPage - 1); renderList(listNode, comments); });
      var info = document.createElement('span');
      info.className = 'gc-pager-info';
      info.textContent = '第 ' + gcPage + ' / ' + pages + ' 页';
      var next = document.createElement('button');
      next.type = 'button'; next.textContent = '下一页';
      next.disabled = gcPage >= pages;
      next.addEventListener('click', function () { gcPage = Math.min(pages, gcPage + 1); renderList(listNode, comments); });
      bar.appendChild(prev); bar.appendChild(info); bar.appendChild(next);
      host.appendChild(bar);
    }
  }
  function renderList(listNode, comments) { renderListPatched(listNode, comments); }

  function build(endpoint, slug) {
    var section = document.createElement('section');
    section.id = 'git-comments';

    var style = document.createElement('style');
    style.textContent = CSS;
    section.appendChild(style);

    var title = el('h2', 'gc-title');
    title.appendChild(document.createTextNode('评论'));
    var count = el('span', 'gc-count', '');
    title.appendChild(document.createTextNode(' '));
    title.appendChild(count);
    section.appendChild(title);

    var listNode = el('ul', 'gc-list');
    var empty = el('p', 'gc-empty', '还没有评论，来抢沙发吧～');
    section.appendChild(empty);
    section.appendChild(listNode);

    var form = document.createElement('form');
    form.className = 'gc-form';

    var row = el('div', 'gc-row');
    var nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.name = 'name';
    nameInput.maxLength = MAX_NAME;
    nameInput.placeholder = '昵称（必填，最多 ' + MAX_NAME + ' 字）';
    nameInput.required = true;
    nameInput.autocomplete = 'nickname';
    var emailInput = document.createElement('input');
    emailInput.type = 'email';
    emailInput.name = 'email';
    emailInput.maxLength = 200;
    emailInput.placeholder = '邮箱（选填，会随评论一起公开）';
    emailInput.autocomplete = 'email';
    var siteInput = document.createElement('input');
    siteInput.type = 'url';
    siteInput.name = 'website';
    siteInput.maxLength = 200;
    siteInput.placeholder = '网址（选填，http(s)://）';
    siteInput.autocomplete = 'url';
    row.appendChild(nameInput);
    row.appendChild(emailInput);
    row.appendChild(siteInput);
    form.appendChild(row);

    // 蜜罐：正常访客看不见、也不会 Tab 到；机器人填了后端就当成功但不入库
    var hp = document.createElement('input');
    hp.type = 'text';
    hp.name = 'hp';
    hp.className = 'gc-hp';
    hp.tabIndex = -1;
    hp.autocomplete = 'off';
    hp.setAttribute('aria-hidden', 'true');
    form.appendChild(hp);
    var hpHint = el('span', 'gc-hp-hint', '如果能看到这一行，请保持这个输入框为空，不要填写。');
    form.appendChild(hpHint);

    var bodyInput = document.createElement('textarea');
    bodyInput.name = 'body';
    bodyInput.className = 'gc-body-input';
    bodyInput.maxLength = MAX_BODY;
    bodyInput.placeholder = '说点什么吧（纯文本，最多 ' + MAX_BODY + ' 字）';
    bodyInput.required = true;
    form.appendChild(bodyInput);

    // 回复状态条：点了某条评论的「回复」后出现，显示「正在回复 @XX」并允许取消
    var replyBar = el('div', 'gc-reply-bar', '');
    replyBar.style.display = 'none';
    var replyBarText = el('span', 'gc-reply-bar-text', '');
    var replyCancel = el('button', 'gc-reply-cancel', '取消回复');
    replyCancel.type = 'button';
    replyCancel.addEventListener('click', gcCancelReply);
    replyBar.appendChild(replyBarText);
    replyBar.appendChild(replyCancel);
    form.appendChild(replyBar);

    var actions = el('div', 'gc-actions');
    var submit = el('button', 'gc-submit', '发表评论');
    submit.type = 'submit';
    var msg = el('span', 'gc-msg', '');
    actions.appendChild(submit);
    actions.appendChild(msg);
    form.appendChild(actions);

    var tip = el('p', 'gc-tip', '提交后即可显示（可能需要等一次构建）');
  // 向接口查询当前是否开启审核，据此切换提示文案
  (function () {
    var api = endpoint.replace(/\/+$/, '');
    fetch(api + '?config=1', { cache: 'no-cache' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
      if (!j || !j.ok) { return; }
      if (j.mode === 'pr') { tip.textContent = '评论会先进入待合并状态，站长合并后显示'; }
      else if (j.pending) { tip.textContent = '评论提交后需站长审核，通过后才会显示在这里'; }
      else { tip.textContent = '提交后约一分钟（会触发一次构建）就会显示在这里'; }
      if (location.hostname && location.hostname.indexOf('pages.dev') >= 0) { tip.textContent = '提交后最晚 2 小时（等一次定时构建）就会显示在这里，详见页底'; }
    }).catch(function () {});
  })();
    form.appendChild(tip);

    section.appendChild(form);

    function showMsg(text, isError) {
      msg.textContent = text;
      msg.className = 'gc-msg ' + (isError ? 'is-err' : 'is-ok');
    }

    /* 提交成功后「确认真的显示了」：
     *   direct + 不需审核时，评论已经写进仓库，但页面读的 JSON 要等一次构建部署才更新。
     *   这里按后端返回的新评论 id 定时重拉列表，出现后自动刷新并提示；
     *   在 wstk.pages.dev 上（只有在定时任务里才构建）轮询没意义，直接不轮询。
     */
    var expectId = '';
    var pollTimers = [];

    function clearPolls() {
      for (var i = 0; i < pollTimers.length; i++) { clearTimeout(pollTimers[i]); }
      pollTimers = [];
    }

    function startConfirmPoll(id) {
      clearPolls();
      expectId = String(id);
      var delays = [15000, 45000, 90000, 150000];
      delays.forEach(function (ms) {
        pollTimers.push(setTimeout(function () { load(); }, ms));
      });
    }

    /** 取一份评论 JSON；非 200（404 / 403 / 5xx）一律当失败，交给调用方换来源重试 */
    function fetchJson(url) {
      // 加时间戳绕过两层缓存：GitHub Pages 对静态文件约 10 分钟的缓存、以及 Service Worker 的缓存。
    // 否则刚发布的评论要等缓存过期才出现（数据其实早就构建好了）。
    var bust = url + (url.indexOf('?') < 0 ? '?' : '&') + 't=' + Date.now();
    return fetch(bust, { cache: 'no-store' }).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      });
    }

    function load() {
      var sameOrigin = '/comments/' + slug + '.json';
      var crossOrigin = GC_DATA_BASE + '/comments/' + slug + '.json';
      // 各站优先读自己同域的评论文件（github.io 随 push 构建、最新；wstk 随定时构建），
      // 同域取不到（404/异常）才跨域回退到另一个站点。之前固定跨域读 wstk，
      // 会让 github.io 一直显示 wstk 那份可能滞后两小时的旧数据。
      var primary = sameOrigin;
      var fallback = crossOrigin;

      fetchJson(primary)
        // 主来源失败（跨域被拦、那边还没部署、JSON 坏了……）→ 换另一个来源再试一次
        .catch(function () {
          return fetchJson(fallback);
        })
        .then(function (data) {
          var all = data && Array.isArray(data.comments) ? data.comments : [];
          // 后台标记为「隐藏」的评论不渲染，但数据仍然留在 JSON 里（可随时恢复）
          var comments = all.filter(function (c) {
            return !(c && c.hidden === true);
          });
          // 旧到新
          comments.sort(function (a, b) {
            return String((a && a.ts) || '').localeCompare(String((b && b.ts) || ''));
          });
          if (comments.length) {
            renderList(listNode, comments);
            listNode.style.display = '';
            empty.style.display = 'none';
          } else {
            // 可能本来就没人评论，也可能全被隐藏了 —— 两种都按「还没有评论」显示
            listNode.style.display = 'none';
            empty.style.display = '';
            empty.textContent = '还没有评论，来抢沙发吧～';
          }
          // 计数只看过滤后真正渲染出来的条数
          count.textContent = '（共 ' + comments.length + ' 条）';
          // 提交成功后等构建：如果这条新评论已经出现在 JSON 里，就提示用户并停止轮询
          if (expectId) {
            var found = false;
            for (var i = 0; i < all.length; i++) {
              if (all[i] && String(all[i].id || '') === expectId) { found = true; break; }
            }
            if (found) {
              expectId = '';
              clearPolls();
              showMsg('评论已显示在下方', false);
            }
          }
        })
        .catch(function () {
          // 两个来源都失败：这篇文章还没人评论（或 JSON 坏了），按「还没有评论」处理
          listNode.style.display = 'none';
          empty.style.display = '';
          empty.textContent = '还没有评论，来抢沙发吧～';
          count.textContent = '（共 0 条）';
        });
    }

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      if (submit.disabled) return;

      var payload = {
        slug: slug,
        name: nameInput.value,
        email: emailInput.value,
        website: siteInput.value,
        body: bodyInput.value,
        hp: hp.value,
        // 关键：把被回复评论的 id 一起提交，后端据此建立父子关系（嵌套回复靠它）
        replyTo: replyToId,
      };

      submit.disabled = true;
      var oldText = submit.textContent;
      submit.textContent = '提交中…';
      showMsg('', false);

      fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
        .then(function (res) {
          return res
            .json()
            .catch(function () {
              return {};
            })
            .then(function (data) {
              return { res: res, data: data };
            });
        })
        .then(function (out) {
          if (out.res.ok && out.data && out.data.ok) {
            var data = out.data || {};
            var onPagesDev = location.hostname && location.hostname.indexOf('pages.dev') >= 0;
            var okMsg = data.message || '评论已提交';
            // 提交成功的提示也按站点区分：wstk 要等定时构建，措辞与提示文案保持一致
            if (onPagesDev) {
              okMsg = '评论已提交，最晚 2 小时后显示（想立即看到可去 wusitech.github.io）';
            }
            showMsg(okMsg, false);
            // 清空正文并退出回复状态（自动加的「@昵称 」前缀也会一并去掉）
            bodyInput.value = '';
            gcCancelReply();
            // 提交成功后自动确认评论真的出现了：
            //   - wstk.pages.dev 只在定时任务里构建，2 小时内不会出现在 JSON 里，轮询没意义
            //   - 其它域名（github.io）push 即构建，通常 1~2 分钟，按 id 轮询确认后刷新
            if (data.mode === 'direct' && data.pending === false && !onPagesDev && data.id) {
              startConfirmPoll(data.id);
            }
          } else {
            var text = (out.data && out.data.error) || '提交失败（HTTP ' + out.res.status + '）';
            showMsg(text, true);
            // 失败时保留输入内容，方便直接重试
          }
        })
        .catch(function () {
          showMsg('网络错误，没能连上评论服务，请稍后再试', true);
        })
        .then(function () {
          submit.disabled = false;
          submit.textContent = oldText;
        });
    });

    return { section: section, load: load };
  }

  /* ---------------------------------------------------------------- */
  /* 插入页面                                                          */
  /* ---------------------------------------------------------------- */

  /** 主题内置评论区里已经有东西了就别再插一套 */
  function themeCommentsExist() {
    var box = document.querySelector('#comments');
    if (!box) return false;
    if (box.querySelector('.comment, .comment-item, .vcomment, .tk-comments, iframe')) return true;
    return box.textContent.trim().length > 0;
  }

  function insert(node) {
    var entry = document.querySelector('.article-entry');
    if (entry && entry.parentNode) {
      entry.parentNode.insertBefore(node, entry.nextSibling);
      return;
    }
    var article = document.querySelector('article');
    if (article) {
      article.appendChild(node);
      return;
    }
    var main = document.querySelector('#main');
    if (main) {
      main.appendChild(node);
      return;
    }
    document.body.appendChild(node);
  }

  function start() {
    if (themeCommentsExist()) return;

    var slug = currentSlug();
    if (!slug) return;

    var endpoint = window.GIT_COMMENTS_ENDPOINT || DEFAULT_ENDPOINT;
    var built = build(endpoint, slug);
    insert(built.section);
    built.load();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  // 供调试用
  window.GitComments = { slug: currentSlug, reload: start };
})();
