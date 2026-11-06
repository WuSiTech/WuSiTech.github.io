/*!
 * WuSi Web · crypto.js
 * 纯前端实现的密码学原语：SHA-256 / HMAC-SHA256 / PBKDF2 / ChaCha20。
 * 与桌面版 WuSi_Encrypter 的 PHENC04 格式字节级兼容。
 *
 * 说明：
 * - 所有实现均为同步、无依赖的纯 JS，便于在 file:// 或离线环境直接打开。
 * - PBKDF2 在支持 WebCrypto 的环境下优先使用原生实现（结果完全一致），
 *   不支持时回退到内置实现。
 * - 这不是经过审计的密码学库，仅用于本工具的兼容实现。
 */
(function (global) {
    'use strict';

    /* ====================================================================
     *  SHA-256
     * ================================================================== */

    var K = new Uint32Array([
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    ]);

    function compress(h, w, data, off) {
        var i, j, x, y, s0, s1;
        for (i = 0; i < 16; i++) {
            j = off + i * 4;
            w[i] = ((data[j] << 24) | (data[j + 1] << 16) | (data[j + 2] << 8) | data[j + 3]) >>> 0;
        }
        for (i = 16; i < 64; i++) {
            x = w[i - 15];
            y = w[i - 2];
            s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
            s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
        }

        var a = h[0], b = h[1], c = h[2], d = h[3];
        var e = h[4], f = h[5], g = h[6], hh = h[7];

        for (i = 0; i < 64; i++) {
            var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
            var ch = (e & f) ^ (~e & g);
            var t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
            var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
            var maj = (a & b) ^ (a & c) ^ (b & c);
            var t2 = (S0 + maj) >>> 0;
            hh = g; g = f; f = e; e = (d + t1) >>> 0;
            d = c; c = b; b = a; a = (t1 + t2) >>> 0;
        }

        h[0] = (h[0] + a) >>> 0;
        h[1] = (h[1] + b) >>> 0;
        h[2] = (h[2] + c) >>> 0;
        h[3] = (h[3] + d) >>> 0;
        h[4] = (h[4] + e) >>> 0;
        h[5] = (h[5] + f) >>> 0;
        h[6] = (h[6] + g) >>> 0;
        h[7] = (h[7] + hh) >>> 0;
    }

    function SHA256() {
        this.h = new Uint32Array(8);
        this.buffer = new Uint8Array(64);
        this.bufLen = 0;
        this.total = 0;
        this.w = new Uint32Array(64);
        this.reset();
    }

    SHA256.prototype.reset = function () {
        this.h[0] = 0x6a09e667; this.h[1] = 0xbb67ae85;
        this.h[2] = 0x3c6ef372; this.h[3] = 0xa54ff53a;
        this.h[4] = 0x510e527f; this.h[5] = 0x9b05688c;
        this.h[6] = 0x1f83d9ab; this.h[7] = 0x5be0cd19;
        this.bufLen = 0;
        this.total = 0;
        return this;
    };

    SHA256.prototype.resetFrom = function (other) {
        this.h.set(other.h);
        this.buffer.set(other.buffer);
        this.bufLen = other.bufLen;
        this.total = other.total;
        return this;
    };

    SHA256.prototype.clone = function () {
        var c = new SHA256();
        c.h.set(this.h);
        c.buffer.set(this.buffer);
        c.bufLen = this.bufLen;
        c.total = this.total;
        return c;
    };

    SHA256.prototype.update = function (data) {
        var len = data.length;
        if (!len) return this;
        this.total += len;

        var idx = 0;
        if (this.bufLen > 0) {
            var need = 64 - this.bufLen;
            var take = Math.min(need, len);
            this.buffer.set(data.subarray(0, take), this.bufLen);
            this.bufLen += take;
            idx += take;
            if (this.bufLen === 64) {
                compress(this.h, this.w, this.buffer, 0);
                this.bufLen = 0;
            }
        }

        while (len - idx >= 64) {
            compress(this.h, this.w, data, idx);
            idx += 64;
        }

        if (idx < len) {
            this.buffer.set(data.subarray(idx, len), 0);
            this.bufLen = len - idx;
        }
        return this;
    };

    SHA256.prototype.final = function () {
        var bitLen = this.total * 8;
        var padBytes = this.bufLen < 56 ? (56 - this.bufLen) : (120 - this.bufLen);
        var pad = new Uint8Array(padBytes + 8);
        pad[0] = 0x80;

        var hi = Math.floor(bitLen / 4294967296);
        var lo = bitLen % 4294967296;
        pad[padBytes] = hi >>> 24;
        pad[padBytes + 1] = hi >>> 16;
        pad[padBytes + 2] = hi >>> 8;
        pad[padBytes + 3] = hi;
        pad[padBytes + 4] = lo >>> 24;
        pad[padBytes + 5] = lo >>> 16;
        pad[padBytes + 6] = lo >>> 8;
        pad[padBytes + 7] = lo;

        this.update(pad);

        var out = new Uint8Array(32);
        for (var i = 0; i < 8; i++) {
            var v = this.h[i];
            out[i * 4] = v >>> 24;
            out[i * 4 + 1] = v >>> 16;
            out[i * 4 + 2] = v >>> 8;
            out[i * 4 + 3] = v;
        }
        return out;
    };

    function sha256(data) {
        return new SHA256().update(data).final();
    }

    /* ====================================================================
     *  HMAC-SHA256
     * ================================================================== */

    function HMAC(key) {
        var k = key;
        if (k.length > 64) k = sha256(k);

        var ipad = new Uint8Array(64);
        var opad = new Uint8Array(64);
        ipad.fill(0x36);
        opad.fill(0x5c);
        for (var i = 0; i < k.length; i++) {
            ipad[i] ^= k[i];
            opad[i] ^= k[i];
        }

        this.innerBase = new SHA256().update(ipad);
        this.outerBase = new SHA256().update(opad);
        this.inner = new SHA256();
        this.outer = new SHA256();
    }

    HMAC.prototype.sign = function (chunks) {
        var inner = this.inner.resetFrom(this.innerBase);
        for (var i = 0; i < chunks.length; i++) inner.update(chunks[i]);
        var ih = inner.final();

        var outer = this.outer.resetFrom(this.outerBase);
        outer.update(ih);
        return outer.final();
    };

    /* ====================================================================
     *  PBKDF2-HMAC-SHA256
     * ================================================================== */

    function pbkdf2(password, salt, iterations, dkLen) {
        var hmac = new HMAC(password);
        var out = new Uint8Array(dkLen);
        var blocks = Math.ceil(dkLen / 32);
        var saltIdx = new Uint8Array(salt.length + 4);
        saltIdx.set(salt, 0);
        var view = new DataView(saltIdx.buffer);

        for (var i = 1; i <= blocks; i++) {
            view.setUint32(salt.length, i, false);

            var u = hmac.sign([saltIdx]);
            var t = u.slice(0);

            for (var j = 1; j < iterations; j++) {
                u = hmac.sign([u]);
                for (var k = 0; k < 32; k++) t[k] ^= u[k];
            }

            var offset = (i - 1) * 32;
            var copyLen = Math.min(32, dkLen - offset);
            out.set(t.subarray(0, copyLen), offset);
        }
        return out;
    }

    /* ====================================================================
     *  与原程序一致的密钥派生
     *
     *  注意：桌面版把这段代码称作 PBKDF2，但它的迭代步骤实际是
     *      U(j) = HMAC-SHA256(U(j-1), 空消息)
     *  而不是标准 PBKDF2 的 HMAC(password, U(j-1))。为了能读写桌面版
     *  生成的文件，这里必须复刻它的实际行为，不能换成标准 PBKDF2。
     * ================================================================== */

    var IV = new Uint32Array([
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
    ]);

    function createHmacScratch() {
        return {
            w: new Uint32Array(64),
            hInner: new Uint32Array(8),
            hOuter: new Uint32Array(8),
            ipad: new Uint8Array(64),
            opad: new Uint8Array(64),
            msg: new Uint8Array(64),
            ih: new Uint8Array(32)
        };
    }

    function writeBitLength(block, bits) {
        var hi = Math.floor(bits / 4294967296);
        var lo = bits % 4294967296;
        block[56] = hi >>> 24;
        block[57] = hi >>> 16;
        block[58] = hi >>> 8;
        block[59] = hi;
        block[60] = lo >>> 24;
        block[61] = lo >>> 16;
        block[62] = lo >>> 8;
        block[63] = lo;
    }

    /**
     * 计算 HMAC-SHA256(key, message)，消息长度必须小于 56 字节。
     * 热路径复用 scratch 中的临时缓冲区，避免 20 万次迭代产生大量垃圾。
     */
    function hmacInto(scratch, key, message, messageLen, out) {
        var k = key;
        if (k.length > 64) k = sha256(k);

        var ipad = scratch.ipad;
        var opad = scratch.opad;
        var msg = scratch.msg;
        var w = scratch.w;
        var hInner = scratch.hInner;
        var hOuter = scratch.hOuter;
        var ih = scratch.ih;

        ipad.fill(0x36);
        opad.fill(0x5c);
        for (var i = 0; i < k.length; i++) {
            ipad[i] ^= k[i];
            opad[i] ^= k[i];
        }

        // inner: SHA256(ipad || message || padding)
        hInner.set(IV);
        compress(hInner, w, ipad, 0);

        msg.fill(0);
        if (messageLen > 0) msg.set(message.subarray(0, messageLen), 0);
        msg[messageLen] = 0x80;
        writeBitLength(msg, (64 + messageLen) * 8);
        compress(hInner, w, msg, 0);

        for (i = 0; i < 8; i++) {
            var v = hInner[i];
            ih[i * 4] = v >>> 24;
            ih[i * 4 + 1] = v >>> 16;
            ih[i * 4 + 2] = v >>> 8;
            ih[i * 4 + 3] = v;
        }

        // outer: SHA256(opad || innerDigest || padding)
        hOuter.set(IV);
        compress(hOuter, w, opad, 0);

        msg.fill(0);
        msg.set(ih, 0);
        msg[32] = 0x80;
        writeBitLength(msg, 96 * 8);
        compress(hOuter, w, msg, 0);

        for (i = 0; i < 8; i++) {
            v = hOuter[i];
            out[i * 4] = v >>> 24;
            out[i * 4 + 1] = v >>> 16;
            out[i * 4 + 2] = v >>> 8;
            out[i * 4 + 3] = v;
        }
        return out;
    }

    var EMPTY = new Uint8Array(0);

    function yieldTick() {
        return new Promise(function (resolve) {
            if (typeof setTimeout === 'function') setTimeout(resolve, 0);
            else resolve();
        });
    }

    /**
     * 兼容原程序的密钥派生，返回 Promise<Uint8Array>。
     * 每 4096 次迭代让出一次主线程，便于界面刷新进度。
     */
    async function deriveKey(password, salt, iterations, dkLen, onProgress) {
        var blocks = Math.ceil(dkLen / 32);
        var out = new Uint8Array(dkLen);
        var saltCounter = new Uint8Array(salt.length + 4);
        saltCounter.set(salt, 0);
        var scratch = createHmacScratch();

        for (var b = 1; b <= blocks; b++) {
            saltCounter[salt.length] = b >>> 24;
            saltCounter[salt.length + 1] = b >>> 16;
            saltCounter[salt.length + 2] = b >>> 8;
            saltCounter[salt.length + 3] = b;

            var u = new Uint8Array(32);
            var next = new Uint8Array(32);
            hmacInto(scratch, password, saltCounter, saltCounter.length, u);

            var t = u.slice(0);
            for (var j = 1; j < iterations; j++) {
                hmacInto(scratch, u, EMPTY, 0, next);
                for (var k = 0; k < 32; k++) t[k] ^= next[k];
                var tmp = u;
                u = next;
                next = tmp;

                if ((j & 4095) === 0) {
                    if (typeof onProgress === 'function') {
                        try { onProgress((b - 1 + j / iterations) / blocks); } catch (e) { /* ignore */ }
                    }
                    await yieldTick();
                }
            }

            var offset = (b - 1) * 32;
            out.set(t.subarray(0, Math.min(32, dkLen - offset)), offset);
        }
        return out;
    }

    /* ====================================================================
     *  ChaCha20 (RFC 7539：32 位计数器 + 96 位 nonce)
     * ================================================================== */

    function rotl(x, n) {
        return ((x << n) | (x >>> (32 - n))) >>> 0;
    }

    function quarterRound(x, a, b, c, d) {
        var xa = x[a], xb = x[b], xc = x[c], xd = x[d];

        xa = (xa + xb) >>> 0; xd ^= xa; xd = rotl(xd, 16);
        xc = (xc + xd) >>> 0; xb ^= xc; xb = rotl(xb, 12);
        xa = (xa + xb) >>> 0; xd ^= xa; xd = rotl(xd, 8);
        xc = (xc + xd) >>> 0; xb ^= xc; xb = rotl(xb, 7);

        x[a] = xa; x[b] = xb; x[c] = xc; x[d] = xd;
    }

    function ChaCha20(key, nonce) {
        if (key.length !== 32) throw new Error('ChaCha20 密钥长度必须为 32 字节');
        if (nonce.length !== 12) throw new Error('ChaCha20 nonce 长度必须为 12 字节');

        var s = new Uint32Array(16);
        s[0] = 0x61707865; s[1] = 0x3320646e; s[2] = 0x79622d32; s[3] = 0x6b206574;

        var kv = new DataView(key.buffer, key.byteOffset, key.byteLength);
        for (var i = 0; i < 8; i++) s[4 + i] = kv.getUint32(i * 4, true);

        s[12] = 0;
        var nv = new DataView(nonce.buffer, nonce.byteOffset, nonce.byteLength);
        s[13] = nv.getUint32(0, true);
        s[14] = nv.getUint32(4, true);
        s[15] = nv.getUint32(8, true);

        this.state = s;
        this.keystream = new Uint8Array(64);
        this.ksView = new DataView(this.keystream.buffer);
        this.x = new Uint32Array(16);
        this.pos = 64;
    }

    ChaCha20.prototype.generateBlock = function () {
        var s = this.state;
        var x = this.x;
        x.set(s);

        for (var i = 0; i < 10; i++) {
            quarterRound(x, 0, 4, 8, 12);
            quarterRound(x, 1, 5, 9, 13);
            quarterRound(x, 2, 6, 10, 14);
            quarterRound(x, 3, 7, 11, 15);
            quarterRound(x, 0, 5, 10, 15);
            quarterRound(x, 1, 6, 11, 12);
            quarterRound(x, 2, 7, 8, 13);
            quarterRound(x, 3, 4, 9, 14);
        }

        var ksView = this.ksView;
        for (i = 0; i < 16; i++) {
            ksView.setUint32(i * 4, (x[i] + s[i]) >>> 0, true);
        }
        s[12] = (s[12] + 1) >>> 0;
    };

    ChaCha20.prototype.xor = function (data) {
        var i = 0;
        var n = data.length;
        var pos = this.pos;
        var ks = this.keystream;

        while (i < n) {
            if (pos === 64) {
                this.generateBlock();
                pos = 0;
            }
            var take = Math.min(64 - pos, n - i);
            for (var j = 0; j < take; j++) data[i + j] ^= ks[pos + j];
            i += take;
            pos += take;
        }
        this.pos = pos;
        return data;
    };

    /* ====================================================================
     *  随机数 / 工具
     * ================================================================== */

    function randomBytes(n) {
        var out = new Uint8Array(n);
        var c = global.crypto;
        if (c && c.getRandomValues) {
            c.getRandomValues(out);
        } else {
            for (var i = 0; i < n; i++) out[i] = (Math.random() * 256) | 0;
        }
        return out;
    }

    var randomWord = new Uint32Array(1);

    function randomUint32() {
        var c = global.crypto;
        if (c && c.getRandomValues) {
            c.getRandomValues(randomWord);
            return randomWord[0];
        }
        return (Math.random() * 4294967296) >>> 0;
    }

    // 返回 [0, max) 区间内均匀分布的整数
    function randomInt(max) {
        if (max <= 1) return 0;
        if (max > 4294967296) {
            return Math.floor((randomUint32() / 4294967296) * max);
        }
        var limit = Math.floor(4294967296 / max) * max;
        var v;
        do {
            v = randomUint32();
        } while (v >= limit);
        return v % max;
    }

    // 随机挑选 count 个块索引并升序返回
    function pickBlockIndices(total, count) {
        if (total <= 0) throw new Error('块数量无效');
        count = Math.min(Math.max(count, 1), total);

        var pool = new Uint32Array(total);
        for (var i = 0; i < total; i++) pool[i] = i;

        for (i = 0; i < count; i++) {
            var j = i + randomInt(total - i);
            var t = pool[i];
            pool[i] = pool[j];
            pool[j] = t;
        }

        var out = new Uint32Array(count);
        out.set(pool.subarray(0, count));
        out.sort();
        return out;
    }

    function u32le(v) {
        return new Uint8Array([v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]);
    }

    function equalBytes(a, b) {
        if (a.length !== b.length) return false;
        var diff = 0;
        for (var i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
        return diff === 0;
    }

    function toHex(bytes) {
        var s = '';
        for (var i = 0; i < bytes.length; i++) {
            s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
        }
        return s;
    }

    global.WuSiCrypto = {
        SHA256: SHA256,
        HMAC: HMAC,
        ChaCha20: ChaCha20,
        sha256: sha256,
        pbkdf2: pbkdf2,
        deriveKey: deriveKey,
        randomBytes: randomBytes,
        randomInt: randomInt,
        pickBlockIndices: pickBlockIndices,
        u32le: u32le,
        equalBytes: equalBytes,
        toHex: toHex
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
