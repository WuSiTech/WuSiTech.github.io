/* ==========================================================================
   全站随机固定背景 —— 站点级扩展脚本（不改 themes/）
   样式：static/css/wusi-bg.css
   页面数据：layouts/partials/head/init.html 注入 window.__WUSI_BG__
             （banner = 当前页 front matter 的 banner/cover；remote = 远端图源；local = 本地兜底）

   行为（按优先级）：
     1. 当前页有 banner/cover → 直接用主题已经渲染好的 #header 头图当整屏固定背景
        （样式表把那张图 position:fixed 铺满视口，一图两用，不会重复下载）；
        这里只负责"图挂了就退回随机背景"和状态上报；
     2. 没有 banner → 从远端图源里随机取一张，异步探测（不阻塞首屏）；
     3. 远端 300ms 还没好 → 先铺一张本地图池的兜底图，远端成功后淡入覆盖，
        失败/超时（4s）则保留本地兜底图；
     4. 所有图都失败 → 只留主题底色，页面依然正常。

   为什么这样写：背景层必须 position:fixed 且 z-index 低于 #wrap（见 wusi-bg.css 注释）；
   探测用 new Image()，图片下载不阻塞 HTML/CSS/字体，首屏不会被背景拖慢。

   调试参数（仅调试用，正常访问不带）：
     ?wusi_bg=local   强制走本地兜底
     ?wusi_bg=remote  强制走远端
     ?wusi_bg=fail    模拟远端失败（验证回落到本地）
   ========================================================================== */
