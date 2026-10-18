/* ==========================================================================
   全站随机固定背景 —— 站点级扩展脚本（不改 themes/）
   样式：static/css/wusi-bg.css
   页面数据：layouts/partials/head/init.html 注入 window.__WUSI_BG__
             （banner = 当前页 front matter **显式写的 banner**，没写就是空；
              remote = 远端图源；local = 本地兜底）

   行为（按优先级）：
     1. 当前页显式写了 banner → 直接用主题已经渲染好的 #header 头图当整屏固定背景
        （样式表把那张图 position:fixed 铺满视口，一图两用，不会重复下载）；
        这里只负责"图挂了就退回随机背景"和状态上报；
     2. 没写 banner（注意：cover 封面不算！）→ 和普通页面一样，从图源里随机取一张；
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
  // 调试用：?bgimg=<url> 强制指定一张背景图（验证头部文字颜色/回退等用）
  var forceImage = "";
  try {
    forceImage = new URLSearchParams(location.search).get("bgimg") || "";
  } catch (e) {
    forceImage = "";
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
    // 广播给同文件的「头部标题自适应颜色」模块去采样亮度
    try {
      document.dispatchEvent(
        new CustomEvent("wusi:bg-settled", { detail: { source: source, url: url || null } })
      );
    } catch (e) {}
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
    if (forceImage) {
      ensureHost();
      tryMain(forceImage, showFallback);
      return;
    }
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

/* ==========================================================================
   鼠标悬停顶部大图区域 → 内容渐渐淡出，方便欣赏背景（行为与 cialloking 一致）：
   进入 #header 后 #content 在 3 秒内 1 → 0.1 → 0 淡出；移出立即恢复（CSS 里有 .2s 过渡）。
   ========================================================================== */
(function () {
  "use strict";
  // 只在有"真正的鼠标"的设备上做悬停淡出：触屏设备 tap 会误触发 mouseenter 且没有 mouseleave
  var canHover =
    !window.matchMedia || window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  if (!canHover) {
    return;
  }
  var header = document.getElementById("header");
  var content = document.getElementById("content");
  if (!header || !content) {
    return;
  }
  var DURATION1 = 1000; // 1 → 0.1 用时
  var DURATION2 = 2000; // 0.1 → 0 用时
  var START = 1;
  var MID = 0.1;
  var END = 0;
  var raf = null;
  var startTime = 0;
  function step(now) {
    var elapsed = now - startTime;
    var opacity;
    if (elapsed < DURATION1) {
      opacity = START + (MID - START) * (elapsed / DURATION1);
    } else if (elapsed < DURATION1 + DURATION2) {
      opacity = MID + (END - MID) * ((elapsed - DURATION1) / DURATION2);
    } else {
      opacity = END;
    }
    content.style.opacity = opacity;
    if (elapsed < DURATION1 + DURATION2) {
      raf = requestAnimationFrame(step);
    }
  }
  function fadeOut() {
    if (raf) {
      cancelAnimationFrame(raf);
    }
    content.style.opacity = START;
    startTime = performance.now();
    raf = requestAnimationFrame(step);
  }
  function restore() {
    if (raf) {
      cancelAnimationFrame(raf);
    }
    content.style.opacity = "1";
  }
  header.addEventListener("mouseenter", fadeOut);
  header.addEventListener("mouseleave", restore);
})();

/* ==========================================================================
   头部标题自适应文字颜色：用 canvas 采样「标题后面那块背景」的平均亮度，
   背景偏黑 → html.wusi-hero-dark（白字），偏亮 → html.wusi-hero-light（黑字）。
   · 远端图源带 Access-Control-Allow-Origin: *，加 crossOrigin 后能读像素；
   · 读不到（没给 CORS / 图加载失败）就保持默认的「白字 + 深阴影」，不报错；
   · 图片按 background-size: cover 映射到视口，采样区域 = 标题文字大致所在的位置。
   ========================================================================== */
(function () {
  "use strict";
  var THRESHOLD = 0.55;
  var timer = null;
  function currentUrl() {
    var st = window.__wusiBg || {};
    if (document.documentElement.classList.contains("wusi-page-banner")) {
      var img = document.querySelector("#header img");
      if (img && img.getAttribute("src")) {
        return img.src;
      }
    }
    return st.image || null;
  }
  function setTheme(lum) {
    var html = document.documentElement;
    var light = lum > THRESHOLD;
    html.classList.toggle("wusi-hero-light", light);
    html.classList.toggle("wusi-hero-dark", !light);
    window.__wusiHeroLum = Math.round(lum * 100) / 100;
  }
  function sample(url) {
    if (!url) {
      return;
    }
    var img = new Image();
    var sameOrigin = url.indexOf("//") === -1 || url.indexOf(location.origin) === 0;
    if (!sameOrigin) {
      img.crossOrigin = "anonymous";
    }
    img.onload = function () {
      try {
        var vw = document.documentElement.clientWidth || window.innerWidth;
        var vh = document.documentElement.clientHeight || window.innerHeight;
        var header = document.getElementById("header");
        var heroH = header ? header.getBoundingClientRect().height : Math.min(vh, 400);
        // 标题大致区域（视口坐标）：中间 50% 宽、header 垂直中段
        var rx = vw * 0.25;
        var ry = heroH * 0.28;
        var rw = vw * 0.5;
        var rh = heroH * 0.44;
        var iw = img.naturalWidth;
        var ih = img.naturalHeight;
        if (!iw || !ih) {
          return;
        }
        // cover 映射：图片按 max(vw/iw, vh/ih) 缩放后居中，再换算成图片坐标
        var scale = Math.max(vw / iw, vh / ih);
        var ox = (vw - iw * scale) / 2;
        var oy = (vh - ih * scale) / 2;
        var sx = (rx - ox) / scale;
        var sy = (ry - oy) / scale;
        var sw = rw / scale;
        var sh = rh / scale;
        sx = Math.max(0, Math.min(sx, iw - 1));
        sy = Math.max(0, Math.min(sy, ih - 1));
        sw = Math.max(1, Math.min(sw, iw - sx));
        sh = Math.max(1, Math.min(sh, ih - sy));
        var canvas = document.createElement("canvas");
        canvas.width = 32;
        canvas.height = 16;
        var ctx = canvas.getContext("2d");
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
        var data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        var sum = 0;
        var count = 0;
        for (var i = 0; i < data.length; i += 4) {
          sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
          count++;
        }
        setTheme(sum / count / 255);
      } catch (e) {
        // 跨域读不到像素（没有 CORS 头）：保持默认白字 + 阴影，不报错
      }
    };
    img.src = url;
  }
  function update() {
    sample(currentUrl());
  }
  document.addEventListener("wusi:bg-settled", update);
  window.addEventListener("load", function () {
    setTimeout(update, 200);
  });
  window.addEventListener("resize", function () {
    clearTimeout(timer);
    timer = setTimeout(update, 300);
  });
})();
