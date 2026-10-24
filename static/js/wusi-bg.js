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
     2. 没写 banner（注意：cover 封面不算！）→ 从图源里随机取一张；
     3. **先立刻铺本地图池的兜底图**（不再是等 300ms），远端图加载好后再淡入覆盖，
        这样首屏不会先闪一下纯色底；远端失败/超时（4s）就保留本地图；
     4. 远端图 404 会记进 localStorage，下次选图时跳过（同一张坏图不反复拖慢首屏）；
     5. 所有图都失败 → 只留主题底色，页面依然正常。

   为什么用 <img> 铺层而不是 CSS background-image：
     旧实现先用 new Image() 探测、再设 background-image，同一张图会被下载两次
     （探测一次、CSS 背景一次），远端图大时首屏要等两轮。现在探测和显示是同一个
     <img> 元素：一次请求，onload 后直接淡入；CORS 探测还顺便给"头部文字颜色采样"复用。

   调试参数（仅调试用，正常访问不带）：
     ?wusi_bg=local   强制走本地兜底
     ?wusi_bg=remote  强制走远端
     ?wusi_bg=fail    模拟远端失败（验证回落到本地）
     ?bgimg=<url>     强制指定一张背景图（验证头部文字颜色/回退等）
   ========================================================================== */
/* 预加载遮罩「少女祈祷中」收起太慢：主题的滑出动画是 0.8s（spinner 0.5s），
   兜底图早就铺好了，遮罩还要慢慢滑走，首屏就白等这 0.8s。这里把「收起」动画
   压到 0.15s —— 只影响收起这一下，不影响它出现，也不改主题文件。
   注意：主题里 #loader 的 `loading` 类表示「已隐藏」（类一加，两半屏滑出）。 */
(function () {
  "use strict";
  try {
    var style = document.createElement("style");
    style.textContent =
      "#loader.loading .loading-bg{transition-duration:.15s}" +
      "#loader.loading .spinner-box{transition-duration:.15s}";
    (document.head || document.documentElement).appendChild(style);
  } catch (e) {}
})();

