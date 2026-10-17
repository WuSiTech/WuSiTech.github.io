/* 加载页「少女祈祷中…」超时提示
 * 若启动 5 秒后加载页仍然存在（即首屏还没加载完），在文字后面回车追加：
 *   如若卡顿请点击 这里（另一个站点）QAQ
 * 链接指向"另一个站点"：github.io 上指向 wstk，wstk 上指向 github.io。
 * 加载正常（5 秒内已完成）时什么也不做，零干扰。
 */
(function () {
  var onCf = location.hostname && location.hostname.indexOf('pages.dev') >= 0;
  var other = onCf
    ? { url: 'https://wusitech.github.io/', name: 'wusitech.github.io' }
    : { url: 'https://wstk.pages.dev/', name: 'wstk.pages.dev' };

  function appendTip() {
    var loader = document.getElementById('loader');
    if (!loader) { return; }
    if (loader.classList.contains('loading')) { return; } // 已经隐藏 = 加载完了
    var word = loader.querySelector('.loading-word');
    if (!word || word.getAttribute('data-tip') === '1') { return; }
    word.setAttribute('data-tip', '1');
    var tip = document.createElement('div');
    tip.style.cssText = 'margin-top:10px;font-size:.72em;opacity:.85;line-height:1.8';
    tip.appendChild(document.createTextNode('如若卡顿请点击 '));
    var a = document.createElement('a');
    a.href = other.url;
    a.textContent = '这里';
    a.style.cssText = 'color:inherit;text-decoration:underline;cursor:pointer';
    a.target = '_blank';
    a.rel = 'noopener';
    tip.appendChild(a);
    tip.appendChild(document.createTextNode(' QAQ'));
    word.appendChild(tip);
  }

  setTimeout(appendTip, 5000);
})();