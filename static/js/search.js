/* 站内本地搜索（零外部请求、零首屏开销）
 * 入口：模板 layouts/partials/header.html 里服务端渲染的 <a id="nav-search-btn-local" class="nav-icon">；
 *       用「事件委托」监听，pjax 换页替换 DOM 后依然有效；万一模板没渲染出来，则回退一个右下角圆钮。
 * 数据：构建时由 layouts/index.json 生成 /index.json，只在第一次打开搜索面板时才 fetch。
 * 面板：复用主题搜索弹窗的结构与类名（reimu-popup/reimu-search/reimu-results/reimu-bg），
 *       布局样式因主题仅在 Algolia 启用时才加载，这里自行补齐。
 */
'use strict';

(function () {
  var INDEX_URL = '/index.json';
  var MAG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" width="15" height="15"><circle cx="10.5" cy="10.5" r="6.6"/><path d="M15.6 15.6L21 21"/></svg>';
  var state = { loaded: false, items: [], open: false, built: false };
  var input, list, meta, site;

  var CSS = [
    ".site-search{position:fixed;inset:0;z-index:999;background:rgba(0,0,0,.45)}",
    ".reimu-popup{position:absolute;left:50%;top:10vh;transform:translateX(-50%);width:min(680px,92vw);max-height:72vh;display:flex;flex-direction:column;",
    "background:var(--color-wrap,#fff);color:var(--grey-7,#333);border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.3);overflow:hidden}",
    ".reimu-search{display:flex;align-items:center;gap:8px;padding:14px 44px 14px 16px;border-bottom:1px solid rgba(0,0,0,.08);position:relative;z-index:2}",
    ".reimu-search-input-icon{width:18px;height:18px;flex:0 0 18px;opacity:.6}",
    "#reimu-search-input{flex:1}",
    "#reimu-search-input input{width:100%;border:0;outline:0;background:transparent;font-size:16px;color:inherit;padding:2px 0}",
    ".popup-btn-close{position:absolute;right:12px;top:12px;width:26px;height:26px;border-radius:50%;background:#ff5252;color:#fff;font-size:16px;line-height:26px;text-align:center;cursor:pointer;z-index:3}",
    ".reimu-results{position:relative;z-index:2;overflow-y:auto;padding:6px 0 10px}",
    ".reimu-bg{position:absolute;right:0;bottom:0;max-height:86%;opacity:.28;pointer-events:none;z-index:1}",
    ".reimu-hit{padding:10px 16px;cursor:pointer;border-left:3px solid transparent}",
    ".reimu-hit:hover{background:rgba(224,108,117,.12);border-left-color:#ff5252}",
    ".reimu-hit-title{font-size:15px;font-weight:600;margin-bottom:2px}",
    ".reimu-hit-sum{font-size:12.5px;opacity:.7;line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}",
    ".ss-empty{padding:18px;font-size:14px;opacity:.6}",
    ".ss-meta{padding:8px 16px;font-size:12px;opacity:.6}",
    "html[data-theme=dark] .reimu-popup{background:#2b2b2b;color:#d8d8d8}",
    "@media print{.site-search{display:none!important}}"
  ].join('');

  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }

  function loadIndex(cb) {
    if (state.loaded) return cb();
    fetch(INDEX_URL, { cache: 'no-cache' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) { state.items = Array.isArray(d) ? d.filter(function (x) { return x && x.url && x.title; }) : []; state.loaded = true; cb(); })
      .catch(function () { state.items = []; state.loaded = true; cb(); });
  }

  function score(item, terms) {
    var t = (item.title || '').toLowerCase(), s = (item.summary || '').toLowerCase(), g = (item.tags || []).join(' ').toLowerCase(), total = 0;
    for (var i = 0; i < terms.length; i++) {
      var w = terms[i]; if (!w) continue;
      var hit = 0;
      if (t.indexOf(w) >= 0) hit += 60;
      if (g.indexOf(w) >= 0) hit += 25;
      if (s.indexOf(w) >= 0) hit += 10;
      if (hit === 0) return 0;
      total += hit;
    }
    return total;
  }

  function render() {
    if (!list) return;
    var q = input.value.trim().toLowerCase();
    var terms = q ? q.split(/\s+/).filter(Boolean) : [];
    list.textContent = '';
    if (!terms.length) { meta.textContent = '共 ' + state.items.length + ' 篇文章'; return; }
    var scored = [];
    for (var i = 0; i < state.items.length; i++) { var sc = score(state.items[i], terms); if (sc > 0) scored.push({ s: sc, it: state.items[i] }); }
    scored.sort(function (a, b) { return b.s - a.s; });
    var top = scored.slice(0, 30);
    meta.textContent = top.length ? ('命中 ' + scored.length + ' 篇，显示前 ' + top.length + ' 篇') : '';
    if (!top.length) { list.appendChild(el('li', 'ss-empty', '没有找到匹配的文章，换个关键词试试。')); return; }
    top.forEach(function (x) {
      var li = el('li', 'reimu-hit');
      li.appendChild(el('div', 'reimu-hit-title', x.it.title));
      if (x.it.summary) li.appendChild(el('div', 'reimu-hit-sum', x.it.summary));
      li.addEventListener('click', function () { location.href = x.it.url; });
      list.appendChild(li);
    });
  }

  function build() {
    if (state.built) return;
    state.built = true;
    var st = el('style'); st.textContent = CSS; document.head.appendChild(st);
    site = el('div', 'site-search');
    site.style.display = 'none';
    site.innerHTML = '<div class="reimu-popup popup"><div class="reimu-search"><div class="reimu-search-input-icon"></div><div id="reimu-search-input"></div><div class="popup-btn-close"></div></div><div class="reimu-results"><div id="reimu-stats"></div><div id="reimu-hits"></div></div><img class="reimu-bg" src="/images/reimu.png" alt="" /></div>';
    document.body.appendChild(site);
    input = el('input'); input.type = 'search'; input.placeholder = '搜索…'; input.setAttribute('aria-label', '站内搜索');
    document.getElementById('reimu-search-input').appendChild(input);
    var hits = document.getElementById('reimu-hits');
    meta = el('div', 'ss-meta', ''); list = el('ul'); list.style.cssText = 'list-style:none;margin:0;padding:0';
    hits.appendChild(meta); hits.appendChild(list);
    site.addEventListener('click', function (e) {
      if (e.target === site || (e.target.classList && e.target.classList.contains('popup-btn-close'))) close();
    });
    input.addEventListener('input', render);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && state.open) close(); });
  }

  function open() { build(); state.open = true; site.style.display = 'block'; loadIndex(function () { render(); input.focus(); }); }
  function close() { if (!site) return; state.open = false; site.style.display = 'none'; }

  // 事件委托：模板渲染的按钮、以及 pjax 换页后重建的按钮，都能响应
  document.addEventListener('click', function (e) {
    var t = e.target.closest ? e.target.closest('#nav-search-btn-local, .nav-search-fallback') : null;
    if (!t) return;
    e.preventDefault();
    if (state.open) { close(); } else { open(); }
  });

  // 兜底：万一模板没渲染出按钮（例如主题结构变了），加一个右下角圆钮
  function ensureFallback() {
    if (document.getElementById('nav-search-btn-local')) return;
    if (document.querySelector('.nav-search-fallback')) return;
    var b = el('a', 'nav-icon nav-search-fallback');
    b.setAttribute('href', 'javascript:void(0)');
    b.setAttribute('title', '站内搜索');
    b.innerHTML = MAG;
    b.style.cssText = 'position:fixed;right:30px;bottom:90px;z-index:990;background:#fff;border-radius:50%;width:44px;height:44px;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 10px rgba(0,0,0,.22)';
    document.body.appendChild(b);
  }

  // 把按钮插进页面已有的顶部导航（#sub-nav 优先，其次 #main-nav）；pjax 换页后自动补回。
  function injectButton() {
    if (document.getElementById('nav-search-btn-local')) return true;
    var host = document.getElementById('sub-nav') || document.getElementById('main-nav');
    if (!host) return false;
    var a = document.createElement('a');
    a.id = 'nav-search-btn-local';
    a.className = 'nav-icon';
    a.setAttribute('href', 'javascript:void(0)');
    a.setAttribute('role', 'button');
    a.setAttribute('title', '站内搜索');
    a.setAttribute('aria-label', '站内搜索');
    a.innerHTML = MAG;
    if (host.id === 'main-nav') { a.style.marginLeft = '8px'; }
    host.appendChild(a);
    return true;
  }
  function boot() { injectButton(); ensureFallback(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
  document.addEventListener('pjax:complete', boot);
  document.addEventListener('pjax:end', boot);
})();