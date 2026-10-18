/* ==========================================================================
   wusi-site.js —— 站点级定制脚本（从 config/_default/params.yml 的 injector.body_end 拆出）

   加载位置：injector.body_end，defer；三段脚本按原顺序合并，执行顺序不变。

   内容：
     1) Fancybox 灯箱初始化（jQuery / fancybox 已在前面同步加载完）；
     2) 侧栏头像立即加载：主题输出的是 lazyload（没有 src），要等 lazysizes 跑完才显示，
        这里在 DOM 解析完就补上 src 和 .lazyloaded；
     3) 评论系统按页加载：只在 /posts/ /about/ /friend/ /download/ 且页面有 .article-entry 时
        追加 /js/comments.js（详见 docs/评论系统（Git存储）.md）。
   ========================================================================== */

/* ===== 1) Fancybox 灯箱初始化 ===== */
document.addEventListener('DOMContentLoaded', function () {
  if (window.jQuery && jQuery.fn.fancybox) {
    jQuery('[data-fancybox="gallery"]').fancybox({
      buttons: ["zoom", "close"]
    });
  }
});

/* ===== 2) 侧栏头像立即加载 ===== */
(function () {
  var imgs = document.querySelectorAll(".sidebar-author img.lazyload[data-src]");
  for (var i = 0; i < imgs.length; i++) {
    var img = imgs[i];
    if (img.getAttribute("src")) continue;
    img.setAttribute("src", img.getAttribute("data-src"));
    img.setAttribute("loading", "eager");
    img.classList.remove("lazyload");
    img.classList.add("lazyloaded");
  }
})();

/* ===== 3) 评论系统按页加载 ===== */
(function(){var _p=location.pathname;if(!(_p.indexOf("/posts/")===0||_p.indexOf("/about/")===0||_p.indexOf("/friend/")===0||_p.indexOf("/download/")===0))return;var a=document.querySelector(".article-entry");if(!a)return;var s=document.createElement("script");s.src="/js/comments.js?v=15";s.defer=true;document.body.appendChild(s);})();