(function () {
  "use strict";

  var cfg = window.__WUSI_BG__;
  if (!cfg) {
    return;
  }

  var REMOTE_TIMEOUT = 4000; // 远端图探测超时（毫秒）→ 判定失败、保留本地兜底
  var REMOTE_AUTO_TRIES = 2; // 自动模式下最多试几个远端候选（404 很快，换一张比直接回落好）
  var BAD_KEY = "wusi_bg_bad_v1"; // 远端坏图记忆（localStorage）
  var BAD_TTL = 7 * 24 * 60 * 60 * 1000; // 坏图记忆保留 7 天
  var LAST_KEY = "wusi_bg_last"; // 上一次用过的图（sessionStorage）
  var HIST_REMOTE_KEY = "wusi_bg_hist_remote"; // 最近用过的远端图（避免连着几次撞同一张）
  var HIST_LOCAL_KEY = "wusi_bg_hist_local";
  var HIST_REMOTE_SIZE = 8;
  var HIST_LOCAL_SIZE = 4;

  var remote = Array.isArray(cfg.pool) ? cfg.pool : (Array.isArray(cfg.remote) ? cfg.remote : []);
  var local = Array.isArray(cfg.local) ? cfg.local : [];
  var banner = typeof cfg.banner === "string" ? cfg.banner : "";

  var mode = "";
  var forceImage = "";
  try {
    var search = new URLSearchParams(location.search);
    mode = search.get("wusi_bg") || "";
    forceImage = search.get("bgimg") || "";
  } catch (e) {
    mode = "";
    forceImage = "";
  }

  // 调试/自动化验证用状态对象：
  //   visible —— 已经有图显示（本地兜底也算）
  //   settled —— 最终背景已经定下来（远端成功、或失败/超时后保留本地、或 banner 就绪）
  //   el      —— 当前显示在最上层的 <img>（头部文字颜色采样直接复用它，不再二次请求）
  var state = {
    settled: false,
    visible: false,
    source: null,
    image: null,
    mode: mode || "auto",
    el: null,
  };
  window.__wusiBg = state;

  var host = null;
  var layerMain = null; // 上层：banner / 远端图
  var layerFallback = null; // 下层：本地兜底图
  var fallbackShown = false;
  var fallbackUrl = null;
  var mainShown = false;
  var remotePending = false;
  var attemptToken = 0;
  var failedRemote = [];

  function fire(name, detail) {
    try {
      document.dispatchEvent(new CustomEvent(name, { detail: detail || {} }));
    } catch (e) {}
  }

  function pick(list) {
    return list && list.length ? list[Math.floor(Math.random() * list.length)] : null;
  }

  function readHist(key) {
    try {
      var arr = JSON.parse(sessionStorage.getItem(key) || "[]");
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      return [];
    }
  }

  function rememberHist(key, url, size) {
    if (!url) return;
    var arr = readHist(key).filter(function (u) {
      return u !== url;
    });
    arr.push(url);
    if (arr.length > size) {
      arr = arr.slice(arr.length - size);
    }
    try {
      sessionStorage.setItem(key, JSON.stringify(arr));
    } catch (e) {}
    try {
      sessionStorage.setItem(LAST_KEY, url);
    } catch (e) {}
  }

  // 抽一张尽量"新鲜"的图：先排除最近用过的（history）、坏图、本次已试过的；
  // 都排光了就退一步只排除坏图 / 本次试过的，保证一定能抽到。
  function pickFresh(list, opts) {
    if (!list || !list.length) {
      return null;
    }
    opts = opts || {};
    var bad = opts.bad || {};
    var exclude = opts.exclude || [];
    var hist = opts.historyKey ? readHist(opts.historyKey) : [];
    var pool = list.filter(function (url) {
      if (isBad(url, bad)) return false;
      if (exclude.indexOf(url) !== -1) return false;
      if (hist.indexOf(url) !== -1) return false;
      return true;
    });
    if (!pool.length) {
      pool = list.filter(function (url) {
        return !isBad(url, bad) && exclude.indexOf(url) === -1;
      });
    }
    if (!pool.length) {
      pool = list;
    }
    var url = pick(pool);
    if (opts.historyKey) {
      rememberHist(opts.historyKey, url, opts.historySize || 8);
    } else {
      try {
        sessionStorage.setItem(LAST_KEY, url);
      } catch (e) {}
    }
    return url;
  }

  function readBad() {
    try {
      var raw = localStorage.getItem(BAD_KEY);
      var obj = raw ? JSON.parse(raw) : {};
      return obj && typeof obj === "object" ? obj : {};
    } catch (e) {
      return {};
    }
  }

  function writeBad(obj) {
    try {
      localStorage.setItem(BAD_KEY, JSON.stringify(obj));
    } catch (e) {}
  }

  function isBad(url, bad) {
    var t = bad[url];
    if (!t) return false;
    if (Date.now() - t > BAD_TTL) {
      delete bad[url];
      return false;
    }
    return true;
  }

  function markBad(url) {
    if (!url || failedRemote.indexOf(url) !== -1) return;
    failedRemote.push(url);
    var bad = readBad();
    bad[url] = Date.now();
    // 只留最近 40 条，别把 localStorage 撑大
    var keys = Object.keys(bad);
    if (keys.length > 40) {
      keys.sort(function (a, b) {
        return bad[a] - bad[b];
      });
      for (var i = 0; i < keys.length - 40; i++) {
        delete bad[keys[i]];
      }
    }
    writeBad(bad);
  }

  function pickRemote() {
    var bad = readBad();
    var pool = remote.filter(function (url) {
      return !isBad(url, bad);
    });
    if (!pool.length) {
      pool = remote;
    }
    return pickFresh(pool, {
      exclude: failedRemote,
      historyKey: HIST_REMOTE_KEY,
      historySize: HIST_REMOTE_SIZE,
    });
  }

  function newLayer(kind) {
    var img = document.createElement("img");
    img.className = "wusi-bg-layer wusi-bg-layer-" + kind;
    img.alt = "";
    img.decoding = "async";
    img.setAttribute("aria-hidden", "true");
    return img;
  }

  function ensureHost() {
    if (host || !document.body) {
      return host;
    }
    host = document.createElement("div");
    host.id = "wusi-bg";
    host.setAttribute("aria-hidden", "true");
    layerFallback = newLayer("fallback");
    layerMain = newLayer("main");
    host.appendChild(layerFallback);
    host.appendChild(layerMain);
    document.body.insertBefore(host, document.body.firstChild);
    return host;
  }

  function reveal(img) {
    if (!img) return;
    requestAnimationFrame(function () {
      img.classList.add("is-on");
    });
  }

  // 单次请求装图：成功后把新 <img> 放进 #wusi-bg 对应层并淡入。
  // wantCors=true 时先按 CORS 方式加载（为了后面 canvas 采样背景亮度），
  // 对方没给 Access-Control-Allow-Origin 就换普通方式再加载一次 —— 保证背景一定能显示。
  function loadLayer(kind, url, wantCors, cb) {
    var crossOrigin = !!(wantCors && /^https?:/i.test(url));

    function attempt(img, cors) {
      var done = false;
      img.onload = function () {
        if (done) return;
        done = true;
        img.onload = img.onerror = null;
        cb(null, img);
      };
      img.onerror = function () {
        if (done) return;
        if (cors) {
          // CORS 失败（对方没有 CORS 头）：换普通方式（新的 <img>，避免缓存住失败）
          attempt(newLayer(kind), false);
          return;
        }
        done = true;
        img.onload = img.onerror = null;
        cb(new Error("image load failed"), img);
      };
      if (cors) {
        img.crossOrigin = "anonymous";
      }
      img.setAttribute("src", url);
    }

    attempt(newLayer(kind), crossOrigin);
  }

  function showVisible(source, url, img) {
    state.visible = true;
    state.source = source;
    state.image = url || null;
    state.el = img || state.el;
    fire("wusi:bg-visible", { source: source, url: url || null });
  }

  function settle(source, url, img) {
    if (state.settled) {
      return;
    }
    state.settled = true;
    state.source = source;
    state.image = url || null;
    if (img) {
      state.el = img;
    }
    document.documentElement.classList.add("wusi-bg-ready");
    fire("wusi:bg-settled", { source: source, url: url || null });
  }

  // 本地兜底：立刻选一张本地图池的图加载。加载好就等于"有图可看"，
  // 远端还在路上时先把这一层垫上；远端失败就靠它当最终背景。
  function showFallback() {
    if (!ensureHost()) {
      return;
    }
    if (fallbackShown) {
      return;
    }
    var tried = {};
    var first = pickFresh(local, {
      exclude: failedRemote,
      historyKey: HIST_LOCAL_KEY,
      historySize: HIST_LOCAL_SIZE,
    });
    if (!first) {
      if (!remotePending) {
        settle("none", null, null);
      }
      return;
    }

    (function attempt(url) {
      tried[url] = true;
      loadLayer("fallback", url, false, function (err, img) {
        if (!err) {
          host.replaceChild(img, layerFallback);
          layerFallback = img;
          fallbackShown = true;
          // 兜底图（约 40KB）已可见：确保预加载遮罩已经收起，
          // 正常背景大图继续后台异步加载，到了再淡入替换。
          // ⚠️ 主题里 #loader 的 `loading` 类是「已隐藏」状态：类一加两半屏才滑走。
          // 所以这里只能是 add（不是 remove）——remove 会把收起的遮罩重新弹出来。
          (function () {
            var loader = document.getElementById("loader");
            if (loader && !loader.classList.contains("loading")) {
              loader.classList.add("loading");
              document.body.style.overflow = "auto";
            }
          })();
          fallbackUrl = url;
          reveal(img);
          if (!mainShown) {
            showVisible("local", url, img);
          }
          if (!remotePending) {
            settle("local", url, img);
          }
          return;
        }
        var next = pickFresh(local, {
          exclude: failedRemote.concat(Object.keys(tried)),
          historyKey: HIST_LOCAL_KEY,
          historySize: HIST_LOCAL_SIZE,
        });
        if (next) {
          attempt(next);
          return;
        }
        if (!remotePending) {
          settle("none", null, null);
        }
      });
    })(first);
  }

  // 探测并应用一张"主图"（远端随机图）；失败/超时交给 onGiveUp
  function tryMain(url, tries, onGiveUp) {
    if (!url) {
      remotePending = false;
      onGiveUp();
      return;
    }
    ensureHost();
    var token = ++attemptToken;
    var timedOut = false;
    var timer = setTimeout(function () {
      if (token !== attemptToken) return;
      timedOut = true;
      remotePending = false;
      onGiveUp();
    }, REMOTE_TIMEOUT);

    loadLayer("main", url, true, function (err, img) {
      if (token !== attemptToken || timedOut) return;
      clearTimeout(timer);
      if (!err) {
        remotePending = false;
        host.replaceChild(img, layerMain);
        layerMain = img;
        mainShown = true;
        reveal(img);
        showVisible("remote", url, img);
        settle("remote", url, img);
        return;
      }
      markBad(url);
      if (tries > 1) {
        tryMain(pickRemote(), tries - 1, onGiveUp);
        return;
      }
      remotePending = false;
      onGiveUp();
    });
  }

  function finishWithFallback() {
    remotePending = false;
    if (fallbackShown) {
      settle("local", fallbackUrl, layerFallback);
    } else {
      showFallback(); // 里面会在加载完 / 全失败后 settle
    }
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
        state.visible = true;
        document.documentElement.classList.add("wusi-bg-ready");
        fire("wusi:bg-visible", { source: "banner", url: banner });
        state.el = img;
        settle("banner", banner, img);
        return;
      }
      fail();
    }

    function fail() {
      // banner 挂了：撤掉"整屏头图"类名、藏掉坏图，退回远端随机背景
      document.documentElement.classList.remove("wusi-page-banner");
      if (img) {
        img.style.display = "none";
      }
      if (!ensureHost()) {
        document.addEventListener("DOMContentLoaded", fail, { once: true });
        return;
      }
      remotePending = true;
      showFallback();
      tryMain(pickRemote(), REMOTE_AUTO_TRIES, finishWithFallback);
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
      if (!ensureHost()) {
        document.addEventListener("DOMContentLoaded", start, { once: true });
        return;
      }
      remotePending = true;
      showFallback();
      tryMain(forceImage, 1, finishWithFallback);
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
    remotePending = true;
    showFallback(); // 先铺本地，别让首屏空着
    if (mode === "remote") {
      tryMain(pickRemote(), 1, finishWithFallback);
      return;
    }
    if (mode === "fail") {
      // 故意指向一个不存在的图，走真实的 onerror → 本地兜底路径
      tryMain("/__wusi_bg_force_fail__.webp", 1, finishWithFallback);
      return;
    }
    tryMain(pickRemote(), REMOTE_AUTO_TRIES, finishWithFallback);
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
   头部标题自适应文字颜色：采样「标题后面那块背景」的平均亮度。
   · 直接复用正在显示的 <img>（远端图用 CORS 方式加载，所以能读像素），不再二次请求图片；
   · 亮色主题：背景偏亮 → html.wusi-hero-light（黑字），偏暗 → wusi-hero-dark（白字）；
   · 暗色主题：背景有一层 45% 黑遮罩 + 页面整体是深色，统一用白字，不用采样；
   · 读不到像素（图没 CORS / 加载失败）就保持默认的「白字 + 深阴影」，不报错；
   · 图片按 object-fit: cover 映射到视口，采样区域 = 标题文字大致所在的位置。
   ========================================================================== */
(function () {
  "use strict";
  var THRESHOLD = 0.6; // 叠加白色蒙版后的等效亮度阈值
  var timer = null;

  function isDark() {
    return document.documentElement.getAttribute("data-theme") === "dark";
  }

  function apply(light) {
    var html = document.documentElement;
    html.classList.toggle("wusi-hero-light", light);
    html.classList.toggle("wusi-hero-dark", !light);
  }

  function currentEl() {
    var st = window.__wusiBg || {};
    return st.el || null;
  }

  function sample(img) {
    if (!img || !img.naturalWidth || !img.naturalHeight) {
      return;
    }
    // 暗色主题：页面整体压暗，标题统一白字，不需要读像素（也就不用 CORS）
    if (isDark()) {
      window.__wusiHeroLum = null;
      apply(false);
      return;
    }
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
      var raw = sum / count / 255;
      // 叠加亮色主题那层 12% 白蒙版后的等效亮度（与 CSS 里 #wusi-bg::after 对应）
      var eff = raw * 0.88 + 0.12;
      window.__wusiHeroLum = Math.round(eff * 100) / 100;
      apply(eff > THRESHOLD);
    } catch (e) {
      // 跨域读不到像素（没有 CORS 头）：保持默认白字 + 阴影，不报错
      window.__wusiHeroLum = null;
      apply(false);
    }
  }

  function update() {
    sample(currentEl());
  }

  document.addEventListener("wusi:bg-visible", update);
  document.addEventListener("wusi:bg-settled", update);
  window.addEventListener("load", function () {
    setTimeout(update, 200);
  });
  window.addEventListener("resize", function () {
    clearTimeout(timer);
    timer = setTimeout(update, 300);
  });

  // 亮/暗主题切换后重新判断（只监听 data-theme，避免监听 class 造成死循环）
  try {
    var lastDark = isDark();
    new MutationObserver(function () {
      var dark = isDark();
      if (dark !== lastDark) {
        lastDark = dark;
        update();
      }
    }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  } catch (e) {}

  // 初始兜底：万一脚本晚于背景事件执行，也跑一次
  window.addEventListener("DOMContentLoaded", update);
})();

/* ==========================================================================
   点击背景 → 全屏查看当前这张背景图
   样式见 static/css/wusi-bg.css 末尾。

   · 背景层 #wusi-bg 自身是 pointer-events: none（不挡页面点击），所以不能直接
     给它绑 click；这里改成在 document 上做事件委托，只认「页面空白处」：
     html / body / #wrap / #container / #main / #content / #sidebar / #header 本身被点中才打开，
     点在链接、按钮、输入框、正文、卡片、页脚通栏等任何具体元素上都不会触发；
   · 显示的是当前真正在用的那张图：优先取 __wusiBg.el 的 currentSrc / src
     （有 banner 的文章页就是 #header 里那张头图），没有 el 时退回 __wusiBg.image；
   · 打开后 html 加上 wusi-bg-viewing（锁滚动 + 显示遮罩），Esc / 点遮罩任意处 /
     右上角 × 关闭；打开、关闭各派发一个 wusi:bg-viewer-open / wusi:bg-viewer-close 事件。
   ========================================================================== */
(function () {
  "use strict";
  if (!window.__WUSI_BG__) {
    return;
  }

  // 只有这些「容器本身」被点到才算点在背景上；具体元素（p / div / img / a ...）一律不算
  var BLANK_TARGETS = [
    "html",
    "body",
    "#wrap",
    "#container",
    "#main",
    "#content",
    "#sidebar",
    "#header",
    "#header-outer", // 主题头图里包着 #header-title 的那层，点标题以外的空白区就是它
  ];
  var INTERACTIVE = "a,button,input,textarea,select,label,summary,[contenteditable],[role='button']";

  var viewer = null;
  var viewerImg = null;
  var lastFocus = null;

  function isOpen() {
    return document.documentElement.classList.contains("wusi-bg-viewing");
  }

  function currentImageUrl() {
    var st = window.__wusiBg || {};
    var el = st.el;
    if (el && el.tagName === "IMG") {
      var url = el.currentSrc || el.getAttribute("src") || el.src;
      if (url) {
        return url;
      }
    }
    return st.image || "";
  }

  function isBlankTarget(target) {
    if (!target || target.nodeType !== 1) {
      return false;
    }
    if (target.closest && target.closest(INTERACTIVE)) {
      return false;
    }
    for (var i = 0; i < BLANK_TARGETS.length; i++) {
      var sel = BLANK_TARGETS[i];
      if (sel.charAt(0) === "#" ? target.id === sel.slice(1) : target.tagName.toLowerCase() === sel) {
        return true;
      }
    }
    return false;
  }

  function build() {
    if (viewer && viewer.parentNode) {
      return;
    }
    viewer = document.createElement("div");
    viewer.id = "wusi-bg-viewer";
    viewer.className = "wusi-bg-viewer";
    viewer.setAttribute("role", "dialog");
    viewer.setAttribute("aria-modal", "true");
    viewer.setAttribute("aria-label", "当前背景大图");

    viewerImg = document.createElement("img");
    viewerImg.className = "wusi-bg-viewer-img";
    viewerImg.alt = "当前背景大图";
    viewerImg.draggable = false;

    var closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "wusi-bg-viewer-close";
    closeBtn.setAttribute("aria-label", "关闭");
    closeBtn.textContent = "×";

    var hint = document.createElement("p");
    hint.className = "wusi-bg-viewer-hint";
    hint.textContent = "点击任意处或按 Esc 关闭";

    viewer.appendChild(viewerImg);
    viewer.appendChild(closeBtn);
    viewer.appendChild(hint);
    (document.body || document.documentElement).appendChild(viewer);

    viewer.addEventListener("click", close);
    closeBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      close();
    });
  }

  function open() {
    var st = window.__wusiBg || {};
    if (!st.visible && !st.settled) {
      return;
    }
    var url = currentImageUrl();
    if (!url) {
      return;
    }
    build();
    lastFocus = document.activeElement;
    viewerImg.setAttribute("src", url);
    document.documentElement.classList.add("wusi-bg-viewing");
    var btn = viewer.querySelector(".wusi-bg-viewer-close");
    if (btn) {
      try {
        btn.focus({ preventScroll: true });
      } catch (e) {}
    }
    try {
      document.dispatchEvent(new CustomEvent("wusi:bg-viewer-open", { detail: { url: url } }));
    } catch (e) {}
  }

  function close() {
    if (!isOpen()) {
      return;
    }
    document.documentElement.classList.remove("wusi-bg-viewing");
    try {
      document.dispatchEvent(new CustomEvent("wusi:bg-viewer-close", {}));
    } catch (e) {}
    if (lastFocus && lastFocus.focus) {
      try {
        lastFocus.focus({ preventScroll: true });
      } catch (e) {}
    }
    lastFocus = null;
  }

  document.addEventListener(
    "click",
    function (e) {
      if (e.defaultPrevented || e.button !== 0 || isOpen()) {
        return;
      }
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
        return;
      }
      var sel = window.getSelection ? String(window.getSelection() || "") : "";
      if (sel) {
        return; // 正在选文字，不抢点击
      }
      if (!isBlankTarget(e.target)) {
        return;
      }
      open();
    },
    false
  );

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && isOpen()) {
      close();
    }
  });

  // 顶部导航栏里加一行小字提示（「点击背景图可看全图」）。
  // 只有当前页确实有背景图可看时才插，避免出现「点了没反应」的假提示；
  // 插入位置：#sub-nav（搜索图标所在容器）末尾，样式见 wusi-bg.css 的 .wusi-bg-hint。
  function ensureHint() {
    if (document.getElementById("wusi-bg-hint")) {
      return;
    }
    var host = document.getElementById("sub-nav") || document.getElementById("header-nav");
    if (!host) {
      return;
    }
    var hint = document.createElement("span");
    hint.id = "wusi-bg-hint";
    hint.className = "wusi-bg-hint";
    hint.textContent = "点击背景图可看全图";
    host.appendChild(hint);
  }

  function maybeHint() {
    if (currentImageUrl()) {
      ensureHint();
    }
  }

  document.addEventListener("wusi:bg-settled", maybeHint);
  document.addEventListener("wusi:bg-visible", maybeHint);
  window.addEventListener("load", maybeHint);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", maybeHint);
  } else {
    maybeHint();
  }

  // 调试 / 自动化入口
  window.__wusiBgViewer = { open: open, close: close, isOpen: isOpen };
})();
