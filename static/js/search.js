/* 站内本地搜索（零外部请求）
 * 入口：优先插进主题头部导航右侧（#sub-nav，与暗色模式按钮并排，样式沿用主题图标按钮）；
 *       主题结构变化、找不到 #sub-nav 时，退回右下角固定圆钮（位于「返回顶部」圆钮上方）。
 * 图标：内嵌 SVG 放大镜，颜色用 currentColor（头部继承主题链接色；圆钮里显式为博丽灵梦红）。
 */
'use strict';

(function () {
  var INDEX_URL = '/index.json';
  var MAG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" width="15" height="15"><circle cx="10.5" cy="10.5" r="6.6"/><path d="M15.6 15.6L21 21"/></svg>';
  var CIRCLE_ICON = "url(data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20viewBox=%270%200%2024%2024%27%20fill=%27none%27%20stroke=%27%23ff5252%27%20stroke-width=%272.4%27%20stroke-linecap=%27round%27%3E%3Ccircle%20cx=%2710.5%27%20cy=%2710.5%27%20r=%276.6%27/%3E%3Cpath%20d=%27M15.6%2015.6L21%2021%27/%3E%3C/svg%3E)";
  var state = { loaded: false, items: [], open: false };

  var CSS = [
    ".ss-nav-btn{background:none;border:0;margin:0;padding:20px 15px;line-height:0;cursor:pointer;color:inherit;opacity:.85}",
    ".ss-nav-btn:hover{opacity:1;transform:scale(1.1)}",
    ".ss-nav-btn svg{display:block}",
    ".ss-btn{position:fixed;right:30px;bottom:90px;z-index:990;width:44px;height:44px;border:none;border-radius:50%;",
    "background:#fff;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.22);transition:transform .15s ease}",
    ".ss-btn:hover{transform:scale(1.06)}",
    ".ss-btn::before{content:'';display:block;width:24px;height:24px;margin:6px auto 0;background:" + CIRCLE_ICON + " center/contain no-repeat}",
    "html[data-theme=dark] .ss-btn{background:#000}",
    ".ss-mask{position:fixed;inset:0;z-index:995;background:rgba(0,0,0,.42);display:none}",
    ".ss-mask.ss-on{display:block}",
    ".ss-panel{position:fixed;z-index:996;left:50%;top:12vh;transform:translateX(-50%);width:min(680px,92vw);max-height:70vh;",
    "background:#fff;color:#333;border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.28);display:flex;flex-direction:column;overflow:hidden}",
    ".ss-input{width:100%;box-sizing:border-box;border:none;border-bottom:1px solid rgba(0,0,0,.1);outline:none;",
    "padding:16px 18px;font-size:16px;background:transparent;color:inherit}",
    ".ss-list{list-style:none;margin:0;padding:6px 0 10px;overflow-y:auto}",
    ".ss-item{padding:10px 18px;cursor:pointer;border-left:3px solid transparent}",
    ".ss-item:hover{background:rgba(224,108,117,.1);border-left-color:#ff5252}",
    ".ss-title{font-size:15px;font-weight:600;margin-bottom:2px}",
    ".ss-sum{font-size:12.5px;opacity:.72;line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}",
    ".ss-meta{font-size:12px;opacity:.55;margin-top:8px;padding:0 18px}",
    ".ss-empty{padding:18px;font-size:14px;opacity:.6}",
    "html[data-theme=dark] .ss-panel{background:#2b2b2b;color:#d8d8d8}",
    "html[data-theme=dark] .ss-input{border-bottom-color:rgba(255,255,255,.14)}",
    "@media print{.ss-btn,.ss-nav-btn,.ss-mask,.ss-panel{display:none!important}}"
  ].join('');

  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }

  function loadIndex(cb) {
    if (state.loaded) return cb();
    fetch(INDEX_URL, { cache: 'no-cache' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) { state.items = Array.isArray(d) ? d.filter(function (x) { return x && x.url && x.title; }) : []; state.loaded = true; cb(); })
      .catch(function (e) { state.items = []; state.loaded = true; if (window.console) console.warn('[search] index load failed: ' + e.message); cb(); });
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

  function build() {
    var style = el('style'); style.textContent = CSS; document.head.appendChild(style);

    var nav = document.getElementById('sub-nav');
    var btn;
    if (nav) {
      var proto = nav.querySelector('button') || nav.querySelector('a');
      btn = el('button', proto ? proto.className : 'ss-nav-btn');
      if (proto && proto.getAttribute('style')) btn.setAttribute('style', proto.getAttribute('style'));
      btn.innerHTML = MAG;
    } else {
      btn = el('button', 'ss-btn', '');
    }
    btn.type = 'button';
    btn.title = '站内搜索';
    btn.setAttribute('aria-label', '站内搜索');
    (nav || document.body).appendChild(btn);

    var mask = el('div', 'ss-mask');
    var panel = el('div', 'ss-panel');
    var input = el('input', 'ss-input');
    input.type = 'search';
    input.placeholder = '输入关键词搜索本站文章…（Esc 关闭）';
    var list = el('ul', 'ss-list');
    var meta = el('div', 'ss-meta', '');
    panel.appendChild(input); panel.appendChild(list); panel.appendChild(meta);
    mask.appendChild(panel);
    document.body.appendChild(mask);

    function render() {
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
        var li = el('li', 'ss-item');
        li.appendChild(el('div', 'ss-title', x.it.title));
        if (x.it.summary) li.appendChild(el('div', 'ss-sum', x.it.summary));
        li.addEventListener('click', function () { location.href = x.it.url; });
        list.appendChild(li);
      });
    }

    function open() { state.open = true; mask.classList.add('ss-on'); loadIndex(function () { render(); input.focus(); }); }
    function close() { state.open = false; mask.classList.remove('ss-on'); }

    btn.addEventListener('click', function () { if (state.open) { close(); } else { open(); } });
    mask.addEventListener('click', function (e) { if (e.target === mask) close(); });
    input.addEventListener('input', render);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && state.open) close(); });
  }

  if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', build); } else { build(); }
})();