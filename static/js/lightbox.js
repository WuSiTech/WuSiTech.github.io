/* 轻量图片灯箱：替代 jQuery + fancybox（约 2 KB，无依赖）
 * 用法保持不变：任何带 data-fancybox="gallery" 的 <a href="图片"> 都会被接管，
 * 同一组 gallery 内支持左右切换、Esc/点背景关闭、键盘左右键切换。
 */
'use strict';
(function () {
  var CSS = ".lb-mask{position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.88);display:none;align-items:center;justify-content:center}" +
    ".lb-mask.on{display:flex}" +
    ".lb-img{max-width:92vw;max-height:88vh;box-shadow:0 10px 40px rgba(0,0,0,.5);border-radius:4px}" +
    ".lb-btn{position:absolute;background:rgba(255,255,255,.14);border:0;color:#fff;font-size:26px;line-height:1;cursor:pointer;border-radius:50%;width:44px;height:44px}" +
    ".lb-btn:hover{background:rgba(255,255,255,.28)}" +
    ".lb-close{top:18px;right:18px}.lb-prev{left:18px;top:50%;margin-top:-22px}.lb-next{right:18px;top:50%;margin-top:-22px}" +
    "@media print{.lb-mask{display:none!important}}";
  var groups = {};
  function links(a) {
    var g = a.getAttribute('data-fancybox') || 'default';
    var all = document.querySelectorAll('a[data-fancybox="' + g + '"]');
    return Array.prototype.slice.call(all);
  }
  function build() {
    if (document.querySelector('.lb-mask')) return;
    var st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    var mask = document.createElement('div'); mask.className = 'lb-mask';
    mask.innerHTML = '<img class="lb-img" alt=""><button class="lb-btn lb-close" aria-label="关闭">×</button><button class="lb-btn lb-prev" aria-label="上一张">‹</button><button class="lb-btn lb-next" aria-label="下一张">›</button>';
    document.body.appendChild(mask);
    var img = mask.querySelector('.lb-img');
    var cur = [], idx = 0;
    function show(i) {
      if (!cur.length) return;
      idx = (i + cur.length) % cur.length;
      img.src = cur[idx].getAttribute('href');
      mask.classList.add('on');
    }
    function close() { mask.classList.remove('on'); img.removeAttribute('src'); }
    mask.addEventListener('click', function (e) {
      if (e.target === mask) return close();
      if (e.target.classList.contains('lb-close')) return close();
      if (e.target.classList.contains('lb-prev')) return show(idx - 1);
      if (e.target.classList.contains('lb-next')) return show(idx + 1);
    });
    document.addEventListener('keydown', function (e) {
      if (!mask.classList.contains('on')) return;
      if (e.key === 'Escape') close();
      if (e.key === 'ArrowLeft') show(idx - 1);
      if (e.key === 'ArrowRight') show(idx + 1);
    });
    document.addEventListener('click', function (e) {
      var a = e.target.closest ? e.target.closest('a[data-fancybox]') : null;
      if (!a || !a.getAttribute('href')) return;
      e.preventDefault();
      cur = links(a);
      show(cur.indexOf(a));
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build); else build();
})();