(function () {
  "use strict";

  var cfg = window.__WUSI_BG__;
  if (!cfg) {
    return;
  }

  var REMOTE_TIMEOUT = 4000; // 远端图探测超时（毫秒）→ 判定失败、保留本地兜底
  var LOCAL_DELAY = 300; // 远端这么久还没结果，就先铺本地兜底，避免一直空着

  var remote = Array.isArray(cfg.remote) ? cfg.remote : [];
  var local = Array.isArray(cfg.local) ? cfg.local : [];
  var banner = typeof cfg.banner === "string" ? cfg.banner : "";
  var mode = "";
  try {
    mode = new URLSearchParams(location.search).get("wusi_bg") || "";
  } catch (e) {
    mode = "";
  }

  // 调试/自动化验证用状态对象：settled 变成 true 表示"最终背景已经定下来了"
  var state = { settled: false, source: null, image: null, mode: mode || "auto" };
  window.__wusiBg = state;

  var host = null;
  var layerMain = null; // 上层：banner / 远端图
  var layerFallback = null; // 下层：本地兜底图

  function pick(list) {
    return list && list.length ? list[Math.floor(Math.random() * list.length)] : null;
  }

  // 尽量不连续两次抽到同一张（用 sessionStorage 记上一张）
  function pickFresh(list) {
    if (!list || !list.length) {
      return null;
    }
    var last = null;
    try {
      last = sessionStorage.getItem("wusi_bg_last");
    } catch (e) {}
    var pool = list;
    if (last && list.length > 1) {
      pool = list.filter(function (url) {
        return url !== last;
      });
    }
    var url = pick(pool);
    try {
      if (url) {
        sessionStorage.setItem("wusi_bg_last", url);
      }
    } catch (e) {}
    return url;
  }

  function ensureHost() {
    if (host || !document.body) {
      return host;
    }
    host = document.createElement("div");
    host.id = "wusi-bg";
    host.setAttribute("aria-hidden", "true");
    layerFallback = document.createElement("div");
    layerFallback.className = "wusi-bg-layer wusi-bg-layer-fallback";
    layerMain = document.createElement("div");
    layerMain.className = "wusi-bg-layer wusi-bg-layer-main";
    host.appendChild(layerFallback);
    host.appendChild(layerMain);
    document.body.insertBefore(host, document.body.firstChild);
    return host;
  }

  function apply(layer, url, cb) {
    if (!layer) {
      if (cb) {
        cb();
      }
      return;
    }
    layer.style.backgroundImage = 'url("' + url + '")';
    // 先设图、下一帧再改 opacity，保证淡入过渡生效；cb 在"已经画上"之后才回调
    requestAnimationFrame(function () {
      layer.classList.add("is-on");
      if (cb) {
        cb();
      }
    });
  }

  // 异步探测一张图：加载成功才真正用（onload），失败回调 false；不做任何阻塞
  function loadImage(url, cb) {
    if (!url) {
      cb(false);
      return;
    }
    var img = new Image();
    img.onload = function () {
      cb(true);
    };
    img.onerror = function () {
      cb(false);
    };
    img.src = url;
  }

  function finish(source, url) {
    state.source = source;
    state.image = url || null;
    state.settled = true;
    document.documentElement.classList.add("wusi-bg-ready");
  }

  // 本地兜底：随机取一张本地图池的图，加载成功就铺上
  function showFallback() {
    ensureHost();
    var url = pickFresh(local);
    if (!url) {
      finish("none", null);
      return;
    }
    loadImage(url, function (ok) {
      if (ok) {
        apply(layerFallback, url, function () {
          finish("local", url);
        });
        return;
      }
      // 抽到的本地图坏了：换一张再试一次
      var next = pick(
        local.filter(function (item) {
          return item !== url;
        })
      );
      if (!next) {
        finish("none", null);
        return;
      }
      loadImage(next, function (ok2) {
        if (ok2) {
          apply(layerFallback, next, function () {
            finish("local", next);
          });
        } else {
          finish("none", null);
        }
      });
    });
  }

  // 探测并应用一张"主图"（远端随机图）；失败/超时交给 onFail
  function tryMain(url, onFail) {
    ensureHost();
    if (!url) {
      onFail();
      return;
    }
    var settled = false;
    var timer = null;
    var localTimer = null;

    // 远端迟迟不来：先垫一张本地图，避免长时间只有底色
    localTimer = setTimeout(function () {
      if (settled) {
        return;
      }
      var fallbackUrl = pickFresh(local);
      if (!fallbackUrl) {
        return;
      }
      loadImage(fallbackUrl, function (ok) {
        if (ok && !settled) {
          apply(layerFallback, fallbackUrl);
        }
      });
    }, LOCAL_DELAY);

    timer = setTimeout(function () {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(localTimer);
      onFail();
    }, REMOTE_TIMEOUT);

    loadImage(url, function (ok) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(localTimer);
      if (ok) {
        apply(layerMain, url, function () {
          finish("remote", url);
        });
      } else {
        onFail();
      }
    });
  }

  // 有 banner 的页面：主题的 #header 头图已经被样式表改成整屏固定背景，
  // 这里只等它加载完（失败则退回随机背景），不额外下载图片。
  function usePageBanner() {
    var imgs = document.querySelectorAll("#header img");
    var img = null;
    for (var i = 0; i < imgs.length; i++) {
      if (imgs[i].getAttribute("src")) {
        img = imgs[i];
        break;
      }
    }
    function ok() {
      // 真的有像素才算成功（404 时 complete 也是 true，但 naturalWidth 是 0）
      if (img && img.naturalWidth > 0) {
        finish("banner", banner);
      } else {
        fail();
      }
    }
    function fail() {
      // banner 挂了：撤掉"整屏头图"类名、藏掉坏图，退回远端随机背景
      document.documentElement.classList.remove("wusi-page-banner");
      if (img) {
        img.style.display = "none";
      }
      ensureHost();
      tryMain(pickFresh(remote), showFallback);
    }
    if (!img) {
      fail();
      return;
    }
    if (img.complete) {
      ok();
      return;
    }
    img.addEventListener("load", ok);
    img.addEventListener("error", fail);
  }

  function start() {
    if (banner && mode !== "local" && mode !== "remote" && mode !== "fail") {
      usePageBanner();
      return;
    }
    if (!ensureHost()) {
      // 理论上不会发生（脚本在 body 末尾），兜底再等一次 DOM
      document.addEventListener("DOMContentLoaded", start, { once: true });
      return;
    }
    if (mode === "local") {
      showFallback();
      return;
    }
    if (mode === "remote") {
      tryMain(pickFresh(remote), showFallback);
      return;
    }
    if (mode === "fail") {
      // 故意指向一个不存在的图，走真实的 onerror → 本地兜底路径
      tryMain("/__wusi_bg_force_fail__.webp", showFallback);
      return;
    }
    tryMain(pickFresh(remote), showFallback);
  }

  start();
})();
