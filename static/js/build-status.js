/* ============================================================
   右下角「构建状态」挂件的交互（原生 JS，无依赖、无网络请求）
   ------------------------------------------------------------
   分工：
     - Hugo 在构建时把状态写成内联 JSON（<script id="build-status-data">），
       并在 HTML 里放好静态外壳（占位文案「未知」）；
     - 这里把 JSON 里的真实文案填进外壳，并处理窄屏的展开 / 收起。
   好处：JS 被禁用 / 挂件脚本加载失败时，页面上仍有可读、可点的胶囊，
        只是文案停在占位的「未知」。
   ============================================================ */
(function () {
  "use strict";

  var NARROW = "(max-width: 767px)";

  function readConfig() {
    var node = document.getElementById("build-status-data");
    if (!node) {
      return null;
    }
    try {
      return JSON.parse(node.textContent);
    } catch (error) {
      // 数据坏了就当没有：外壳里的占位文案仍然可读
      return null;
    }
  }

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

    // 切回宽屏时清掉窄屏的展开态，避免状态残留
    function syncMode() {
      if (!narrowQuery || !narrowQuery.matches) {
        setExpanded(false);
      }
    }
    syncMode();
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
    applyConfig(root, readConfig());
    initToggle(root);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
