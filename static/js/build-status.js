/* ============================================================
   右下角「构建状态」挂件的交互（原生 JS，无依赖）
   ------------------------------------------------------------
   数据来源：Hugo 构建时生成的同源静态文件 /build-status.json
   （模板 layouts/_default/single.buildstatus.json，内容来自
     data/build_status.yml）。只请求本站自己的这一个文件，
   不请求任何外部资源；失败了就保留外壳里的「未知」占位文案。

   同时负责窄屏的展开 / 收起：
     - 宽屏：两个胶囊一直显示（.build-status__toggle 被 CSS 隐藏）；
     - 窄屏：默认收成一枚半透明小圆点，点一下展开，点外面 / Esc 收起。
   ============================================================ */
(function () {
  "use strict";

  var NARROW = "(max-width: 767px)";

  function setText(node, text) {
    if (node && typeof text === "string" && text) {
      node.textContent = text;
    }
  }

  function applyConfig(root, config) {
    if (!config) {
      return;
    }

    if (config.checkedAt) {
      setText(root.querySelector(".build-status__time"), config.checkedAt);
    }
    if (config.overall) {
      root.setAttribute("data-variant", config.overall);
      var head = root.querySelector(".build-status__head");
      if (head) {
        head.setAttribute("data-variant", config.overall);
      }
    }

    var states = config.states || [];
    for (var i = 0; i < states.length; i++) {
      var state = states[i];
      if (!state || !state.key) {
        continue;
      }
      var item = root.querySelector('[data-item-key="' + state.key + '"]');
      if (!item) {
        continue;
      }
      if (state.variant) {
        item.setAttribute("data-variant", state.variant);
      }
      if (state.title) {
        item.setAttribute("title", state.title);
      }
      setText(item.querySelector(".build-status__value-text"), state.label);
    }
  }

  function statusUrl(root) {
    // 允许模板/手工指定（例如站点以后挪到子目录时），否则按当前页面路径推算，
    // 这样 GitHub Pages（根路径）和 Cloudflare Pages（预览域名）都能取到。
    var explicit = root.getAttribute("data-status-url");
    if (explicit) {
      return explicit;
    }
    var path = window.location.pathname.replace(/[^/]*$/, "");
    return path + "build-status.json";
  }

  function loadConfig(root) {
    var url = statusUrl(root);

    if (typeof window.fetch !== "function") {
      return;
    }

    window
      .fetch(url, { credentials: "omit", cache: "no-cache" })
      .then(function (response) {
        if (!response.ok) {
          throw new Error("HTTP " + response.status);
        }
        return response.json();
      })
      .then(function (config) {
        applyConfig(root, config);
      })
      .catch(function () {
        // 读不到就保持外壳里的「未知」，不弹错、不影响页面其它功能
      });
  }

  function initToggle(root) {
    var head = root.querySelector(".build-status__head");
    var toggle = root.querySelector(".build-status__toggle");
    var narrowQuery = window.matchMedia ? window.matchMedia(NARROW) : null;

    function setExpanded(expanded) {
      if (expanded) {
        root.setAttribute("data-expanded", "true");
      } else {
        root.removeAttribute("data-expanded");
      }
      if (toggle) {
        toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
      }
    }

    function isExpanded() {
      return root.getAttribute("data-expanded") === "true";
    }

    if (toggle) {
      toggle.addEventListener("click", function (event) {
        event.stopPropagation();
        setExpanded(!isExpanded());
      });
    }

    // 展开后点标题条收起（点胶囊本身是跳转，不拦）
    if (head) {
      head.addEventListener("click", function (event) {
        if (isExpanded() && !event.target.closest("a")) {
          setExpanded(false);
        }
      });
    }

    // 点到挂件外面 / 按 Esc 收起
    document.addEventListener("click", function (event) {
      if (!root.contains(event.target)) {
        setExpanded(false);
      }
    });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" || event.keyCode === 27) {
        setExpanded(false);
      }
    });

    // 宽屏：两个胶囊常显，清掉展开态（避免窄屏状态残留）；
    // 窄屏：默认收起。HTML 里写的是 data-expanded="true"（无 JS 时的兜底），
    // 所以这里第一次进入窄屏要主动收起来。
    function syncMode() {
      setExpanded(narrowQuery ? narrowQuery.matches && isExpanded() : false);
    }
    if (narrowQuery && narrowQuery.matches) {
      setExpanded(false);
    } else {
      syncMode();
    }

    if (narrowQuery) {
      if (narrowQuery.addEventListener) {
        narrowQuery.addEventListener("change", syncMode);
      } else if (narrowQuery.addListener) {
        narrowQuery.addListener(syncMode);
      }
    }
  }

  function boot() {
    var root = document.getElementById("build-status");
    if (!root) {
      return;
    }
    initToggle(root);
    loadConfig(root);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
