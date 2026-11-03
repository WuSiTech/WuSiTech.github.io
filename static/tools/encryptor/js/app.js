/*!
 * WuSi Web · app.js
 * 界面逻辑：文件队列、密码、比例、进度、日志、下载与主题。
 */
(function () {
    'use strict';

    var $ = function (id) { return document.getElementById(id); };

    var els = {
        themeBtn: $('themeBtn'),
        dropzone: $('dropzone'),
        fileInput: $('fileInput'),
        fileList: $('fileList'),
        queueMeta: $('queueMeta'),
        clearFiles: $('clearFiles'),
        password: $('password'),
        togglePw: $('togglePw'),
        ratio: $('ratio'),
        ratioOut: $('ratioOut'),
        ratioHint: $('ratioHint'),
        estimate: $('estimate'),
        encryptBtn: $('encryptBtn'),
        decryptBtn: $('decryptBtn'),
        progressCard: $('progressCard'),
        progressLabel: $('progressLabel'),
        progressPct: $('progressPct'),
        progressBar: $('progressBar'),
        progressBarWrap: $('progressBarWrap'),
        progressFile: $('progressFile'),
        log: $('log'),
        clearLog: $('clearLog'),
        results: $('results'),
        clearResults: $('clearResults'),
        saveAllBtn: $('saveAllBtn'),
        toasts: $('toasts')
    };

    var state = {
        files: [],
        results: [],
        busy: false,
        savingAll: false,
        seq: 0,
        runId: 0
    };

    var THEME_KEY = 'wusi-web-theme';
    var MAX_CONFIRM_BYTES = 512 * 1024 * 1024;
    var presets = Array.prototype.slice.call(document.querySelectorAll('.presets button'));
    var leftPanel = document.querySelector('.workspace .panel');
    var logEmptyHTML = els.log.innerHTML;

    var TOAST_ICONS = {
        success: 'i-check',
        error: 'i-alert',
        warn: 'i-alert',
        info: 'i-info'
    };

    /* ====================================================================
     *  工具函数
     * ================================================================== */

    function formatSize(bytes) {
        if (typeof bytes !== 'number' || !isFinite(bytes) || bytes < 0) return '—';
        if (bytes < 1024) return bytes + ' B';
        var units = ['KB', 'MB', 'GB', 'TB'];
        var value = bytes / 1024;
        var i = 0;
        while (value >= 1024 && i < units.length - 1) {
            value /= 1024;
            i++;
        }
        return (value >= 100 ? value.toFixed(0) : value.toFixed(1)) + ' ' + units[i];
    }

    function timeString() {
        try {
            return new Date().toLocaleTimeString('zh-CN', { hour12: false });
        } catch (e) {
            return new Date().toTimeString().slice(0, 8);
        }
    }

    function ratioPercent() {
        var v = parseInt(els.ratio.value, 10);
        if (!isFinite(v)) v = 25;
        return Math.min(100, Math.max(1, v));
    }

    function decryptedName(name) {
        if (/\.enc$/i.test(name) && name.length > 4) return name.slice(0, -4);
        var dot = name.lastIndexOf('.');
        if (dot > 0 && dot < name.length - 1) {
            return name.slice(0, dot) + '.decrypted' + name.slice(dot);
        }
        return name + '.decrypted';
    }

    function extLabel(name) {
        var dot = name.lastIndexOf('.');
        if (dot <= 0 || dot === name.length - 1) return 'FILE';
        var ext = name.slice(dot + 1).toUpperCase();
        if (ext.length > 4) ext = ext.slice(0, 3);
        return ext;
    }

    function hueClass(name) {
        var sum = 0;
        for (var i = 0; i < name.length; i++) sum = (sum + name.charCodeAt(i)) % 997;
        return 'hue-' + (sum % 5);
    }

    function statusLabel(status) {
        if (status === 'working') return '处理中';
        if (status === 'done') return '完成';
        if (status === 'error') return '失败';
        return '待处理';
    }

    /* ====================================================================
     *  主题
     * ================================================================== */

    function setTheme(theme, persist) {
        document.documentElement.dataset.theme = theme;
        var dark = theme === 'dark';
        els.themeBtn.setAttribute('aria-label', dark ? '切换到浅色模式' : '切换到深色模式');
        els.themeBtn.title = dark ? '切换到浅色模式' : '切换到深色模式';
        var meta = document.querySelector('meta[name="theme-color"]');
        if (meta) meta.setAttribute('content', dark ? '#161615' : '#f4f4f2');
        if (persist) {
            try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* ignore */ }
        }
    }

    function initTheme() {
        var stored = null;
        try { stored = localStorage.getItem(THEME_KEY); } catch (e) { /* ignore */ }
        setTheme(stored === 'light' ? 'light' : 'dark', false);
    }

    /* ====================================================================
     *  提示 / 日志
     * ================================================================== */

    function toast(message, type, duration) {
        type = type || 'info';
        var el = document.createElement('div');
        el.className = 'toast toast-' + type;
        el.innerHTML = '<svg class="icon"><use href="#' + (TOAST_ICONS[type] || 'i-info') + '"></use></svg><span></span>';
        el.querySelector('span').textContent = message;
        el.setAttribute('role', type === 'error' ? 'alert' : 'status');

        var dismiss = function () {
            clearTimeout(timer);
            el.classList.remove('show');
            setTimeout(function () { el.remove(); }, 260);
        };
        el.addEventListener('click', dismiss);

        els.toasts.appendChild(el);
        while (els.toasts.children.length > 3) {
            els.toasts.firstElementChild.remove();
        }
        requestAnimationFrame(function () { el.classList.add('show'); });
        var timer = setTimeout(dismiss, duration || 4200);
    }

    function log(type, message) {
        var empty = els.log.querySelector('.log-empty');
        if (empty) empty.remove();

        var line = document.createElement('div');
        line.className = 'log-line log-' + type;

        var time = document.createElement('span');
        time.className = 'log-time';
        time.textContent = timeString();

        var msg = document.createElement('span');
        msg.className = 'log-msg';
        msg.textContent = message;

        line.appendChild(time);
        line.appendChild(msg);

        var nearBottom = els.log.scrollHeight - els.log.scrollTop - els.log.clientHeight < 56;
        els.log.appendChild(line);
        if (nearBottom) els.log.scrollTop = els.log.scrollHeight;
    }

    function clearLog() {
        els.log.innerHTML = logEmptyHTML;
    }

    /* ====================================================================
     *  文件队列
     * ================================================================== */

    function updateQueueMeta() {
        var count = state.files.length;
        if (!count) {
            els.queueMeta.textContent = '未添加文件';
            els.clearFiles.hidden = true;
            els.clearFiles.disabled = true;
            return;
        }
        var total = 0;
        var done = 0;
        for (var i = 0; i < state.files.length; i++) {
            total += state.files[i].size;
            if (state.files[i].status === 'done') done++;
        }
        els.queueMeta.textContent = count + ' 个文件 · ' + formatSize(total) +
            (done ? ' · ' + done + ' 完成' : '');
        els.clearFiles.hidden = false;
        els.clearFiles.disabled = state.busy;
    }

    function updateEstimate() {
        var active = state.files.filter(function (f) {
            return f.status !== 'done' && f.encrypted !== true;
        });

        if (!active.length) {
            els.estimate.hidden = true;
            els.estimate.textContent = '';
            return;
        }

        var ratio = ratioPercent() / 100;
        var totalBlocks = 0;
        var encCount = 0;
        var overhead = 0;

        active.forEach(function (f) {
            var e = WuSiFormat.estimate(f.size, ratio);
            totalBlocks += e.totalBlocks;
            encCount += e.encCount;
            overhead += e.overhead;
        });

        els.estimate.hidden = false;
        els.estimate.textContent = '预计改写 ' + encCount + '/' + totalBlocks +
            ' 块 · 元数据约 +' + formatSize(overhead);
    }

    function updateRatioHint(percent) {
        var span = els.ratioHint.querySelector('span');
        var use = els.ratioHint.querySelector('use');
        if (percent === 100) {
            els.ratioHint.classList.remove('hint-warn');
            els.ratioHint.classList.add('hint-ok');
            span.textContent = '100%：所有数据块都会被改写。';
            if (use) use.setAttribute('href', '#i-check');
        } else {
            els.ratioHint.classList.remove('hint-ok');
            els.ratioHint.classList.add('hint-warn');
            span.textContent = '低于 100% 时，未选中的块仍是明文。';
            if (use) use.setAttribute('href', '#i-alert');
        }
    }

    function updateRatioUI() {
        var percent = ratioPercent();
        els.ratio.value = String(percent);
        els.ratioOut.textContent = percent + '%';
        els.ratio.style.setProperty('--fill', ((percent - 1) / 99 * 100).toFixed(2) + '%');

        presets.forEach(function (btn) {
            btn.classList.toggle('is-active', Number(btn.dataset.ratio) === percent);
        });

        updateRatioHint(percent);
        updateEstimate();
    }

    function buildFileRow(item) {
        var row = document.createElement('div');
        row.className = 'file-item';
        row.dataset.id = String(item.id);
        row.dataset.status = item.status;

        var icon = document.createElement('div');
        icon.className = 'file-ico ' + hueClass(item.name);
        icon.textContent = extLabel(item.name);
        icon.setAttribute('aria-hidden', 'true');

        var main = document.createElement('div');
        main.className = 'file-main';

        var name = document.createElement('div');
        name.className = 'file-name';
        name.textContent = item.name;
        name.title = item.name;

        var meta = document.createElement('div');
        meta.className = 'file-meta';

        var size = document.createElement('span');
        size.textContent = formatSize(item.size);

        var dot = document.createElement('span');
        dot.className = 'meta-dot';

        var stateEl = document.createElement('span');
        stateEl.className = 'file-state';
        stateEl.textContent = item.status === 'pending' && item.encrypted
            ? '已加密' : statusLabel(item.status);

        meta.appendChild(size);
        meta.appendChild(dot);
        meta.appendChild(stateEl);

        var bar = document.createElement('div');
        bar.className = 'file-bar';
        var fill = document.createElement('i');
        bar.appendChild(fill);

        main.appendChild(name);
        main.appendChild(meta);
        main.appendChild(bar);

        var badge = document.createElement('span');
        badge.className = 'badge-enc';
        badge.textContent = 'PHENC04';
        badge.title = '检测到本程序加密格式';
        badge.hidden = !item.encrypted;

        var remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'file-remove';
        remove.setAttribute('aria-label', '移除 ' + item.name);
        remove.title = '移除';
        remove.innerHTML = '<svg class="icon"><use href="#i-x"></use></svg>';

        row.appendChild(icon);
        row.appendChild(main);
        row.appendChild(badge);
        row.appendChild(remove);

        item.el = row;
        item.stateEl = stateEl;
        item.barEl = fill;
        item.badgeEl = badge;

        if (typeof item.progress === 'number' && item.progress > 0) {
            fill.style.width = (item.progress * 100).toFixed(1) + '%';
        }

        return row;
    }

    function renderFileList() {
        els.fileList.replaceChildren();
        state.files.forEach(function (item) {
            els.fileList.appendChild(buildFileRow(item));
        });
        els.fileList.hidden = state.files.length === 0;
        updateQueueMeta();
    }

    function setFileStatus(item, status, text, progress) {
        item.status = status;
        if (!item.el) return;

        item.el.dataset.status = status;
        if (item.stateEl) {
            item.stateEl.textContent = text || statusLabel(status);
            item.stateEl.title = text || statusLabel(status);
        }

        if (typeof progress === 'number') {
            item.progress = Math.max(0, Math.min(1, progress));
            if (item.barEl) item.barEl.style.width = (item.progress * 100).toFixed(1) + '%';
        }
    }

    function addFiles(fileList) {
        if (state.busy) return;
        var files = Array.prototype.slice.call(fileList || []);
        if (!files.length) return;

        var added = 0;
        var duplicates = 0;
        var empty = 0;

        files.forEach(function (file) {
            if (!file || typeof file.size !== 'number') return;
            if (file.size === 0) { empty++; return; }

            var key = file.name + '\u0000' + file.size + '\u0000' + (file.lastModified || 0);
            var exists = state.files.some(function (f) { return f.key === key; });
            if (exists) { duplicates++; return; }

            var item = {
                id: ++state.seq,
                key: key,
                file: file,
                name: file.name || '未命名文件',
                size: file.size,
                status: 'pending',
                progress: 0,
                encrypted: null,
                el: null,
                stateEl: null,
                barEl: null,
                badgeEl: null
            };

            state.files.push(item);
            added++;
            probeEncrypted(item);
        });

        if (added) {
            renderFileList();
            updateEstimate();
            toast('已添加 ' + added + ' 个文件', 'success', 2600);
        }
        if (empty) toast('已跳过 ' + empty + ' 个空文件', 'warn');
        if (duplicates) toast('已跳过 ' + duplicates + ' 个重复文件', 'info');

        if (added && state.files.length === added) {
            els.fileList.scrollTop = 0;
        }
    }

    function probeEncrypted(item) {
        WuSiFormat.looksEncrypted(item.file).then(function (isEnc) {
            if (state.files.indexOf(item) === -1) return;
            item.encrypted = isEnc;
            if (item.badgeEl) item.badgeEl.hidden = !isEnc;
            if (item.stateEl && item.status === 'pending') {
                item.stateEl.textContent = isEnc ? '已加密' : '待处理';
            }
            updateEstimate();
        }).catch(function () { /* 读取失败时保持未知 */ });
    }

    function removeFile(item) {
        if (state.busy) return;
        var index = state.files.indexOf(item);
        if (index === -1) return;
        state.files.splice(index, 1);
        renderFileList();
        updateEstimate();
    }

    function clearFiles() {
        if (state.busy) return;
        state.files = [];
        renderFileList();
        updateEstimate();
        els.progressCard.hidden = true;
        log('muted', '已清空文件列表');
    }

    /* ====================================================================
     *  结果
     * ================================================================== */

    function renderResults() {
        els.results.replaceChildren();

        if (!state.results.length) {
            var empty = document.createElement('p');
            empty.className = 'empty';
            empty.textContent = '处理完成后在这里保存。';
            els.results.appendChild(empty);
        } else {
            state.results.forEach(function (result) {
                var item = document.createElement('div');
                item.className = 'result-item';

                var icon = document.createElement('div');
                icon.className = 'result-ico';
                icon.innerHTML = '<svg class="icon"><use href="#' +
                    (result.mode === 'enc' ? 'i-lock' : 'i-key') + '"></use></svg>';

                var main = document.createElement('div');
                main.className = 'result-main';

                var name = document.createElement('div');
                name.className = 'result-name';
                name.textContent = result.name;
                name.title = result.name;

                var meta = document.createElement('div');
                meta.className = 'result-meta';
                var delta = result.outputSize - result.sourceSize;
                var deltaText = (delta >= 0 ? '+' : '−') + formatSize(Math.abs(delta));
                meta.textContent = (result.mode === 'enc' ? '加密' : '解密') + ' · ' +
                    formatSize(result.sourceSize) + ' → ' + formatSize(result.outputSize) +
                    ' · ' + deltaText;
                meta.title = '源文件：' + result.source + ' · 已改写 ' +
                    result.blocks + '/' + result.totalBlocks + ' 个 1 MiB 块';

                main.appendChild(name);
                main.appendChild(meta);

                var save = document.createElement('a');
                save.className = 'result-save';
                save.href = result.url;
                save.download = result.name;
                save.innerHTML = '<svg class="icon"><use href="#i-download"></use></svg>保存';
                save.addEventListener('click', function () {
                    toast('已开始保存「' + result.name + '」', 'info', 2200);
                });

                item.appendChild(icon);
                item.appendChild(main);
                item.appendChild(save);
                els.results.appendChild(item);
            });
        }

        var hasResults = state.results.length > 0;
        els.saveAllBtn.disabled = !hasResults || state.savingAll || state.busy;
        els.clearResults.disabled = !hasResults || state.savingAll || state.busy;
    }

    function saveResult(result) {
        var a = document.createElement('a');
        a.href = result.url;
        a.download = result.name;
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        a.remove();
    }

    function saveAllResults() {
        if (!state.results.length || state.savingAll) return;
        var list = state.results.slice();

        if (list.length === 1) {
            saveResult(list[0]);
            toast('已开始保存「' + list[0].name + '」', 'info', 2400);
            return;
        }

        state.savingAll = true;
        renderResults();
        toast('将依次保存 ' + list.length + ' 个文件，浏览器可能询问是否允许多个下载', 'info', 5200);

        list.forEach(function (result, index) {
            setTimeout(function () { saveResult(result); }, index * 400);
        });

        setTimeout(function () {
            state.savingAll = false;
            renderResults();
        }, list.length * 400 + 800);
    }

    function clearResults() {
        if (state.busy || state.savingAll) return;
        state.results.forEach(function (result) {
            try { URL.revokeObjectURL(result.url); } catch (e) { /* ignore */ }
        });
        state.results = [];
        renderResults();
        log('muted', '已清空结果文件，内存已释放');
    }

    /* ====================================================================
     *  进度 / 忙碌状态
     * ================================================================== */

    function setGlobalProgress(fraction, label, fileText) {
        var value = Math.max(0, Math.min(1, fraction));
        var pct = Math.round(value * 100);
        els.progressBar.style.width = (value * 100).toFixed(1) + '%';
        els.progressPct.textContent = pct + '%';
        els.progressBarWrap.setAttribute('aria-valuenow', String(pct));
        if (typeof label === 'string') els.progressLabel.textContent = label;
        if (typeof fileText === 'string') els.progressFile.textContent = fileText;
    }

    function setBusy(busy) {
        state.busy = busy;

        if (leftPanel) {
            leftPanel.classList.toggle('is-busy', busy);
            leftPanel.setAttribute('aria-busy', busy ? 'true' : 'false');
        }

        els.encryptBtn.disabled = busy;
        els.decryptBtn.disabled = busy;
        els.password.disabled = busy;
        els.ratio.disabled = busy;
        els.fileInput.disabled = busy;
        els.dropzone.setAttribute('aria-disabled', busy ? 'true' : 'false');

        presets.forEach(function (btn) { btn.disabled = busy; });
        document.querySelectorAll('.file-remove').forEach(function (btn) {
            btn.disabled = busy;
        });

        var hasResults = state.results.length > 0;
        els.saveAllBtn.disabled = busy || state.savingAll || !hasResults;
        els.clearResults.disabled = busy || state.savingAll || !hasResults;

        if (!busy) updateQueueMeta();
        else els.clearFiles.disabled = true;
    }

    /* ====================================================================
     *  主流程
     * ================================================================== */

    function isCompatible() {
        return typeof WuSiFormat !== 'undefined' && typeof WuSiCrypto !== 'undefined';
    }

    async function processFiles(mode) {
        if (state.busy) return;

        if (!isCompatible()) {
            toast('加密模块加载失败，请刷新页面重试', 'error', 6000);
            return;
        }

        var password = els.password.value;
        if (!password) {
            toast('请先输入密码', 'warn');
            els.password.focus();
            return;
        }

        var percent = ratioPercent();
        var targets = state.files.filter(function (f) { return f.status !== 'done'; });

        if (!targets.length) {
            toast(state.files.length ? '列表中的文件都已处理完成，可清空列表后重新添加' : '请先添加要处理的文件', 'info');
            if (!state.files.length) els.dropzone.focus();
            return;
        }

        var totalBytes = targets.reduce(function (sum, f) { return sum + f.size; }, 0);
        if (totalBytes > MAX_CONFIRM_BYTES) {
            var proceed = window.confirm(
                '本次需要处理 ' + formatSize(totalBytes) + ' 数据，浏览器会占用较多内存，' +
                '处理大文件可能需要较长时间甚至失败。\n\n仍要继续吗？'
            );
            if (!proceed) return;
        }

        if (mode === 'enc') {
            var alreadyEncrypted = targets.filter(function (f) { return f.encrypted === true; });
            if (alreadyEncrypted.length) {
                var again = window.confirm(
                    '检测到 ' + alreadyEncrypted.length + ' 个文件已经是 PHENC04 加密格式。\n' +
                    '再次加密会对它们进行二次加密，通常不是想要的结果。\n\n仍要继续吗？'
                );
                if (!again) return;
            }
        }

        var runId = ++state.runId;
        var activeBtn = mode === 'enc' ? els.encryptBtn : els.decryptBtn;
        var activeLabel = activeBtn.querySelector('span');
        var originalLabel = activeLabel.textContent;

        setBusy(true);
        activeBtn.classList.add('is-loading');
        activeLabel.textContent = mode === 'enc' ? '加密中…' : '解密中…';
        els.progressCard.hidden = false;
        setGlobalProgress(0,
            mode === 'enc' ? '准备加密…' : '准备解密…',
            '正在派生密钥');

        log('info', mode === 'enc'
            ? '开始加密 ' + targets.length + ' 个文件（比例 ' + percent + '%）'
            : '开始解密 ' + targets.length + ' 个文件');

        var ok = 0;
        var failed = 0;

        try {
            for (var i = 0; i < targets.length; i++) {
                var item = targets[i];
                setFileStatus(item, 'working', '准备中…', 0);
                updateQueueMeta();
                setGlobalProgress(i / targets.length,
                    '正在' + (mode === 'enc' ? '加密' : '解密') + '第 ' + (i + 1) + ' / ' + targets.length + ' 个文件',
                    item.name);

                var onProgress = (function (current, index) {
                    return function (p) {
                        if (state.runId !== runId) return;

                        var fraction = typeof p.fraction === 'number'
                            ? p.fraction
                            : (p.total ? p.done / p.total : 0);
                        fraction = Math.max(0, Math.min(1, fraction));

                        var local;
                        var text;

                        if (p.phase === 'derive') {
                            local = 0.03 + fraction * 0.27;
                            text = '派生密钥 ' + Math.round(fraction * 100) + '%';
                            setGlobalProgress((index + local) / targets.length,
                                '正在' + (mode === 'enc' ? '加密' : '解密') + '第 ' + (index + 1) + ' / ' + targets.length + ' 个文件',
                                current.name + ' · 派生密钥');
                        } else {
                            local = 0.3 + fraction * 0.7;
                            text = (mode === 'enc' ? '加密中 ' : '解密中 ') + Math.round(fraction * 100) + '%';
                            setGlobalProgress((index + local) / targets.length,
                                '正在' + (mode === 'enc' ? '加密' : '解密') + '第 ' + (index + 1) + ' / ' + targets.length + ' 个文件',
                                current.name + ' · ' + (p.done || 0) + '/' + (p.total || 0) + ' 块');
                        }

                        setFileStatus(current, 'working', text, local);
                    };
                })(item, i);

                try {
                    var result = mode === 'enc'
                        ? await WuSiFormat.encryptFile(item.file, {
                            password: password,
                            ratio: percent / 100,
                            onProgress: onProgress
                        })
                        : await WuSiFormat.decryptFile(item.file, {
                            password: password,
                            onProgress: onProgress
                        });

                    var outputName = mode === 'enc' ? item.name + '.enc' : decryptedName(item.name);
                    var url = URL.createObjectURL(result.blob);

                    state.results.unshift({
                        id: ++state.seq,
                        name: outputName,
                        source: item.name,
                        sourceSize: item.size,
                        outputSize: result.blob.size,
                        blocks: result.encCount,
                        totalBlocks: result.totalBlocks,
                        mode: mode,
                        url: url,
                        blob: result.blob
                    });

                    renderResults();
                    setFileStatus(item, 'done', '完成', 1);
                    log('ok', (mode === 'enc' ? '已加密「' : '已解密「') + item.name +
                        '」→ ' + outputName + '（' + formatSize(result.blob.size) + '）');
                    ok++;
                } catch (err) {
                    var message = (err && err.message) ? err.message : '未知错误';
                    setFileStatus(item, 'error', '失败', 0);
                    if (item.stateEl) item.stateEl.title = message;
                    log('err', '「' + item.name + '」处理失败：' + message);
                    failed++;
                }

                updateQueueMeta();
                updateEstimate();

                // 让浏览器有机会刷新界面
                await new Promise(function (resolve) { setTimeout(resolve, 12); });
            }
        } catch (err) {
            var fatal = (err && err.message) ? err.message : String(err);
            log('err', '任务中断：' + fatal);
            toast('任务中断：' + fatal, 'error', 6000);
        } finally {
            if (state.runId === runId) {
                setGlobalProgress(1,
                    failed ? '任务结束（有失败）' : (ok ? '全部完成' : '任务结束'),
                    '结果已保存在下方列表');
            }

            setBusy(false);
            activeBtn.classList.remove('is-loading');
            activeLabel.textContent = originalLabel;
            updateQueueMeta();
            updateEstimate();

            if (state.runId === runId) {
                var summary = failed
                    ? '完成 ' + ok + ' 个，失败 ' + failed + ' 个'
                    : '全部完成（' + ok + ' 个文件）';
                log(failed ? 'warn' : 'ok', '任务结束：' + summary);
                toast(summary + (failed ? '，请查看日志' : '，请在下方保存文件'),
                    failed ? 'warn' : 'success', 5200);

                setTimeout(function () {
                    if (state.runId === runId && !state.busy) {
                        els.progressCard.hidden = true;
                    }
                }, 2400);
            }
        }
    }

    /* ====================================================================
     *  事件绑定
     * ================================================================== */

    els.themeBtn.addEventListener('click', function () {
        var next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
        setTheme(next, true);
    });

    els.togglePw.addEventListener('click', function () {
        var visible = els.togglePw.getAttribute('aria-pressed') !== 'true';
        els.password.type = visible ? 'text' : 'password';
        els.togglePw.setAttribute('aria-pressed', visible ? 'true' : 'false');
        els.togglePw.setAttribute('aria-label', visible ? '隐藏密码' : '显示密码');
        els.togglePw.title = visible ? '隐藏密码' : '显示密码';
        if (visible) els.password.focus();
    });

    els.ratio.addEventListener('input', updateRatioUI);
    els.ratio.addEventListener('change', updateRatioUI);

    presets.forEach(function (btn) {
        btn.addEventListener('click', function () {
            if (state.busy) return;
            els.ratio.value = btn.dataset.ratio;
            updateRatioUI();
        });
    });

    els.dropzone.addEventListener('click', function () {
        if (state.busy) return;
        els.fileInput.click();
    });

    els.dropzone.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            if (!state.busy) els.fileInput.click();
        }
    });

    els.fileInput.addEventListener('change', function () {
        addFiles(els.fileInput.files);
        els.fileInput.value = '';
    });

    els.fileList.addEventListener('click', function (e) {
        var removeBtn = e.target.closest('.file-remove');
        if (!removeBtn) return;
        var row = removeBtn.closest('.file-item');
        if (!row) return;
        var item = state.files.find(function (f) { return String(f.id) === row.dataset.id; });
        if (item) removeFile(item);
    });

    els.clearFiles.addEventListener('click', clearFiles);
    els.clearLog.addEventListener('click', clearLog);
    els.clearResults.addEventListener('click', clearResults);
    els.saveAllBtn.addEventListener('click', saveAllResults);

    els.encryptBtn.addEventListener('click', function () { processFiles('enc'); });
    els.decryptBtn.addEventListener('click', function () { processFiles('dec'); });

    // 拖放：拖到拖放区或页面任意位置
    var dragDepth = 0;

    els.dropzone.addEventListener('dragenter', function (e) {
        e.preventDefault();
        e.stopPropagation();
        if (state.busy) return;
        dragDepth++;
        els.dropzone.classList.add('is-dragover');
    });

    els.dropzone.addEventListener('dragover', function (e) {
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    });

    els.dropzone.addEventListener('dragleave', function (e) {
        e.preventDefault();
        e.stopPropagation();
        dragDepth = Math.max(0, dragDepth - 1);
        if (!dragDepth) els.dropzone.classList.remove('is-dragover');
    });

    els.dropzone.addEventListener('drop', function (e) {
        e.preventDefault();
        e.stopPropagation();
        dragDepth = 0;
        els.dropzone.classList.remove('is-dragover');
        if (state.busy) return;
        addFiles(e.dataTransfer && e.dataTransfer.files);
    });

    window.addEventListener('dragover', function (e) {
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        e.preventDefault();
    });

    window.addEventListener('drop', function (e) {
        e.preventDefault();
        if (state.busy) return;
        if (e.target && e.target.closest && e.target.closest('#dropzone')) return;
        addFiles(e.dataTransfer && e.dataTransfer.files);
    });

    window.addEventListener('beforeunload', function (e) {
        if (state.busy) {
            e.preventDefault();
            e.returnValue = '';
        }
    });

    // 初始化
    initTheme();
    updateRatioUI();
    renderFileList();
    renderResults();
    updateQueueMeta();
    updateEstimate();
})();
