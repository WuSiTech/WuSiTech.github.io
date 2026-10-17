/* 页底构建状态：用 GitHub API 取两个工作流最近一次运行的状态，渲染成 GitHub 界面那种小图标：
 *   绿勾 = 成功 / 红叉 = 失败 / 褐色空心圈 = 进行中或排队
 * 特性：纯异步（在 window.load 之后才请求）、结果缓存 10 分钟、失败就保持原徽章图不动。
 * 图标是内联 SVG（无外部资源），点击仍跳到对应 Actions 页面。
 */
'use strict';
(function () {
  var REPO = 'WuSiTech/WuSiTech.github.io';
  var WORKFLOWS = {
    'hugo.yaml': { name: 'Build and deploy', url: 'https://github.com/' + REPO + '/actions/workflows/hugo.yaml' },
    'tools.yml': { name: 'Tools and config checks', url: 'https://github.com/' + REPO + '/actions/workflows/tools.yml' }
  };
  var CACHE_KEY = 'wusi-ci-status-v1';
  var CACHE_MS = 10 * 60 * 1000;

  function svg(state) {
    if (state === 'success') return '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="#1a7f37" d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"/></svg>';
    if (state === 'failure') return '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="#cf222e" d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z"/></svg>';
    return '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="#9a6700" stroke-width="2"/></svg>';
  }

  function stateOf(run) {
    if (!run) return 'unknown';
    if (run.status === 'completed') {
      if (run.conclusion === 'success') return 'success';
      if (run.conclusion === 'failure' || run.conclusion === 'timed_out' || run.conclusion === 'cancelled') return 'failure';
      return 'unknown';
    }
    return 'running';
  }

  function render(map) {
    var wrap = document.querySelector('.wusi-badges');
    if (!wrap) return;
    var imgs = wrap.querySelectorAll('img');
    Array.prototype.forEach.call(imgs, function (img) {
      var src = img.getAttribute('src') || '';
      var key = null;
      for (var k in WORKFLOWS) { if (src.indexOf(k) >= 0) key = k; }
      if (!key) return;
      var st = stateOf(map[key]);
      if (st === 'unknown') return;
      var span = document.createElement('span');
      span.style.cssText = 'display:inline-flex;align-items:center;gap:5px;font-size:13px;line-height:1;vertical-align:middle';
      span.innerHTML = svg(st) + '<span>' + WORKFLOWS[key].name + '</span>';
      img.parentNode.replaceChild(span, img);
      if (img.parentNode && img.parentNode.tagName === 'A') return;
    });
  }

  function fetchAll(done) {
    var keys = Object.keys(WORKFLOWS);
    var out = {}, n = 0;
    keys.forEach(function (k) {
      fetch('https://api.github.com/repos/' + REPO + '/actions/workflows/' + k + '/runs?per_page=1', {
        headers: { 'Accept': 'application/vnd.github+json' }
      }).then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) { out[k] = j && j.workflow_runs && j.workflow_runs[0]; })
        .catch(function () { out[k] = null; })
        .then(function () { if (++n === keys.length) done(out); });
    });
  }

  function start() {
    var wrap = document.querySelector('.wusi-badges');
    if (!wrap) return;
    var cached = null;
    try { cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch (e) {}
    if (cached && cached.t && Date.now() - cached.t < CACHE_MS && cached.runs) { render(cached.runs); return; }
    fetchAll(function (runs) {
      render(runs);
      try { localStorage.setItem(CACHE_KEY, JSON.stringify({ t: Date.now(), runs: runs })); } catch (e) {}
    });
  }

  if (document.readyState === 'complete') start(); else window.addEventListener('load', start);
})();