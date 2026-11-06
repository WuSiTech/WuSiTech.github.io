/*!
 * WuSi Web · format.js
 * PHENC04 文件容器的浏览器实现，与桌面版 WuSi_Encrypter 读写互通。
 *
 * 文件布局（小端）：
 *   [原始数据 originalSize][record × encCount][fixed 36B]
 *   record: idx(4) + nonce(12) + tag(32)
 *   fixed : magic "PHENC04\0"(8) + blockSize(4) + totalBlocks(4)
 *           + encCount(4) + salt(16)
 */
(function (global) {
    'use strict';

    var C = global.WuSiCrypto;
    if (!C) throw new Error('crypto.js 未加载');

    var BLOCK_SIZE = 1024 * 1024;
    var SALT_LEN = 16;
    var NONCE_LEN = 12;
    var TAG_LEN = 32;
    var KEY_LEN = 32;
    var ITERATIONS = 100000;
    var FOOTER_LEN = 8 + 4 + 4 + 4 + SALT_LEN;   // 36
    var RECORD_LEN = 4 + NONCE_LEN + TAG_LEN;    // 48
    var MAX_BLOCK_SIZE = 256 * 1024 * 1024;

    var MAGIC = new Uint8Array([0x50, 0x48, 0x45, 0x4e, 0x43, 0x30, 0x34, 0x00]); // "PHENC04\0"
    var encoder = new TextEncoder();

    var lastYield = 0;

    function nextTick() {
        return new Promise(function (resolve) {
            if (typeof setTimeout === 'function') setTimeout(resolve, 0);
            else resolve();
        });
    }

    function now() {
        return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    }

    // 让出主线程，保证进度条和日志可以刷新
    function yieldToUI(force) {
        var t = now();
        if (force || t - lastYield > 24) {
            lastYield = t;
            return nextTick().then(function () { lastYield = now(); });
        }
        return Promise.resolve();
    }

    function readSlice(blob, start, end) {
        var part = (start === 0 && end === blob.size) ? blob : blob.slice(start, end);
        return part.arrayBuffer().then(function (buf) {
            return new Uint8Array(buf);
        });
    }

    function report(onProgress, payload) {
        if (typeof onProgress === 'function') {
            try { onProgress(payload); } catch (e) { /* 进度回调不应影响主流程 */ }
        }
    }

    function readU32(bytes, offset) {
        return (bytes[offset] | (bytes[offset + 1] << 8) |
            (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
    }

    /* ====================================================================
     *  加密
     * ================================================================== */

    /**
     * @param {Blob|File} file
     * @param {{password:string|Uint8Array, ratio:number, onProgress?:Function}} options
     * @returns {Promise<{blob:Blob, originalSize:number, totalBlocks:number,
     *                    encCount:number, blockSize:number, salt:Uint8Array}>}
     */
    function encryptFile(file, options) {
        options = options || {};
        var password = options.password;
        var ratio = options.ratio;
        var onProgress = options.onProgress;

        var size = file.size;
        if (!size) return Promise.reject(new Error('文件为空，无法加密'));
        if (typeof password === 'string') {
            if (!password.length) return Promise.reject(new Error('密码不能为空'));
            password = encoder.encode(password);
        }
        if (!password || !password.length) return Promise.reject(new Error('密码不能为空'));

        if (typeof ratio !== 'number' || !isFinite(ratio)) ratio = 0.25;
        ratio = Math.min(1, Math.max(0.01, ratio));

        var totalBlocks = Math.max(1, Math.ceil(size / BLOCK_SIZE));
        var encCount = Math.floor(totalBlocks * ratio + 0.5);
        encCount = Math.min(Math.max(encCount, 1), totalBlocks);

        var indices = C.pickBlockIndices(totalBlocks, encCount);
        var salt = C.randomBytes(SALT_LEN);

        report(onProgress, {
            phase: 'derive', done: 0, total: 1,
            blocksDone: 0, blocksTotal: encCount, totalBlocks: totalBlocks
        });

        return C.deriveKey(password, salt, ITERATIONS, KEY_LEN * 2, function (fraction) {
            report(onProgress, {
                phase: 'derive', done: fraction, total: 1, fraction: fraction,
                blocksDone: 0, blocksTotal: encCount, totalBlocks: totalBlocks
            });
        }).then(function (keyMaterial) {
            var encKey = keyMaterial.slice(0, KEY_LEN);
            var macKey = keyMaterial.slice(KEY_LEN, KEY_LEN * 2);
            var hmac = new C.HMAC(macKey);

            report(onProgress, {
                phase: 'encrypt', done: 0, total: encCount,
                blocksDone: 0, blocksTotal: encCount, totalBlocks: totalBlocks
            });

            var records = new Uint8Array(encCount * RECORD_LEN);
            var recordsView = new DataView(records.buffer);
            var parts = [];
            var cursor = 0;
            var chain = Promise.resolve();

            indices.forEach(function (blockIndex, i) {
                chain = chain.then(function () {
                    var start = blockIndex * BLOCK_SIZE;
                    var end = Math.min(size, start + BLOCK_SIZE);
                    var actualSize = end - start;

                    if (start > cursor) parts.push(file.slice(cursor, start));

                    return readSlice(file, start, end).then(function (block) {
                        var nonce = C.randomBytes(NONCE_LEN);
                        var chacha = new C.ChaCha20(encKey, nonce);
                        chacha.xor(block);

                        var recOffset = i * RECORD_LEN;
                        recordsView.setUint32(recOffset, blockIndex, true);
                        records.set(nonce, recOffset + 4);
                        var tag = hmac.sign([C.u32le(blockIndex), salt, nonce, block]);
                        records.set(tag, recOffset + 16);

                        parts.push(block);
                        cursor = end;

                        report(onProgress, {
                            phase: 'encrypt',
                            done: i + 1,
                            total: encCount,
                            fraction: (i + 1) / encCount,
                            blocksDone: i + 1,
                            blocksTotal: encCount,
                            totalBlocks: totalBlocks,
                            bytesDone: end,
                            bytesTotal: size
                        });

                        return yieldToUI();
                    });
                });
            });

            return chain.then(function () {
                if (cursor < size) parts.push(file.slice(cursor, size));

                var fixed = new Uint8Array(FOOTER_LEN);
                fixed.set(MAGIC, 0);
                var view = new DataView(fixed.buffer);
                view.setUint32(8, BLOCK_SIZE, true);
                view.setUint32(12, totalBlocks, true);
                view.setUint32(16, encCount, true);
                fixed.set(salt, 20);

                parts.push(records, fixed);

                report(onProgress, {
                    phase: 'done', done: encCount, total: encCount, fraction: 1,
                    blocksDone: encCount, blocksTotal: encCount,
                    totalBlocks: totalBlocks, bytesDone: size, bytesTotal: size
                });

                return {
                    blob: new Blob(parts, { type: 'application/octet-stream' }),
                    originalSize: size,
                    totalBlocks: totalBlocks,
                    encCount: encCount,
                    blockSize: BLOCK_SIZE,
                    salt: salt
                };
            });
        });
    }

    /* ====================================================================
     *  解密
     * ================================================================== */

    /**
     * @param {Blob|File} file
     * @param {{password:string|Uint8Array, onProgress?:Function}} options
     * @returns {Promise<{blob:Blob, originalSize:number, totalBlocks:number,
     *                    encCount:number, blockSize:number}>}
     */
    function decryptFile(file, options) {
        options = options || {};
        var password = options.password;
        var onProgress = options.onProgress;

        if (typeof password === 'string') {
            if (!password.length) return Promise.reject(new Error('密码不能为空'));
            password = encoder.encode(password);
        }
        if (!password || !password.length) return Promise.reject(new Error('密码不能为空'));

        var size = file.size;
        if (size < FOOTER_LEN) return Promise.reject(new Error('文件过小，不是本程序加密的文件'));

        return readSlice(file, size - FOOTER_LEN, size).then(function (tail) {
            if (!C.equalBytes(tail.subarray(0, 8), MAGIC)) {
                throw new Error('不是 PHENC04 加密文件（缺少尾部标识）');
            }

            var view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
            var blockSize = view.getUint32(8, true);
            var totalBlocks = view.getUint32(12, true);
            var encCount = view.getUint32(16, true);
            var salt = tail.slice(20, 20 + SALT_LEN);

            if (blockSize === 0 || blockSize > MAX_BLOCK_SIZE) throw new Error('尾部信息无效（块大小异常）');
            if (encCount === 0 || totalBlocks === 0 || encCount > totalBlocks) {
                throw new Error('尾部信息无效（块数量异常）');
            }

            var recordsSize = encCount * RECORD_LEN;
            if (size < FOOTER_LEN + recordsSize) throw new Error('文件结构异常（记录区不完整）');

            var originalSize = size - FOOTER_LEN - recordsSize;
            if (originalSize <= 0) throw new Error('文件结构异常（原始大小无效）');

            var recordsStart = originalSize;

            return readSlice(file, recordsStart, recordsStart + recordsSize).then(function (recordBytes) {
                var records = new Array(encCount);
                for (var i = 0; i < encCount; i++) {
                    var off = i * RECORD_LEN;
                    var idx = readU32(recordBytes, off);
                    if (idx >= totalBlocks) throw new Error('块索引无效（文件可能已损坏）');

                    var blockStart = idx * blockSize;
                    if (blockStart >= originalSize) throw new Error('块索引超出文件范围（文件可能已损坏）');

                    var actualSize = Math.min(blockSize, originalSize - blockStart);
                    if (actualSize <= 0) throw new Error('块大小为零（文件可能已损坏）');

                    records[i] = {
                        idx: idx,
                        start: blockStart,
                        end: blockStart + actualSize,
                        nonce: recordBytes.slice(off + 4, off + 4 + NONCE_LEN),
                        tag: recordBytes.slice(off + 16, off + 16 + TAG_LEN)
                    };
                }

                records.sort(function (a, b) { return a.idx - b.idx; });

                var maxEnd = 0;
                for (i = 0; i < records.length; i++) {
                    if (records[i].start < maxEnd) throw new Error('记录区重叠（文件可能已损坏）');
                    maxEnd = records[i].end;
                }

                report(onProgress, {
                    phase: 'derive', done: 0, total: 1,
                    blocksDone: 0, blocksTotal: encCount, totalBlocks: totalBlocks
                });

                return C.deriveKey(password, salt, ITERATIONS, KEY_LEN * 2, function (fraction) {
                    report(onProgress, {
                        phase: 'derive', done: fraction, total: 1, fraction: fraction,
                        blocksDone: 0, blocksTotal: encCount, totalBlocks: totalBlocks
                    });
                }).then(function (keyMaterial) {
                    var encKey = keyMaterial.slice(0, KEY_LEN);
                    var macKey = keyMaterial.slice(KEY_LEN, KEY_LEN * 2);
                    var hmac = new C.HMAC(macKey);

                    report(onProgress, {
                        phase: 'decrypt', done: 0, total: encCount,
                        blocksDone: 0, blocksTotal: encCount, totalBlocks: totalBlocks
                    });

                    var parts = [];
                    var cursor = 0;
                    var chain = Promise.resolve();

                    records.forEach(function (rec, i) {
                        chain = chain.then(function () {
                            if (rec.start > cursor) parts.push(file.slice(cursor, rec.start));

                            return readSlice(file, rec.start, rec.end).then(function (block) {
                                var tag = hmac.sign([
                                    C.u32le(rec.idx), salt, rec.nonce, block
                                ]);

                                if (!C.equalBytes(tag, rec.tag)) {
                                    throw new Error('认证失败（密码错误或文件损坏）');
                                }

                                var chacha = new C.ChaCha20(encKey, rec.nonce);
                                chacha.xor(block);

                                parts.push(block);
                                cursor = rec.end;

                                report(onProgress, {
                                    phase: 'decrypt',
                                    done: i + 1,
                                    total: encCount,
                                    fraction: (i + 1) / encCount,
                                    blocksDone: i + 1,
                                    blocksTotal: encCount,
                                    totalBlocks: totalBlocks,
                                    bytesDone: rec.end,
                                    bytesTotal: originalSize
                                });

                                return yieldToUI();
                            });
                        });
                    });

                    return chain.then(function () {
                        if (cursor < originalSize) parts.push(file.slice(cursor, originalSize));

                        report(onProgress, {
                            phase: 'done', done: encCount, total: encCount, fraction: 1,
                            blocksDone: encCount, blocksTotal: encCount,
                            totalBlocks: totalBlocks,
                            bytesDone: originalSize,
                            bytesTotal: originalSize
                        });

                        return {
                            blob: new Blob(parts, { type: 'application/octet-stream' }),
                            originalSize: originalSize,
                            totalBlocks: totalBlocks,
                            encCount: encCount,
                            blockSize: blockSize
                        };
                    });
                });
            });
        });
    }

    /* ====================================================================
     *  探测 / 工具
     * ================================================================== */

    function looksEncrypted(file) {
        if (!file || file.size < FOOTER_LEN) return Promise.resolve(false);
        return readSlice(file, file.size - FOOTER_LEN, file.size)
            .then(function (tail) { return C.equalBytes(tail.subarray(0, 8), MAGIC); })
            .catch(function () { return false; });
    }

    // 按当前比例估算单个文件会被改写的块数与元数据开销
    function estimate(fileSize, ratio) {
        var totalBlocks = Math.max(1, Math.ceil(fileSize / BLOCK_SIZE));
        var encCount = Math.floor(totalBlocks * ratio + 0.5);
        encCount = Math.min(Math.max(encCount, 1), totalBlocks);
        return {
            totalBlocks: totalBlocks,
            encCount: encCount,
            overhead: encCount * RECORD_LEN + FOOTER_LEN
        };
    }

    global.WuSiFormat = {
        BLOCK_SIZE: BLOCK_SIZE,
        FOOTER_LEN: FOOTER_LEN,
        RECORD_LEN: RECORD_LEN,
        ITERATIONS: ITERATIONS,
        encryptFile: encryptFile,
        decryptFile: decryptFile,
        looksEncrypted: looksEncrypted,
        estimate: estimate
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
