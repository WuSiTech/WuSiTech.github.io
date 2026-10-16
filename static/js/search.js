/* ---------------------------------------------------------------------------
 * 站内本地搜索（零外部请求）
 *
 * 原理：
 *   1. 构建时由 layouts/index.json 生成 /index.json（标题、链接、摘要、标签、日期）；
 *   2. 本脚本把搜索入口插进主题 header 的右上角（#sub-nav，和主题自己用 JS 追加的
 *      暗色模式按钮并排），点击打开覆盖层；
 *   3. 输入关键词后，在本地索引里做加权匹配（标题 > 标签 > 摘要），实时显示结果；
 *   4. 结果点击跳转文章；Esc 或点遮罩关闭。
 *
 * 不请求任何外部资源（索引是同域静态文件），符合本站「运行时不请求外部资源」约束。
 * 注意：脚本自己建 DOM。入口优先插 #sub-nav（主题改版删掉它时才退回右下角圆钮），
 *      面板配色用主题 CSS 变量，深色模式自动跟随。
 * -------------------------------------------------------------------------- */
'use strict';

(function () {
  var INDEX_URL = '/index.json';
  var state = { loaded: false, items: [], open: false };

  var CSS = [
    // 入口：插进主题 header 的 #sub-nav（右上角，与主题的暗色模式按钮并排）
    '.ss-nav-btn{background:none;border:0;margin:0;padding:20px 15px;line-height:0;cursor:pointer;',
    'color:var(--red-0,#e06c75);opacity:.8;transition:transform .2s,opacity .2s;display:inline-block;vertical-align:middle}',
    '.ss-nav-btn:hover{opacity:1;transform:scale(1.1)}',
    'html[data-theme="dark"] .ss-nav-btn{color:var(--red-2,#e06c75)}',
    '.ss-nav-btn svg{width:15px;height:15px;display:block;fill:currentColor}',
    // 兜底：主题若没有 #sub-nav，才用左下角圆钮（右下角会与主题「回到顶部」重叠）
    '.ss-btn{position:fixed;right:30px;bottom:90px;z-index:990;width:44px;height:44px;border:none;border-radius:50%;background:#fff;',
    'cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.22);',
    'box-shadow:0 2px 10px rgba(0,0,0,.22);transition:transform .15s ease}',
    '.ss-btn:hover{transform:scale(1.06)}',
    // 遮罩 + 面板：配色走主题变量，深色模式自动跟随
    '.ss-btn::before{content:'';display:block;width:24px;height:24px;margin:10px auto 0;background:#ff5252;-webkit-mask:url(/images/search-icon.webp) center/contain no-repeat;mask:url(/images/search-icon.webp) center/contain no-repeat}',
    '[data-theme=dark] .ss-btn{background:#000}',
    '.ss-mask{position:fixed;inset:0;z-index:995;background:rgba(0,0,0,.45);display:none}',
    '.ss-mask.ss-on{display:block}',
    '.ss-panel{position:fixed;z-index:996;left:50%;top:10vh;transform:translateX(-50%);width:min(680px,92vw);max-height:72vh;',
    'background:var(--color-wrap,#fff);color:var(--grey-7,#333);border-radius:8px;box-shadow:0 12px 40px rgba(0,0,0,.28);',
    'display:flex;flex-direction:column;overflow:hidden}',
    '.ss-input{width:100%;box-sizing:border-box;border:none;border-bottom:1px solid var(--color-h2-border,rgba(0,0,0,.1));outline:none;',
    'padding:16px 44px 16px 18px;font-size:16px;background:transparent;color:inherit;font-family:inherit}',
    // 关掉浏览器给 input[type=search] 画的蓝色原生清除按钮，换成主题红色的关闭按钮
    '.ss-input::-webkit-search-cancel-button{-webkit-appearance:none;appearance:none}',
    '.ss-close{position:absolute;top:10px;right:12px;width:30px;height:30px;padding:0;line-height:28px;text-align:center;',
    'border:0;border-radius:50%;background:transparent;color:var(--red-2,#e06c75);font-size:16px;cursor:pointer}',
    '.ss-close:hover{background:var(--color-code-background,rgba(224,108,117,.12))}',
    '.ss-list{list-style:none;margin:0;padding:6px 0 10px;overflow-y:auto;-webkit-overflow-scrolling:touch}',
    '.ss-item{padding:10px 18px;cursor:pointer;border-left:3px solid transparent;outline:none}',
    '.ss-item:hover,.ss-item.ss-cur{background:var(--color-code-background,rgba(224,108,117,.1));border-left-color:var(--red-1,#e06c75)}',
    '.ss-title{font-size:15px;font-weight:600;margin-bottom:2px;color:var(--red-1,#e06c75)}',
    '.ss-sum{font-size:12.5px;opacity:.72;line-height:1.5;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}',
    '.ss-meta{font-size:12px;opacity:.6;margin-top:8px;padding:0 18px;color:var(--grey-9,#888)}',
    '.ss-empty{padding:18px;font-size:14px;opacity:.6}',
    '@media print{.ss-btn,.ss-nav-btn,.ss-mask,.ss-panel{display:none!important}}'
  ].join('');

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function loadIndex(cb) {
    if (state.loaded) return cb();
    fetch(INDEX_URL, { cache: 'no-cache' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (data) {
        state.items = Array.isArray(data) ? data.filter(function (x) { return x && x.url && x.title; }) : [];
        state.loaded = true;
        cb();
      })
      .catch(function (e) {
        state.items = [];
        state.loaded = true;
        if (window.console) console.warn('[search] 索引加载失败：' + e.message);
        cb();
      });
  }

  function score(item, terms) {
    var t = (item.title || '').toLowerCase();
    var s = (item.summary || '').toLowerCase();
    var tags = (item.tags || []).join(' ').toLowerCase();
    var total = 0;
    for (var i = 0; i < terms.length; i++) {
      var w = terms[i];
      if (!w) continue;
      var hit = 0;
      if (t.indexOf(w) >= 0) hit += 60;
      if (tags.indexOf(w) >= 0) hit += 25;
      if (s.indexOf(w) >= 0) hit += 10;
      if (hit === 0) return 0; // 所有词都要至少命中一次
      total += hit;
    }
    return total;
  }

  function build() {
    var style = el('style'); style.textContent = CSS; document.head.appendChild(style);

    // 入口优先放进主题 header 的 #sub-nav（右上角，与主题的暗色模式按钮并排）；
    // 主题结构变了（没有 #sub-nav）才退回右下角固定圆钮，功能不受影响。
    var nav = document.getElementById('sub-nav');
    var btn = nav ? el('button', 'ss-nav-btn') : el('button', 'ss-btn', '🔍');
    if (nav) {
      btn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
        '<path d="M10 2a8 8 0 1 0 4.9 14.3l5.4 5.4 1.4-1.4-5.4-5.4A8 8 0 0 0 10 2zm0 2a6 6 0 1 1 0 12 6 6 0 0 1 0-12z"/></svg>';
    }
    btn.type = 'button';
    btn.title = '搜索（本站内）';
    btn.setAttribute('aria-label', '站内搜索');
    (nav || document.body).appendChild(btn);

    var mask = el('div', 'ss-mask');
    var panel = el('div', 'ss-panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-label', '站内搜索');
    var input = el('input', 'ss-input');
    input.type = 'search';
    input.placeholder = '输入关键词搜索本站文章…（Esc 关闭）';
    var list = el('ul', 'ss-list');
    var meta = el('div', 'ss-meta', '');
    meta.setAttribute('role', 'status');
    var closeBtn = el('button', 'ss-close', '✕');
    closeBtn.type = 'button';
    closeBtn.title = '关闭（Esc）';
    closeBtn.setAttribute('aria-label', '关闭搜索');
    panel.appendChild(input); panel.appendChild(list); panel.appendChild(meta); panel.appendChild(closeBtn);
    mask.appendChild(panel);
    document.body.appendChild(mask);

    function render() {
      var q = input.value.trim().toLowerCase();
      var terms = q ? q.split(/\s+/).filter(Boolean) : [];
      list.textContent = '';
      if (!terms.length) {
        meta.textContent = '共 ' + state.items.length + ' 篇文章';
        return;
      }
      var scored = [];
      for (var i = 0; i < state.items.length; i++) {
        var sc = score(state.items[i], terms);
        if (sc > 0) scored.push({ s: sc, it: state.items[i] });
      }
      scored.sort(function (a, b) { return b.s - a.s; });
      var top = scored.slice(0, 30);
      meta.textContent = top.length ? ('命中 ' + scored.length + ' 篇，显示前 ' + top.length + ' 篇') : '';
      if (!top.length) {
        list.appendChild(el('li', 'ss-empty', '没有找到匹配的文章，换个关键词试试。'));
        return;
      }
      top.forEach(function (x) {
        var li = el('li', 'ss-item');
        li.appendChild(el('div', 'ss-title', x.it.title));
        if (x.it.summary) li.appendChild(el('div', 'ss-sum', x.it.summary));
        li.tabIndex = 0;
        li.addEventListener('click', function () { location.href = x.it.url; });
        li.addEventListener('keydown', function (e) { if (e.key === 'Enter') location.href = x.it.url; });
        list.appendChild(li);
      });
    }

    function open() {
      state.open = true;
      mask.classList.add('ss-on');
      loadIndex(function () { render(); input.focus(); });
    }
    function close() {
      state.open = false;
      mask.classList.remove('ss-on');
    }

    btn.addEventListener('click', function () { state.open ? close() : open(); });
    closeBtn.addEventListener('click', function () { close(); btn.focus(); });
    mask.addEventListener('click', function (e) { if (e.target === mask) close(); });
    input.addEventListener('input', render);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && state.open) close();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build);
  } else {
    build();
  }
})();
