/* 形状重绘：把立绘重画成「纸 / 红 / 黑」三色剪纸形状（直边折角、平涂、没有渐变）。
 *
 * 四步：① 色块：平滑（金字塔 mean-shift）+ Lab 空间 k-means（K=9）
 *      ② 三色：每个色块按色相 / 彩度 / 明度分给纸、红、黑；9×9 众数滤波两遍；小碎块并入纸
 *      ③ 分块：小于人物 0.4% 的碎块（任何颜色）并进四周最多的颜色；纸色区域再按原画的线稿和颜色切成大块（头发、脸、
 *              帽子、袖子…，眼睛、嘴、阴影都并掉），块和块之间留一条和外轮廓一样粗的分块线（pieceMin: 0 关掉）。
 *              线稿（黑帽变换抠出的细暗线）默认不画进剪纸：脸是一整块纸；lines: true 才画
 *      ④ 直边：沿像素边描出每层轮廓（含洞），Douglas–Peucker 拉直（默认容差 5），偶奇规则填色；贴着外轮廓的
 *              红块、黑块折点挪到外形边上（补缝）
 *
 * 纯函数 + 类型数组，不依赖任何库；浏览器里是 window.ShapeRedraw，Node 里 require('./redraw.js')。
 * 步骤和参数照一份 Python + OpenCV 的参考实现移植；平滑、k-means++ 初始化、描轮廓、拉直按 OpenCV（Apache-2.0）
 * 的算法重写，好和它的结果对齐。和参考实现不同的地方：k-means 在 6 bit 颜色直方图上做（快，但随机数不同，
 * 卡在门槛边上的色块可能分到别的角色）；多了一条「人物里黑太少就把最暗的色块补成黑」；第 ② 步之后多了
 * 「小碎块并进大块」和「分块线」，默认不画线稿、直边容差 5（参考实现画线稿、容差 4），所以剪纸成品比参考实现块大、
 * 没有五官。第 ② 步的三色图（layers() 返回的 cls3）照参考实现的规则算，没动过。
 * MIT 许可，见 LICENSE。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ShapeRedraw = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULTS = {
    height: 1400,      // 处理高度（人物裁掉透明边后缩放到这个高度）
    k: 9,              // 色块数
    sp: 7, sr: 22,     // 平滑：空间半径、颜色半径
    redMin: 0.004,     // 红碎块 < 人物面积 0.4% → 并入纸（同参考实现）
    blackMin: 0.0006,  // 黑碎块 < 0.06% → 并入纸
    blackLow: 0.08,    // 自动分色时人物里黑 < 8%：把最暗的色块（L < blackLowL）补成黑。参考实现没有这条；设 0 关掉
    blackLowL: 60,
    mergeMin: 0.004,   // 大块：三色图里 < 人物面积 0.4% 的碎块（任何颜色）并进四周最多的那种颜色。参考实现没有这步；设 0 关掉
    pieceMin: 0.006,   // 分块：纸色里的大块（头发、脸、衣服…）之间画分块线；< 人物面积 0.6% 的格子并进邻格。参考实现没有这步；设 0 关掉
    pieceGrow: 5,      // 分块 ① 切格子：相邻像素的颜色差（Lab，明度按 1/pieceKL 算）< 这个数才连成一格
    pieceKL: 1.5,
    pieceTiny: 30,     // < 这么多像素的碎格先拆掉，分给四周
    pieceSupport: 0.35, // 分块 ②：两格的边界压在线稿上的比例 < 这个数就并（阴影、高光没有线稿）
    pieceWidth: 3.5,   // 分块线粗细（处理像素）：和外轮廓露在外面的那一半（7 / 2）一样粗
    pieceSpur: 0.02,   // 一头悬空（碰到红 / 黑 / 背景）的分块线短于人物高的这么多就不画
    lines: false,      // 线稿画不画进剪纸：默认不画（脸是一整块纸，没有五官）；true = 旧版，眼睛、嘴、刘海的细线都留
    line: 38,          // 线稿阈值：黑帽 > 38
    head: 0.24,        // 没有脸框时，人物最上面 24% 算脸
    eps: 5,            // 直边程度：色块轮廓的拉直容差（像素）。旧版默认 4
    lineEps: 1.1,      // 线稿的拉直容差
    outline: 7,        // 人物外轮廓黑边粗细
    snapSil: 5,        // 红块、黑块离外形边 ≤ 这么多像素的折点挪到外形边上（补缝）；设 0 关掉
    seed: 1924,        // k-means++ 的随机种子（固定 → 每次结果一样）
  };
  const PAL = { paper: '#E8DCC0', red: '#D52B1E', black: '#1A1A1A' };
  const CODE = { paper: 1, red: 2, black: 3 };
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  // Python 的 round：四舍六入五成双
  function roundHalfEven(v) {
    const f = Math.floor(v), d = v - f;
    if (d > 0.5) return f + 1;
    if (d < 0.5) return f;
    return (f & 1) === 0 ? f : f + 1;
  }
  function rng(seed) {
    let h = 2166136261 >>> 0;
    for (const c of String(seed)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
    return () => { h ^= h << 13; h >>>= 0; h ^= h >>> 17; h ^= h << 5; h >>>= 0; return h / 4294967296; };
  }

  // ================================================================ 0. 准备
  // rgba：已裁掉透明边、缩到处理尺寸的像素（W×H×4）。背景（alpha ≤ 128）当白色。
  function prepare(rgba, W, H) {
    const N = W * H, m = new Uint8Array(N), rgb = new Uint8Array(N * 3), gray = new Uint8Array(N);
    let n = 0, top = H, bottom = -1;
    for (let p = 0, q = 0, r = 0; p < N; p++, q += 4, r += 3) {
      let R = 255, G = 255, B = 255;
      if (rgba[q + 3] > 128) {
        m[p] = 1; n++; R = rgba[q]; G = rgba[q + 1]; B = rgba[q + 2];
        const y = (p / W) | 0; if (y < top) top = y; if (y > bottom) bottom = y;
      }
      rgb[r] = R; rgb[r + 1] = G; rgb[r + 2] = B;
      gray[p] = (R * 4899 + G * 9617 + B * 1868 + 8192) >> 14; // 同 OpenCV 的灰度定点公式
    }
    return { W, H, N, m, rgb, gray, n, top, bottom };
  }

  // ================================================================ 1a. 平滑：金字塔 mean-shift（照 OpenCV pyrMeanShiftFiltering）
  function pyrDown3(src, W, H) {
    const w2 = (W + 1) >> 1, h2 = (H + 1) >> 1, tmp = new Int32Array(w2 * H * 3);
    const rx = (x) => (x < 0 ? -x : x >= W ? 2 * W - 2 - x : x), ry = (y) => (y < 0 ? -y : y >= H ? 2 * H - 2 - y : y);
    for (let y = 0; y < H; y++) {
      const row = y * W * 3;
      for (let x2 = 0; x2 < w2; x2++) {
        const x = x2 * 2, a = row + rx(x - 2) * 3, b = row + rx(x - 1) * 3, c = row + x * 3, d = row + rx(x + 1) * 3, e = row + rx(x + 2) * 3, o = (y * w2 + x2) * 3;
        for (let k = 0; k < 3; k++) tmp[o + k] = src[a + k] + 4 * src[b + k] + 6 * src[c + k] + 4 * src[d + k] + src[e + k];
      }
    }
    const out = new Uint8Array(w2 * h2 * 3), rw = w2 * 3;
    for (let y2 = 0; y2 < h2; y2++) {
      const y = y2 * 2, A = ry(y - 2) * rw, B = ry(y - 1) * rw, C = y * rw, D = ry(y + 1) * rw, E = ry(y + 2) * rw, o = y2 * rw;
      for (let i = 0; i < rw; i++) out[o + i] = (tmp[A + i] + 4 * tmp[B + i] + 6 * tmp[C + i] + 4 * tmp[D + i] + tmp[E + i] + 128) >> 8;
    }
    return { img: out, w: w2, h: h2 };
  }
  function pyrUp3(src, w2, h2, W, H) {
    // 一维：偶数位 s[i-1] + 6s[i] + s[i+1]，奇数位 4(s[i] + s[i+1])；左端镜像、右端复制（同 OpenCV）
    const tmp = new Int32Array(W * h2 * 3);
    for (let y = 0; y < h2; y++) {
      const row = y * w2 * 3;
      for (let x = 0; x < W; x++) {
        const i = x >> 1, iL = i === 0 ? 1 : i - 1, iR = i + 1 >= w2 ? w2 - 1 : i + 1, o = (y * W + x) * 3;
        for (let c = 0; c < 3; c++) {
          tmp[o + c] = (x & 1) === 0 ? src[row + iL * 3 + c] + 6 * src[row + i * 3 + c] + src[row + iR * 3 + c] : 4 * (src[row + i * 3 + c] + src[row + iR * 3 + c]);
        }
      }
    }
    const out = new Uint8Array(W * H * 3), rw = W * 3;
    for (let y = 0; y < H; y++) {
      const j = y >> 1, jL = j === 0 ? 1 : j - 1, jR = j + 1 >= h2 ? h2 - 1 : j + 1, A = jL * rw, B = j * rw, C = jR * rw, o = y * rw;
      if ((y & 1) === 0) for (let i = 0; i < rw; i++) out[o + i] = (tmp[A + i] + 6 * tmp[B + i] + tmp[C + i] + 32) >> 6;
      else for (let i = 0; i < rw; i++) out[o + i] = (4 * (tmp[B + i] + tmp[C + i]) + 32) >> 6;
    }
    return out;
  }
  // 一层 mean-shift 的准备：RGB 打包成一个整数，窗口边界查表
  function msLevel(src, W, H, sp, sr) {
    const N = W * H, s32 = new Int32Array(N);
    for (let p = 0; p < N; p++) s32[p] = src[p * 3] | (src[p * 3 + 1] << 8) | (src[p * 3 + 2] << 16);
    const L = Math.max(W, H), lo = new Int32Array(L), hi = new Int32Array(L);
    for (let v = 0; v < L; v++) { lo[v] = roundHalfEven(v - sp); hi[v] = roundHalfEven(v + sp); } // sp=3.5 时窗口 7/9 交替，同 OpenCV
    return { s32, lo, hi, W, H, isr2: Math.round(sr * sr) };
  }
  // 算 [y0, y1) 行里 todo=1 的像素：窗口里只平均颜色距离 ≤ sr 的像素，最多 5 轮，移动 ≤ 1 就停
  // （这个函数会被 toString() 发给 Worker，所以用到的小工具都写在函数体里）
  function msRows(Lv, dst, todo, y0, y1) {
    const { s32, lo, hi, W, H, isr2 } = Lv;
    const rh = (v) => { const f = Math.floor(v), d = v - f; return d > 0.5 ? f + 1 : d < 0.5 ? f : (f & 1) === 0 ? f : f + 1; }; // 四舍六入五成双，同 OpenCV cvRound
    for (let p = y0 * W, pe = y1 * W; p < pe; p++) {
      if (!todo[p]) continue;
      let x0 = p % W, yc = (p - x0) / W;
      const v0 = s32[p];
      let c0 = v0 & 255, c1 = (v0 >> 8) & 255, c2 = v0 >>> 16;
      for (let iter = 0; iter < 5; iter++) {
        let minx = lo[x0], miny = lo[yc], maxx = hi[x0], maxy = hi[yc];
        if (minx < 0) minx = 0; if (miny < 0) miny = 0; if (maxx > W - 1) maxx = W - 1; if (maxy > H - 1) maxy = H - 1;
        let s0 = 0, s1 = 0, s2 = 0, sx = 0, sy = 0, count = 0;
        for (let y = miny; y <= maxy; y++) {
          const base = y * W;
          let rc = 0, rx = 0;
          for (let q = base + minx, qe = base + maxx; q <= qe; q++) {
            const v = s32[q], t0 = v & 255, t1 = (v >> 8) & 255, t2 = v >>> 16;
            const d0 = t0 - c0, d1 = t1 - c1, d2 = t2 - c2;
            const k = ((isr2 - (d0 * d0 + d1 * d1 + d2 * d2)) >> 31) + 1; // 距离 ≤ sr 时 k=1，否则 0（无分支）
            s0 += t0 * k; s1 += t1 * k; s2 += t2 * k; rx += q * k; rc += k;
          }
          count += rc; sy += y * rc; sx += rx - base * rc;
        }
        if (count === 0) break;
        const ic = 1 / count, x1 = rh(sx * ic), y1c = rh(sy * ic);
        s0 = rh(s0 * ic); s1 = rh(s1 * ic); s2 = rh(s2 * ic);
        const e0 = s0 - c0, e1 = s1 - c1, e2 = s2 - c2;
        const stop = (x0 === x1 && yc === y1c) || Math.abs(x1 - x0) + Math.abs(y1c - yc) + e0 * e0 + e1 * e1 + e2 * e2 <= 1;
        x0 = x1; yc = y1c; c0 = s0; c1 = s1; c2 = s2;
        if (stop) break;
      }
      dst[p * 3] = c0; dst[p * 3 + 1] = c1; dst[p * 3 + 2] = c2;
    }
  }
  // 粗层：半分辨率、空间半径 sp/2，只算人物附近（远处背景全白，结果还是白）
  function msCoarse(B, sp, sr) {
    const { W, H, rgb, m } = B;
    const d = pyrDown3(rgb, W, H), w2 = d.w, h2 = d.h, fg2 = new Uint8Array(w2 * h2);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (m[y * W + x]) fg2[(y >> 1) * w2 + (x >> 1)] = 1;
    return { Lv: msLevel(d.img, w2, h2, Math.max(sp / 2, 1), sr), dst: new Uint8Array(d.img), todo: morphBin(fg2, w2, h2, Math.ceil(sp / 2) + 1, true), w2, h2 };
  }
  // 细层：把粗层结果放大；只在「粗层相邻像素颜色差 ≥ sr」的地方用全分辨率重算（同 OpenCV）
  function msFine(B, sp, sr, c) {
    const { W, H, rgb, m } = B, { dst: dst2, w2, h2 } = c;
    const isr22 = Math.max(Math.round(sr * sr), 16), up = pyrUp3(dst2, w2, h2, W, H), mk = new Uint8Array(W * H);
    for (let i = 1; i < h2 - 1; i++) {
      for (let j = 1; j < w2 - 1; j++) {
        const o = (i * w2 + j) * 3, c0 = dst2[o], c1 = dst2[o + 1], c2 = dst2[o + 2];
        let edge = false;
        for (let dy = -1; dy <= 1 && !edge; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const q = ((i + dy) * w2 + j + dx) * 3, a = c0 - dst2[q], b = c1 - dst2[q + 1], e = c2 - dst2[q + 2];
          if (a * a + b * b + e * e >= isr22) { edge = true; break; }
        }
        if (edge) { const y = 2 * i - 1, x = 2 * j - 1; if (y < H && x < W) mk[y * W + x] = 1; }
      }
    }
    const todo = morphBin(mk, W, H, 1, true);
    let cnt = 0;
    for (let p = 0; p < W * H; p++) { todo[p] &= m[p]; cnt += todo[p]; } // 背景像素的结果用不上，不算
    return { Lv: msLevel(rgb, W, H, sp, sr), dst: up, todo, refined: cnt };
  }
  function* meanShiftGen(B, sp, sr, out) {
    const c = msCoarse(B, sp, sr);
    for (let y = 0; y < c.h2; y += 16) { msRows(c.Lv, c.dst, c.todo, y, Math.min(c.h2, y + 16)); yield 0.25 * (y / c.h2); }
    const f = msFine(B, sp, sr, c);
    for (let y = 0; y < B.H; y += 16) { msRows(f.Lv, f.dst, f.todo, y, Math.min(B.H, y + 16)); yield 0.25 + 0.6 * (y / B.H); }
    out.img = f.dst; out.refined = f.refined;
  }
  // 多线程版（浏览器）：把 msRows 的源码塞进 Blob 起几个 Worker，按 16 行一块分发
  function makePool(n) {
    if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) return null;
    const src = "'use strict';\nconst msRows = " + msRows.toString() + ";\nlet Lv = null, todo = null, dst = null;\n" +
      'onmessage = (e) => { const d = e.data;\n' +
      '  if (d.free) { Lv = todo = dst = null; return; }\n' +
      '  if (d.init) { Lv = d.Lv; todo = d.todo; dst = new Uint8Array(Lv.W * Lv.H * 3); return; }\n' +
      '  msRows(Lv, dst, todo, d.y0, d.y1);\n' +
      '  const out = dst.slice(d.y0 * Lv.W * 3, d.y1 * Lv.W * 3);\n' +
      '  postMessage({ y0: d.y0, y1: d.y1, out }, [out.buffer]);\n};';
    let url; const ws = [];
    try { url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' })); for (let i = 0; i < n; i++) ws.push(new Worker(url)); }
    catch (e) { ws.forEach((w) => w.terminate()); return null; }
    return {
      size: n,
      // 16 行一块，按块号交错预先分给各线程（主线程这时可以去干别的，线程不会空等）
      run(Lv, dst, todo, H, onProgress) {
        return new Promise((resolve, reject) => {
          const W = Lv.W, chunk = 16, total = Math.ceil(H / chunk);
          let done = 0, failed = false;
          ws.forEach((w, i) => {
            w.onmessage = (e) => {
              const { y0, y1, out } = e.data, base = y0 * W;
              for (let p = base, pe = y1 * W; p < pe; p++) if (todo[p]) { const o = (p - base) * 3; dst[p * 3] = out[o]; dst[p * 3 + 1] = out[o + 1]; dst[p * 3 + 2] = out[o + 2]; }
              done++; if (onProgress) onProgress(done / total);
              if (done === total) { ws.forEach((x) => x.postMessage({ free: true })); resolve(); } // 算完让各线程放掉这一轮的缓冲
            };
            w.onerror = (e) => { if (!failed) { failed = true; reject(e); } };
            w.postMessage({ init: true, Lv, todo });
            for (let c = i; c < total; c += n) w.postMessage({ y0: c * chunk, y1: Math.min(H, (c + 1) * chunk) });
          });
        });
      },
      terminate() { ws.forEach((w) => w.terminate()); try { URL.revokeObjectURL(url); } catch (e) {} },
    };
  }
  // ================================================================ 1b. Lab + k-means
  // 为了快，k-means 在「6 bit 颜色直方图」上做：平滑图里同一个色桶的像素当成一个带权重的点（几千个点代替几十万像素）。
  // 迭代规则照 OpenCV kmeans（KMEANS_PP_CENTERS，3 次取最紧的一次）；随机数和 OpenCV 不同，所以分法不会逐像素一样。
  const LIN = new Float64Array(256);
  for (let i = 0; i < 256; i++) { const c = i / 255; LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  const labF = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  function rgbToLab(r, g, b, out, o) { // 同 skimage.color.rgb2lab（D65）
    const R = LIN[r], G = LIN[g], B = LIN[b];
    const fx = labF((0.412453 * R + 0.357580 * G + 0.180423 * B) / 0.95047), fy = labF(0.212671 * R + 0.715160 * G + 0.072169 * B), fz = labF((0.019334 * R + 0.119193 * G + 0.950227 * B) / 1.08883);
    out[o] = 116 * fy - 16; out[o + 1] = 500 * (fx - fy); out[o + 2] = 200 * (fy - fz);
  }
  function labToRgb(L, a, b) {
    const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200, inv = (f) => (f > 0.2068966 ? f * f * f : (f - 16 / 116) / 7.787);
    const X = inv(fx) * 0.95047, Y = inv(fy), Z = inv(fz) * 1.08883;
    const g = (c) => { c = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; return Math.max(0, Math.min(255, Math.round(c * 255))); };
    return [g(3.240479 * X - 1.537150 * Y - 0.498535 * Z), g(-0.969256 * X + 1.875992 * Y + 0.041556 * Z), g(0.055648 * X - 0.204043 * Y + 1.057311 * Z)];
  }
  function assignAll(X, nb, C, K, lab) {
    for (let i = 0; i < nb; i++) {
      const x = X[i * 3], y = X[i * 3 + 1], z = X[i * 3 + 2];
      let bk = 0, bd = Infinity;
      for (let k = 0; k < K; k++) { const a = x - C[k * 3], b = y - C[k * 3 + 1], c = z - C[k * 3 + 2], d = a * a + b * b + c * c; if (d < bd) { bd = d; bk = k; } }
      lab[i] = bk;
    }
  }
  // Python 的 round(x, 3)：按 double 的精确值取最近，正好在中间时取偶（只有 x 是 1/16 的奇数倍时会碰到）
  function round3(x) {
    const q = x * 16;
    if (Number.isInteger(q) && (q & 1) === 1) return roundHalfEven(x * 1000) / 1000;
    return +x.toFixed(3);
  }
  function kmeans(B, sm, K, seed) {
    const { N, m } = B, NB = 1 << 18;
    const binOf = new Int32Array(N), cnt = new Uint32Array(NB), sum = new Float64Array(NB * 3);
    for (let p = 0; p < N; p++) {
      if (!m[p]) { binOf[p] = -1; continue; }
      const r = sm[p * 3], g = sm[p * 3 + 1], b = sm[p * 3 + 2], k = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
      binOf[p] = k; cnt[k]++; sum[k * 3] += r; sum[k * 3 + 1] += g; sum[k * 3 + 2] += b;
    }
    let nb = 0; for (let k = 0; k < NB; k++) if (cnt[k]) nb++;
    const X = new Float64Array(nb * 3), w = new Float64Array(nb), remap = new Int32Array(NB);
    for (let k = 0, i = 0; k < NB; k++) {
      if (!cnt[k]) continue;
      const c = cnt[k]; w[i] = c; remap[k] = i;
      rgbToLab(Math.round(sum[k * 3] / c), Math.round(sum[k * 3 + 1] / c), Math.round(sum[k * 3 + 2] / c), X, i * 3); i++;
    }
    const d2 = (i, C, k) => { const a = X[i * 3] - C[k * 3], b = X[i * 3 + 1] - C[k * 3 + 1], c = X[i * 3 + 2] - C[k * 3 + 2]; return a * a + b * b + c * c; };
    const rand = rng(seed);
    let tw = 0; for (let i = 0; i < nb; i++) tw += w[i];
    const EPS2 = 0.5 * 0.5, MAXIT = 30; // 同 Python：TermCriteria(EPS + MAX_ITER, 30, 0.5)
    let best = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      // k-means++：第一个中心按像素数抽；之后每个新中心抽 3 个候选，留总势能最小的（同 OpenCV generateCentersPP）
      const C = new Float64Array(K * 3), D = new Float64Array(nb);
      let r0 = rand() * tw, first = 0; for (; first < nb - 1; first++) { r0 -= w[first]; if (r0 <= 0) break; }
      C[0] = X[first * 3]; C[1] = X[first * 3 + 1]; C[2] = X[first * 3 + 2];
      let pot = 0;
      for (let i = 0; i < nb; i++) { D[i] = d2(i, C, 0); pot += w[i] * D[i]; }
      for (let k = 1; k < K; k++) {
        let bestPot = Infinity, bestI = 0;
        for (let t = 0; t < 3; t++) {
          let r = rand() * pot, ci = 0;
          for (; ci < nb - 1; ci++) { r -= w[ci] * D[ci]; if (r <= 0) break; }
          const cx = X[ci * 3], cy = X[ci * 3 + 1], cz = X[ci * 3 + 2];
          let s = 0;
          for (let i = 0; i < nb; i++) { const a = X[i * 3] - cx, b = X[i * 3 + 1] - cy, c = X[i * 3 + 2] - cz, d = a * a + b * b + c * c; s += w[i] * (d < D[i] ? d : D[i]); }
          if (s < bestPot) { bestPot = s; bestI = ci; }
        }
        C[k * 3] = X[bestI * 3]; C[k * 3 + 1] = X[bestI * 3 + 1]; C[k * 3 + 2] = X[bestI * 3 + 2];
        pot = 0;
        for (let i = 0; i < nb; i++) { const d = d2(i, C, k); if (d < D[i]) D[i] = d; pot += w[i] * D[i]; }
      }
      // Lloyd（同 OpenCV kmeans）：分配 → 更新中心；更新后中心最大移动 ≤ 0.5 或已更新 29 次就停，
      // 停的时候不再重新分配（色块号来自最后一次分配，中心是最后一次更新的结果）
      const lab = new Int32Array(nb), S = new Float64Array(K * 3), Wk = new Float64Array(K);
      assignAll(X, nb, C, K, lab);
      for (let iter = 1; ; ) {
        S.fill(0); Wk.fill(0);
        for (let i = 0; i < nb; i++) { const k = lab[i], wi = w[i]; Wk[k] += wi; S[k * 3] += wi * X[i * 3]; S[k * 3 + 1] += wi * X[i * 3 + 1]; S[k * 3 + 2] += wi * X[i * 3 + 2]; }
        for (let k = 0; k < K; k++) {
          if (Wk[k] !== 0) continue;
          // 空簇（同 OpenCV）：从最大的簇里拆出离它中心最远的那个点（这里是一个色桶），单独成簇
          let mk = 0; for (let k1 = 1; k1 < K; k1++) if (Wk[mk] < Wk[k1]) mk = k1;
          const cx = S[mk * 3] / Wk[mk], cy = S[mk * 3 + 1] / Wk[mk], cz = S[mk * 3 + 2] / Wk[mk];
          let fi = -1, fd = 0;
          for (let i = 0; i < nb; i++) { if (lab[i] !== mk) continue; const a = X[i * 3] - cx, b = X[i * 3 + 1] - cy, c = X[i * 3 + 2] - cz, d = a * a + b * b + c * c; if (fd <= d) { fd = d; fi = i; } }
          if (fi < 0 || Wk[mk] - w[fi] <= 0) continue; // 最大的簇只剩一个色桶（颜色极少的图）：这个簇留空，中心不动
          const wi = w[fi]; Wk[mk] -= wi; Wk[k] += wi; lab[fi] = k;
          for (let j = 0; j < 3; j++) { S[mk * 3 + j] -= wi * X[fi * 3 + j]; S[k * 3 + j] += wi * X[fi * 3 + j]; }
        }
        let shift = 0;
        for (let k = 0; k < K; k++) {
          if (Wk[k] === 0) continue;
          const nx = S[k * 3] / Wk[k], ny = S[k * 3 + 1] / Wk[k], nz = S[k * 3 + 2] / Wk[k];
          const dd = (nx - C[k * 3]) ** 2 + (ny - C[k * 3 + 1]) ** 2 + (nz - C[k * 3 + 2]) ** 2; if (dd > shift) shift = dd;
          C[k * 3] = nx; C[k * 3 + 1] = ny; C[k * 3 + 2] = nz;
        }
        if (++iter === MAXIT || shift <= EPS2) break;
        assignAll(X, nb, C, K, lab);
      }
      let compact = 0; for (let i = 0; i < nb; i++) compact += w[i] * d2(i, C, lab[i]);
      if (!best || compact < best.compact) best = { C: C.slice(), lab: lab.slice(), compact };
    }
    // 每个像素的色块号（255 = 背景）
    const labels = new Uint8Array(N).fill(255), area = new Float64Array(K);
    for (let p = 0; p < N; p++) { const b = binOf[p]; if (b < 0) continue; const k = best.lab[remap[b]]; labels[p] = k; area[k]++; }
    const clusters = [];
    for (let k = 0; k < K; k++) {
      const L = best.C[k * 3], a = best.C[k * 3 + 1], b = best.C[k * 3 + 2];
      // 取整同 Python：L、C、色相角取整（五成双），面积占比保留 3 位小数，规则都按取整后的数判断
      clusters.push({ k, L: roundHalfEven(L), C: roundHalfEven(Math.hypot(a, b)), hue: roundHalfEven((Math.atan2(b, a) * 180) / Math.PI), frac: B.n ? round3(area[k] / B.n) : 0, lab: [L, a, b], rgb: labToRgb(L, a, b) });
    }
    return { labels, clusters, bins: nb };
  }

  // ================================================================ 2. 三色：给每个色块分角色
  function baseRole(d) {
    const redish = d.hue >= -35 && d.hue <= 50 && d.C > 28 && d.L >= 20 && d.L <= 82; // 本来就是红 / 橙 / 粉，且够鲜
    return redish ? 'red' : d.L < 40 ? 'black' : 'paper';
  }
  function autoRoles(clusters, opt) {
    opt = Object.assign({}, DEFAULTS, opt);
    const role = clusters.map(baseRole);
    const share = (r) => clusters.reduce((s, d, i) => s + (role[i] === r ? d.frac : 0), 0);
    // 黑太少（浅色衣服的角色，剪出来几乎全是纸）：先把最暗的那块纸色补成黑。参考实现没有这条；人物里黑够多时不起作用
    if (opt.blackLow > 0 && share('black') < opt.blackLow) {
      const cand = clusters.filter((d, i) => role[i] === 'paper' && d.frac > 0 && d.L < opt.blackLowL).sort((p, q) => p.L - q.L);
      if (cand.length) role[cand[0].k] = 'black';
    }
    if (share('red') < 0.05) { // 红太少：把「彩度 × 面积」最大的中间调补成红
      const cand = clusters.filter((d, i) => role[i] === 'paper' && d.L >= 40 && d.L < 85 && d.C > 18).sort((p, q) => q.C * q.frac - p.C * p.frac);
      if (cand.length) role[cand[0].k] = 'red';
    }
    return role;
  }
  // 点选：redSet 里的色块是红，其余按明暗分纸 / 黑；黑太少时和自动一样把最暗的纸色块补成黑（不然一点红，补的黑就没了）
  function rolesFromSet(clusters, redSet, opt) {
    opt = Object.assign({}, DEFAULTS, opt);
    const role = clusters.map((d) => (redSet.has(d.k) ? 'red' : d.L < 40 ? 'black' : 'paper'));
    const black = clusters.reduce((s, d, i) => s + (role[i] === 'black' ? d.frac : 0), 0);
    if (opt.blackLow > 0 && black < opt.blackLow) {
      const cand = clusters.filter((d, i) => role[i] === 'paper' && d.frac > 0 && d.L < opt.blackLowL).sort((p, q) => p.L - q.L);
      if (cand.length) role[cand[0].k] = 'black';
    }
    return role;
  }

  // ================================================================ 形态学 / 连通域
  // 方框求和（边界镜像，同 OpenCV BORDER_REFLECT_101）；只在两端做镜像判断
  function boxSum(src, W, H, r) {
    const tmp = new Int32Array(W * H), out = new Int32Array(W * H);
    const rx = (x) => (x < 0 ? -x : x >= W ? 2 * W - 2 - x : x), ry = (y) => (y < 0 ? -y : y >= H ? 2 * H - 2 - y : y);
    for (let y = 0; y < H; y++) {
      const o = y * W; let s = 0;
      for (let x = -r; x <= r; x++) s += src[o + rx(x)];
      for (let x = 0; x < W; x++) {
        tmp[o + x] = s;
        const xa = x + r + 1, xb = x - r;
        s += (xa < W ? src[o + xa] : src[o + rx(xa)]) - (xb >= 0 ? src[o + xb] : src[o + rx(xb)]);
      }
    }
    const col = new Int32Array(W);
    for (let y = -r; y <= r; y++) { const q = ry(y) * W; for (let x = 0; x < W; x++) col[x] += tmp[q + x]; }
    for (let y = 0; y < H; y++) {
      const o = y * W;
      out.set(col, o);
      const qa = ry(y + r + 1) * W, qb = ry(y - r) * W;
      for (let x = 0; x < W; x++) col[x] += tmp[qa + x] - tmp[qb + x];
    }
    return out;
  }
  // 二值膨胀 / 腐蚀，方形核 (2r+1)²；画面外：膨胀当 0、腐蚀当 1（同 OpenCV 默认）
  function morphBin(src, W, H, r, isDilate) {
    const tmp = new Uint8Array(W * H), out = new Uint8Array(W * H), k = 2 * r + 1, ob = isDilate ? 0 : 1;
    for (let y = 0; y < H; y++) {
      const o = y * W; let s = 0;
      for (let x = -r; x <= r; x++) s += x < 0 || x >= W ? ob : src[o + x];
      for (let x = 0; x < W; x++) {
        tmp[o + x] = isDilate ? (s > 0 ? 1 : 0) : s === k ? 1 : 0;
        const xa = x + r + 1, xb = x - r;
        s += (xa >= W ? ob : src[o + xa]) - (xb < 0 ? ob : src[o + xb]);
      }
    }
    for (let x = 0; x < W; x++) {
      let s = 0;
      for (let y = -r; y <= r; y++) s += y < 0 || y >= H ? ob : tmp[y * W + x];
      for (let y = 0; y < H; y++) {
        out[y * W + x] = isDilate ? (s > 0 ? 1 : 0) : s === k ? 1 : 0;
        const ya = y + r + 1, yb = y - r;
        s += (ya >= H ? ob : tmp[ya * W + x]) - (yb < 0 ? ob : tmp[yb * W + x]);
      }
    }
    return out;
  }
  // 8 连通标记：labels（0 = 背景）+ 每块面积与外框
  function labelCC(mask, W, H) {
    const N = W * H, lab = new Int32Array(N);
    let parent = new Int32Array(1024), np = 1;
    const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
    const unite = (a, b) => { a = find(a); b = find(b); if (a !== b) { if (a < b) parent[b] = a; else parent[a] = b; } };
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const p = y * W + x; if (!mask[p]) continue;
        let l = 0, v;
        if (x > 0 && (v = lab[p - 1])) l = v; // 已扫过的邻居：左、左上、上、右上
        if (y > 0) {
          if (x > 0 && (v = lab[p - W - 1])) { if (!l) l = v; else if (v !== l) unite(l, v); }
          if ((v = lab[p - W])) { if (!l) l = v; else if (v !== l) unite(l, v); }
          if (x < W - 1 && (v = lab[p - W + 1])) { if (!l) l = v; else if (v !== l) unite(l, v); }
        }
        if (!l) {
          if (np >= parent.length) { const t = new Int32Array(parent.length * 2); t.set(parent); parent = t; }
          l = np; parent[np] = np; np++;
        }
        lab[p] = l;
      }
    }
    const remap = new Int32Array(np); let n = 0;
    for (let i = 1; i < np; i++) { const r = find(i); if (!remap[r]) remap[r] = ++n; remap[i] = remap[r]; }
    const area = new Int32Array(n + 1), x0 = new Int32Array(n + 1).fill(W), y0 = new Int32Array(n + 1).fill(H), x1 = new Int32Array(n + 1).fill(-1), y1 = new Int32Array(n + 1).fill(-1);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const p = y * W + x; if (!lab[p]) continue;
      const l = (lab[p] = remap[lab[p]]);
      area[l]++; if (x < x0[l]) x0[l] = x; if (x > x1[l]) x1[l] = x; if (y < y0[l]) y0[l] = y; if (y > y1[l]) y1[l] = y;
    }
    return { lab, n, area, x0, y0, x1, y1 };
  }

  // ================================================================ 2'. 三色图：众数滤波 ×2 + 去碎块
  function classify(B, labels, roles, opt) {
    const { W, H, N, m, n } = B;
    const code = roles.map((r) => CODE[r]);
    let cls = new Uint8Array(N);
    for (let p = 0; p < N; p++) if (m[p]) cls[p] = code[labels[p]];
    const PK = [0, 1, 256, 65536];
    for (let pass = 0; pass < 2; pass++) { // 9×9 众数：三类的计数打包进一个整数一起求和（每类 ≤ 81，不会溢出）
      const pk = new Int32Array(N);
      for (let p = 0; p < N; p++) pk[p] = PK[cls[p]];
      const S = boxSum(pk, W, H, 4), nc = new Uint8Array(N);
      for (let p = 0; p < N; p++) {
        if (!m[p]) continue;
        const s = S[p], a = s & 255, b = (s >> 8) & 255, c = s >> 16;
        nc[p] = a >= b && a >= c ? 1 : b >= c ? 2 : 3; // 平票时纸优先，其次红（同 numpy argmax）
      }
      cls = nc;
    }
    for (const [ci, frac] of [[2, opt.redMin], [3, opt.blackMin]]) { // 红碎块、黑碎块 → 纸
      const mk = new Uint8Array(N);
      for (let p = 0; p < N; p++) if (cls[p] === ci) mk[p] = 1;
      const cc = labelCC(mk, W, H), thr = frac * n;
      for (let p = 0; p < N; p++) { const l = cc.lab[p]; if (l && cc.area[l] < thr) cls[p] = 1; }
    }
    return cls;
  }

  // ================================================================ 2''. 大块：小碎块并进四周的大块（参考实现没有这步；第 ② 步的三色图本身不变）
  // 三色图里每种颜色的连通块（8 连通）面积 < minFrac × 人物面积，就改成它四周最多的那种颜色（只数人物里的邻居，
  // 不数背景）。从小到大一块一块改、改完立刻算数；刚并进来的块让旁边的同色块变大了，这一轮先跳过，下一轮重新数。
  // 最多 4 轮。四周只有背景的小块不动。脸上的眼睛、嘴、眉毛都是被肤色围住的小块，会并进脸；衣服上的小扣子、碎高光同理。
  function mergeSmall(B, cls0, minFrac) {
    const { W, H, N, n } = B, thr = minFrac * n, cls = cls0.slice(), stamp = new Int32Array(N);
    let id = 0, total = 0;
    for (let pass = 0; pass < 4; pass++) {
      const comps = [];
      for (const c of [1, 2, 3]) {
        const mk = new Uint8Array(N); for (let p = 0; p < N; p++) if (cls[p] === c) mk[p] = 1;
        const cc = labelCC(mk, W, H), small = new Int32Array(cc.n + 1).fill(-1); let ns = 0;
        for (let l = 1; l <= cc.n; l++) if (cc.area[l] < thr) small[l] = ns++;
        if (!ns) continue;
        const off = new Int32Array(ns + 1); // 每个小块的像素表（CSR）
        for (let p = 0; p < N; p++) { const l = cc.lab[p]; if (l && small[l] >= 0) off[small[l] + 1]++; }
        for (let i = 0; i < ns; i++) off[i + 1] += off[i];
        const px = new Int32Array(off[ns]), at = off.slice(0, ns);
        for (let p = 0; p < N; p++) { const l = cc.lab[p]; if (l && small[l] >= 0) px[at[small[l]]++] = p; }
        for (let i = 0; i < ns; i++) comps.push({ c, px: px.subarray(off[i], off[i + 1]) });
      }
      comps.sort((a, b) => a.px.length - b.px.length);
      let changed = 0;
      for (const k of comps) {
        id++; for (const p of k.px) stamp[p] = id;
        const votes = [0, 0, 0, 0]; let grown = false;
        for (const p of k.px) {
          const x = p % W, y = (p - x) / W;
          for (let dy = -1; dy <= 1; dy++) {
            const yy = y + dy; if (yy < 0 || yy >= H) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx; if ((!dx && !dy) || xx < 0 || xx >= W) continue;
              const q = yy * W + xx, v = cls[q];
              if (v === k.c) { if (stamp[q] !== id) grown = true; } else if (v) votes[v]++;
            }
          }
        }
        if (grown) continue; // 旁边的同色块刚并大了：这块已经不算孤立的小块，下一轮重新数
        let best = 0; for (const v of [1, 2, 3]) if (v !== k.c && votes[v] > votes[best]) best = v;
        if (!best) continue;
        for (const p of k.px) cls[p] = best;
        changed++;
      }
      total += changed;
      if (!changed) break;
    }
    cls.merged = total;
    return cls;
  }

  // ================================================================ 2'''. 分块：纸色里的大块（头发、脸、帽子、袖子…）之间留一条线
  // 只有纸 / 红 / 黑三种颜色时，浅色立绘的头发、脸、衣服都是纸，不画线稿就连成一整块（参考实现没有这步）。分三步：
  // ① 切格子：平滑图里相邻、颜色接近（Lab，明度差按 1/kL 算）的纸色像素连成一格；原画线稿上的像素（黑帽 > 38）不连，
  //    格子之间靠它们隔开；< tiny 像素的碎格和线稿像素最后从四周的格子一圈一圈长过去分掉。
  // ② 动漫立绘里，不同的东西（头发和脸、帽子和脸、袖子和衣身）之间有线稿；同一样东西的亮面和暗面之间没有。所以两格之间的边界
  //    压在线稿上的比例 < support 就并成一格（比例最低的先并），阴影、高光、腮红都并掉了。
  // ③ 小于人物 minFrac 的格子并进接触最多的邻格（从小到大）：眼睛、嘴、眉、发丝、毛边都并掉了，脸是一整块。
  // 返回每个纸色像素属于哪一块（0 = 不是纸），给 pieceChains 找边界。
  function pieceMap(B, A, cls, opt) {
    const { W, H, N, n } = B, line = A.lineCC.lab, sm = A.smooth;
    const lab3 = new Float32Array(N * 3), tmp = new Float64Array(3), ikL = 1 / opt.pieceKL, t2 = opt.pieceGrow * opt.pieceGrow;
    for (let p = 0; p < N; p++) if (cls[p] === 1) { rgbToLab(sm[p * 3], sm[p * 3 + 1], sm[p * 3 + 2], tmp, 0); lab3[p * 3] = tmp[0] * ikL; lab3[p * 3 + 1] = tmp[1]; lab3[p * 3 + 2] = tmp[2]; }
    const lab = new Int32Array(N), st = new Int32Array(N);
    const near = (p, q) => { const a = lab3[p * 3] - lab3[q * 3], b = lab3[p * 3 + 1] - lab3[q * 3 + 1], c = lab3[p * 3 + 2] - lab3[q * 3 + 2]; return a * a + b * b + c * c < t2; };
    let nr = 0;
    for (let p0 = 0; p0 < N; p0++) { // ① 格子：纸色、不压线、和邻居颜色接近 → 4 连通
      if (cls[p0] !== 1 || line[p0] || lab[p0]) continue;
      lab[p0] = ++nr; let sp = 0; st[sp++] = p0;
      while (sp) {
        const p = st[--sp], x = p % W; let q;
        if (x > 0 && !lab[q = p - 1] && cls[q] === 1 && !line[q] && near(p, q)) { lab[q] = nr; st[sp++] = q; }
        if (x < W - 1 && !lab[q = p + 1] && cls[q] === 1 && !line[q] && near(p, q)) { lab[q] = nr; st[sp++] = q; }
        if (p >= W && !lab[q = p - W] && cls[q] === 1 && !line[q] && near(p, q)) { lab[q] = nr; st[sp++] = q; }
        if (p < N - W && !lab[q = p + W] && cls[q] === 1 && !line[q] && near(p, q)) { lab[q] = nr; st[sp++] = q; }
      }
    }
    const area = new Float64Array(nr + 1);
    for (let p = 0; p < N; p++) area[lab[p]]++;
    for (let p = 0; p < N; p++) if (lab[p] && area[lab[p]] < opt.pieceTiny) lab[p] = 0;
    // 碎格、线稿像素、外形补上的缝（手臂和身体之间那种透明的窄缝，外形闭运算以后算人物、剪纸里是纸）：
    // 从所有格子同时往外长，一圈一圈地分（谁先到归谁）。缝也分掉，分块线才会从缝中间穿过去，不会停在半路
    const sil = A.sil, open = (q) => !lab[q] && (cls[q] === 1 || (sil && sil[q] && !B.m[q]));
    let qt = 0;
    for (let p = 0; p < N; p++) if (lab[p]) st[qt++] = p;
    for (let qh = 0; qh < qt; qh++) {
      const p = st[qh], x = p % W, l = lab[p];
      if (x > 0 && open(p - 1)) { lab[p - 1] = l; st[qt++] = p - 1; }
      if (x < W - 1 && open(p + 1)) { lab[p + 1] = l; st[qt++] = p + 1; }
      if (p >= W && open(p - W)) { lab[p - W] = l; st[qt++] = p - W; }
      if (p < N - W && open(p + W)) { lab[p + W] = l; st[qt++] = p + W; }
    }
    // 面积；相邻两格之间有多少条像素边（c），其中多少条压在线稿上（s；外形补上的缝也算线：缝两边本来就是分开的）
    const cut = (p) => line[p] || !B.m[p];
    area.fill(0);
    const adj = new Array(nr + 1); for (let i = 0; i <= nr; i++) adj[i] = new Map();
    const touch = (a, b, ln) => { let e = adj[a].get(b); if (!e) { e = { c: 0, s: 0 }; adj[a].set(b, e); adj[b].set(a, e); } e.c++; e.s += ln; };
    for (let y = 0; y < H; y++) for (let x = 0, p = y * W; x < W; x++, p++) {
      const a = lab[p]; if (!a) continue;
      area[a]++;
      let b, q;
      if (x < W - 1 && (b = lab[q = p + 1]) && b !== a) touch(a, b, cut(p) || cut(q) ? 1 : 0);
      if (y < H - 1 && (b = lab[q = p + W]) && b !== a) touch(a, b, cut(p) || cut(q) ? 1 : 0);
    }
    const parent = new Int32Array(nr + 1); for (let i = 0; i <= nr; i++) parent[i] = i;
    let fresh = [];
    const merge = (r, b) => { // r 并进 b：两格的邻居表合并（共用的边界加起来）
      parent[r] = b; area[b] += area[r]; area[r] = 0;
      const mb = adj[b], er = mb.get(r); if (er) er.dead = true; mb.delete(r);
      for (const [s, e] of adj[r]) {
        if (s === b) continue;
        e.dead = true; const ms = adj[s]; ms.delete(r);
        const f = mb.get(s); if (f) f.dead = true;
        const g = { c: e.c + (f ? f.c : 0), s: e.s + (f ? f.s : 0) }; mb.set(s, g); ms.set(b, g); fresh.push(b, s, g);
      }
      adj[r] = new Map();
    };
    // ② 边界没压在线稿上的两格：并（压线比例最低的先并；并完重新算比例）
    const heap = [], key = (g) => g.s / g.c - g.c * 1e-9;
    const push = (a, b, g) => { const e = { k: key(g), a, b, g }; heap.push(e); let i = heap.length - 1; while (i > 0) { const j = (i - 1) >> 1; if (heap[j].k <= e.k) break; heap[i] = heap[j]; i = j; } heap[i] = e; };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = l < heap.length && heap[l].k < last.k ? l : -1; if (r < heap.length && heap[r].k < (m < 0 ? last.k : heap[m].k)) m = r; if (m < 0) break; heap[i] = heap[m]; i = m; } heap[i] = last; } return top; };
    for (let a = 1; a <= nr; a++) for (const [b, g] of adj[a]) if (b > a) push(a, b, g);
    while (heap.length) {
      const e = pop(); if (e.k >= opt.pieceSupport) break;
      if (e.g.dead) continue;
      fresh = [];
      if (area[e.a] >= area[e.b]) merge(e.b, e.a); else merge(e.a, e.b);
      for (let i = 0; i < fresh.length; i += 3) push(fresh[i], fresh[i + 1], fresh[i + 2]);
    }
    // ③ 小格子并进接触最多的邻格（从小到大，并完立刻算数）
    const minA = opt.pieceMin * n;
    for (let pass = 0; pass < 8; pass++) {
      const order = []; for (let r = 1; r <= nr; r++) if (parent[r] === r && area[r] > 0 && area[r] < minA) order.push(r);
      order.sort((a, b) => area[a] - area[b]);
      let changed = 0;
      for (const r of order) {
        if (parent[r] !== r || area[r] >= minA) continue;
        let best = 0, bc = 0; for (const [s, g] of adj[r]) if (g.c > bc || (g.c === bc && area[s] > area[best])) { bc = g.c; best = s; }
        if (!best) continue; // 四周没有纸（被红、黑、背景围住）：留着，它和谁都不画线
        merge(r, best); changed++;
      }
      if (!changed) break;
    }
    const root = (r) => { while (parent[r] !== r) r = parent[r] = parent[parent[r]]; return r; };
    let np = 0; const id = new Int32Array(nr + 1);
    for (let r = 1; r <= nr; r++) if (parent[r] === r && area[r] > 0) id[r] = ++np;
    for (let p = 0; p < N; p++) if (lab[p]) lab[p] = id[root(lab[p])];
    return { lab, n: np, cells: nr };
  }
  // 分块线：两块不同的纸色块之间的像素边，连成折线（在三条以上的线相交处、碰到红 / 黑 / 背景的地方断开）。
  // 顶点是像素角 (x, y)，0 ≤ x ≤ W、0 ≤ y ≤ H。每条折线只留拐角。
  function pieceChains(B, lab) {
    const { W, H } = B, VW = W + 1, NV = VW * (H + 1), deg = new Uint8Array(NV); // 每个顶点四个方向上有没有边：1 北 2 东 4 南 8 西
    for (let y = 0; y < H; y++) for (let x = 0, p = y * W; x < W; x++, p++) {
      const a = lab[p]; if (!a) continue;
      let b;
      if (x < W - 1 && (b = lab[p + 1]) && b !== a) { deg[y * VW + x + 1] |= 4; deg[(y + 1) * VW + x + 1] |= 1; } // 竖边 (x+1, y)–(x+1, y+1)
      if (y < H - 1 && (b = lab[p + W]) && b !== a) { deg[(y + 1) * VW + x] |= 2; deg[(y + 1) * VW + x + 1] |= 8; } // 横边 (x, y+1)–(x+1, y+1)
    }
    const DXV = [0, 1, 0, -1], DYV = [-1, 0, 1, 0], used = new Uint8Array(NV), out = [];
    const cnt = (m) => (m & 1) + ((m >> 1) & 1) + ((m >> 2) & 1) + ((m >> 3) & 1);
    const walk = (v0, d0) => {
      const pts = [v0 % VW, (v0 / VW) | 0]; let v = v0, d = d0, len = 0;
      for (;;) {
        used[v] |= 1 << d;
        const x = v % VW + DXV[d], y = ((v / VW) | 0) + DYV[d], w = y * VW + x, back = (d + 2) & 3;
        used[w] |= 1 << back; len++;
        if (cnt(deg[w]) !== 2 || w === v0) { pts.push(x, y); return { pts, len, closed: w === v0 && cnt(deg[w]) === 2 }; }
        let nd = 0; while (nd === back || !(deg[w] & (1 << nd))) nd++;
        if (nd !== d) pts.push(x, y); // 拐角
        v = w; d = nd;
      }
    };
    for (const pass of [0, 1]) { // 先从端点、交点出发；剩下的是闭合的圈
      for (let v = 0; v < NV; v++) {
        const m = deg[v]; if (!m || (pass === 0 && cnt(m) === 2)) continue;
        for (let d = 0; d < 4; d++) if (m & (1 << d) && !(used[v] & (1 << d))) {
          const c = walk(v, d), e = c.pts.length;
          c.ends = [cnt(deg[v]), cnt(deg[c.pts[e - 2] + c.pts[e - 1] * VW])];
          out.push(c);
        }
      }
    }
    return out;
  }
  // 开放折线的 Douglas–Peucker（两端固定）
  function dpOpen(pts, eps) {
    const n = pts.length >> 1; if (n <= 2) return Float32Array.from(pts);
    const keep = new Uint8Array(n); keep[0] = keep[n - 1] = 1;
    const stack = [0, n - 1], e2 = eps * eps;
    while (stack.length) {
      const e = stack.pop(), s = stack.pop(); if (e - s < 2) continue;
      const x0 = pts[s * 2], y0 = pts[s * 2 + 1], dx = pts[e * 2] - x0, dy = pts[e * 2 + 1] - y0, L2 = dx * dx + dy * dy;
      let bi = -1, bd = 0;
      for (let i = s + 1; i < e; i++) { const px = pts[i * 2] - x0, py = pts[i * 2 + 1] - y0, d = L2 > 0 ? (py * dx - px * dy) ** 2 / L2 : px * px + py * py; if (d > bd) { bd = d; bi = i; } }
      if (bi >= 0 && bd > e2) { keep[bi] = 1; stack.push(s, bi, bi, e); }
    }
    const o = []; for (let i = 0; i < n; i++) if (keep[i]) o.push(pts[i * 2], pts[i * 2 + 1]);
    return Float32Array.from(o);
  }

  // ================================================================ 3. 线稿：黑帽变换（9×9 椭圆核）
  // 9×9 椭圆核每行的半宽是 [0,3,3,4,4,4,3,3,0]（同 OpenCV getStructuringElement(MORPH_ELLIPSE, (9, 9))）：
  // 先算每行的横向最大值（半宽 1 → 3 → 4），再按行取 9 行的最大值。画面外的像素不参与。
  function ellMax(src, W, H) {
    const N = W * H, h1 = new Uint8Array(N), h3 = new Uint8Array(N), h4 = new Uint8Array(N), out = new Uint8Array(N);
    for (let y = 0; y < H; y++) {
      const o = y * W, e = o + W - 1;
      for (let x = o; x <= e; x++) { let v = src[x], a; if (x > o && (a = src[x - 1]) > v) v = a; if (x < e && (a = src[x + 1]) > v) v = a; h1[x] = v; }
      for (let x = o; x <= e; x++) { let v = h1[x], a; if ((a = h1[x - 2 < o ? o : x - 2]) > v) v = a; if ((a = h1[x + 2 > e ? e : x + 2]) > v) v = a; h3[x] = v; }
      for (let x = o; x <= e; x++) { let v = h3[x], a; if (x - 4 >= o && (a = src[x - 4]) > v) v = a; if (x + 4 <= e && (a = src[x + 4]) > v) v = a; h4[x] = v; }
    }
    out.set(h4);
    const rows = [[-4, src], [-3, h3], [-2, h3], [-1, h4], [1, h4], [2, h3], [3, h3], [4, src]];
    for (let y = 0; y < H; y++) {
      const o = y * W;
      for (let r = 0; r < 8; r++) {
        const yy = y + rows[r][0]; if (yy < 0 || yy >= H) continue;
        const a = rows[r][1], q = yy * W;
        for (let x = 0; x < W; x++) { const v = a[q + x]; if (v > out[o + x]) out[o + x] = v; }
      }
    }
    return out;
  }
  // 灰度腐蚀 = 反相 → 膨胀 → 反相
  function ellMin(src, W, H) {
    const N = W * H, inv = new Uint8Array(N);
    for (let p = 0; p < N; p++) inv[p] = 255 - src[p];
    const o = ellMax(inv, W, H);
    for (let p = 0; p < N; p++) o[p] = 255 - o[p];
    return o;
  }
  // 细暗线 = 闭运算 − 原图 > 阈值（只在人物里）；返回连通域，留不留由脸框决定
  function lineComponents(B, thr) {
    const { W, H, N, m, gray } = B;
    const close = ellMin(ellMax(gray, W, H), W, H), mk = new Uint8Array(N);
    for (let p = 0; p < N; p++) if (m[p] && close[p] - gray[p] > thr) mk[p] = 1;
    return labelCC(mk, W, H);
  }
  // 留线：脸框里 ≥18px 的短线 + 任何 ≥160px 的长线；再向右下膨胀 1px（同 OpenCV 2×2 核）
  function lineMask(B, cc, faceBox, opt) {
    const { W, H, N } = B, keep = new Uint8Array(cc.n + 1), headY = B.top + opt.head * (B.bottom - B.top);
    for (let l = 1; l <= cc.n; l++) {
      const cx = cc.x0[l] + (cc.x1[l] - cc.x0[l] + 1) / 2, cy = cc.y0[l] + (cc.y1[l] - cc.y0[l] + 1) / 2;
      const inface = faceBox ? cx >= faceBox[0] && cx <= faceBox[2] && cy >= faceBox[1] && cy <= faceBox[3] : cy < headY;
      if ((inface && cc.area[l] >= 18) || cc.area[l] >= 160) keep[l] = 1;
    }
    const k = new Uint8Array(N), out = new Uint8Array(N);
    for (let p = 0; p < N; p++) if (keep[cc.lab[p]]) k[p] = 1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const p = y * W + x;
      out[p] = k[p] | (x > 0 ? k[p - 1] : 0) | (y > 0 ? k[p - W] : 0) | (x > 0 && y > 0 ? k[p - W - 1] : 0);
    }
    return out;
  }

  // ================================================================ 4. 直边：沿像素边描轮廓（外环 + 洞）→ Douglas–Peucker
  // 前景永远在左手边；对角相接的「鞍点」一律右转 → 前景 8 连通、背景 4 连通（同 OpenCV findContours）
  const DX = [0, 1, 0, -1], DY = [-1, 0, 1, 0]; // 北 东 南 西
  function traceLoops(mask, W, H) {
    const PW = W + 2, pm = new Uint8Array(PW * (H + 2));
    for (let y = 0; y < H; y++) pm.set(mask.subarray(y * W, y * W + W), (y + 1) * PW + 1);
    const VW = W + 1, vis = new Uint8Array(VW * (H + 1)), cc = labelCC(mask, W, H), loops = [];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        // 每个环都至少有一条「上面是背景」的上边：从它起步向西走
        if (!pm[(y + 1) * PW + x + 1] || pm[y * PW + x + 1] || vis[y * VW + x + 1] & 8) continue;
        const pts = [];
        let vx = x + 1, vy = y, d = 3, P = 0;
        for (let guard = 0; guard < 4 * VW * (H + 1); guard++) {
          vis[vy * VW + vx] |= 1 << d;
          vx += DX[d]; vy += DY[d]; P++;
          const NW = pm[vy * PW + vx], NE = pm[vy * PW + vx + 1], SW = pm[(vy + 1) * PW + vx], SE = pm[(vy + 1) * PW + vx + 1];
          const oN = NW & (NE ^ 1), oE = NE & (SE ^ 1), oS = SE & (SW ^ 1), oW = SW & (NW ^ 1);
          const nd = oN + oE + oS + oW > 1 ? (d + 1) & 3 : oN ? 0 : oE ? 1 : oS ? 2 : 3;
          if (nd !== d) pts.push(vx, vy);
          if (vis[vy * VW + vx] & (1 << nd)) break;
          d = nd;
        }
        let a2 = 0;
        for (let i = 0, n = pts.length; i < n; i += 2) { const j = (i + 2) % n; a2 += pts[i] * pts[j + 1] - pts[j] * pts[i + 1]; }
        loops.push({ pts: Int32Array.from(pts), area: a2 / 2, per: P, comp: cc.lab[y * W + x] });
      }
    }
    // 归组：每个连通块一个外环（面积 < 0）+ 若干洞（面积 > 0，左手边是包住它的那块）
    const gi = new Int32Array(cc.n + 1).fill(-1), groups = [];
    for (const L of loops) if (L.area < 0) { gi[L.comp] = groups.length; groups.push({ outer: L, holes: [] }); }
    for (const L of loops) if (L.area > 0 && gi[L.comp] >= 0) groups[gi[L.comp]].holes.push(L);
    return groups;
  }
  // 闭合轮廓的 Douglas–Peucker，照 OpenCV approxPolyDP（closed=true）：
  // ① 从第 0 点起连找 3 轮「离上一点最远的点」，得到一对近似最远点 a、b；② 两段分别递归拉直（离弦 > eps 的点留下）；
  // ③ 从 a 开始按顺序输出，再扫一遍删掉几乎共线的点（OpenCV 最后那遍清理，横平竖直的边不删）
  function dpClosed(pts, eps) {
    const n = pts.length >> 1;
    if (n < 3) return null;
    const e2 = eps * eps;
    let start = 0, off = 0, maxd = 0;
    for (let it = 0; it < 3; it++) {
      start = (start + off) % n;
      const x = pts[start * 2], y = pts[start * 2 + 1];
      maxd = 0;
      for (let j = 1; j < n; j++) { const q = (start + j) % n, dx = pts[q * 2] - x, dy = pts[q * 2 + 1] - y, d = dx * dx + dy * dy; if (d > maxd) { maxd = d; off = j; } }
    }
    if (maxd <= e2) return null; // 整个环小于 eps：OpenCV 只剩一个点，等于丢掉
    const a = start, b = (start + off) % n, keep = new Uint8Array(n); keep[a] = keep[b] = 1;
    const stack = [a, b, b, a];
    while (stack.length) {
      const e = stack.pop(), s = stack.pop(), len = (e - s + n) % n;
      if (len < 2) continue;
      const x0 = pts[s * 2], y0 = pts[s * 2 + 1], dx = pts[e * 2] - x0, dy = pts[e * 2 + 1] - y0, L2 = dx * dx + dy * dy;
      let bi = -1, bd = 0;
      for (let k = 1; k < len; k++) {
        const i = (s + k) % n, px = pts[i * 2] - x0, py = pts[i * 2 + 1] - y0;
        const dd = L2 > 0 ? Math.abs(py * dx - px * dy) : Math.hypot(px, py); // 叉积（没除弦长，比较时乘回去）
        if (dd > bd) { bd = dd; bi = i; }
      }
      if (bi >= 0 && (L2 > 0 ? bd * bd > e2 * L2 : bd * bd > e2)) { keep[bi] = 1; stack.push(s, bi, bi, e); }
    }
    const D = [];
    for (let k = 0; k < n; k++) { const i = (a + k) % n; if (keep[i]) D.push(pts[i * 2], pts[i * 2 + 1]); }
    // 清理（照 OpenCV 原样，含它就地改写的读写顺序）：中间点离两邻点连线足够近、且不在横竖线上，就删掉
    const cnt = D.length >> 1;
    let nc = cnt, pos = cnt - 1, sx = D[pos * 2], sy = D[pos * 2 + 1];
    if (++pos >= cnt) pos = 0;
    let wpos = pos, px = D[pos * 2], py = D[pos * 2 + 1];
    if (++pos >= cnt) pos = 0;
    for (let i = 0; i < cnt && nc > 2; i++) {
      const ex = D[pos * 2], ey = D[pos * 2 + 1];
      if (++pos >= cnt) pos = 0;
      const dx = ex - sx, dy = ey - sy, dist = Math.abs((px - sx) * dy - (py - sy) * dx);
      const inner = (px - sx) * (ex - px) + (py - sy) * (ey - py);
      if (dist * dist <= 0.5 * e2 * (dx * dx + dy * dy) && dx !== 0 && dy !== 0 && inner >= 0) {
        nc--;
        D[wpos * 2] = sx = ex; D[wpos * 2 + 1] = sy = ey;
        if (++wpos >= cnt) wpos = 0;
        px = D[pos * 2]; py = D[pos * 2 + 1];
        if (++pos >= cnt) pos = 0;
        i++;
        continue;
      }
      D[wpos * 2] = sx = px; D[wpos * 2 + 1] = sy = py;
      if (++wpos >= cnt) wpos = 0;
      px = ex; py = ey;
    }
    return nc >= 3 ? Float32Array.from(D.slice(0, nc * 2)) : null;
  }
  // 面积门槛同 Python 版（外环 < amin 丢掉；洞 < amin/2 丢掉，即填实）。OpenCV 的面积按穿过像素中心的轮廓量，
  // 这里的环沿像素边走，所以换算一下：外环 ≈ 像素数 − 周长/2 + 1，洞 ≈ 像素数 + 周长/2 − 1
  function simplifyGroups(groups, eps, amin) {
    const out = [];
    for (const g of groups) {
      if (-g.outer.area - g.outer.per / 2 + 1 < amin) continue;
      const o = dpClosed(g.outer.pts, eps); if (!o) continue;
      const rings = [o];
      for (const h of g.holes) { if (h.area + h.per / 2 - 1 < amin / 2) continue; const r = dpClosed(h.pts, eps); if (r) rings.push(r); }
      out.push(rings);
    }
    return out;
  }

  // ================================================================ 分段流程（页面按需重算，每段结果缓存）
  function closeSil(B) { return morphBin(morphBin(B.m, B.W, B.H, 5, true), B.W, B.H, 5, false); } // 11×11 闭运算：补掉发丝间的小缝
  // A 段（最慢，只跟图片有关）：平滑 + k-means + 线稿连通域 + 人物外形
  function* analyzeGen(B, opt, ms) {
    opt = Object.assign({}, DEFAULTS, opt);
    if (!B.n) throw new Error('empty figure: no pixel with alpha > 128');
    const t = {}; let t0 = now();
    if (!ms) { ms = {}; yield* meanShiftGen(B, opt.sp, opt.sr, ms); }
    t.meanShift = now() - t0; t0 = now();
    const km = kmeans(B, ms.img, opt.k, opt.seed);
    t.kmeans = now() - t0; t0 = now();
    yield 0.88;
    const lineCC = lineComponents(B, opt.line);
    t.lineCC = now() - t0; t0 = now();
    yield 0.95;
    const sil = closeSil(B), silGroups = traceLoops(sil, B.W, B.H); // 外形只跟图片有关：在这一段描一次
    t.sil = now() - t0;
    return { smooth: ms.img, refined: ms.refined, labels: km.labels, clusters: km.clusters, bins: km.bins, lineCC, sil, silGroups, t };
  }
  function analyze(B, opt) { const g = analyzeGen(B, opt); let r; while (!(r = g.next()).done); return r.value; }
  // 浏览器里用：每算 ~40ms 让出一次，界面能刷新「重绘中…」；给了 Worker 池就多线程算平滑
  function yieldNow() {
    return new Promise((res) => {
      if (typeof MessageChannel !== 'undefined') { const ch = new MessageChannel(); ch.port1.onmessage = () => res(); ch.port2.postMessage(0); }
      else setTimeout(res, 0);
    });
  }
  async function analyzeAsync(B, opt, onProgress, pool) {
    opt = Object.assign({}, DEFAULTS, opt);
    if (!B.n) throw new Error('empty figure: no pixel with alpha > 128');
    const prog = (v) => onProgress && onProgress(v);
    if (pool) {
      try { // 多线程：平滑交给 Worker；细层在算的时候，主线程把线稿、外形算掉
        const t = { workers: pool.size }; const t0 = now();
        const c = msCoarse(B, opt.sp, opt.sr);
        await pool.run(c.Lv, c.dst, c.todo, c.h2, (f) => prog(0.15 * f));
        const f = msFine(B, opt.sp, opt.sr, c);
        const fine = pool.run(f.Lv, f.dst, f.todo, B.H, (g) => prog(0.15 + 0.7 * g));
        let t1 = now(); const lineCC = lineComponents(B, opt.line); t.lineCC = now() - t1;
        t1 = now(); const sil = closeSil(B), silGroups = traceLoops(sil, B.W, B.H); t.sil = now() - t1;
        await fine; t.meanShift = now() - t0;
        prog(0.88); await yieldNow();
        t1 = now(); const km = kmeans(B, f.dst, opt.k, opt.seed); t.kmeans = now() - t1;
        return { smooth: f.dst, refined: f.refined, labels: km.labels, clusters: km.clusters, bins: km.bins, lineCC, sil, silGroups, t };
      } catch (e) { /* Worker 出错：退回单线程 */ }
    }
    const g = analyzeGen(B, opt); let r, t0 = now();
    while (!(r = g.next()).done) {
      if (now() - t0 > 40) { prog(r.value); await yieldNow(); t0 = now(); }
    }
    return r.value;
  }
  // B 段（换「红色给谁」才重算）：三色图 → 小碎块并进大块 → 纸色分块（分块线）→ 外形 / 红 / 黑三层的原始轮廓
  // cls3 是第 ② 步的三色图（和参考实现对照的就是它）；cls 是并完碎块、真正剪成纸片的那张（mergeMin = 0 时两者相同）
  function layers(B, A, roles, opt) {
    opt = Object.assign({}, DEFAULTS, opt);
    const t0 = now(), { W, H, N } = B;
    const cls3 = classify(B, A.labels, roles, opt);
    const cls = opt.mergeMin > 0 ? mergeSmall(B, cls3, opt.mergeMin) : cls3, merged = cls.merged || 0;
    const tp = now(), pm = opt.pieceMin > 0 && A.lineCC && A.smooth ? pieceMap(B, A, cls, opt) : null;
    const pieces = pm ? { lab: pm.lab, n: pm.n, cells: pm.cells, chains: pieceChains(B, pm.lab), ms: now() - tp } : null;
    const pick = (ci) => { const mk = new Uint8Array(N); for (let p = 0; p < N; p++) if (cls[p] === ci) mk[p] = 1; return morphBin(morphBin(mk, W, H, 1, false), W, H, 1, true); }; // 3×3 开运算
    const groups = { sil: A.silGroups || traceLoops(A.sil, W, H), red: traceLoops(pick(2), W, H), black: traceLoops(pick(3), W, H) };
    const area = { paper: 0, red: 0, black: 0 };
    for (let p = 0; p < N; p++) { const c = cls[p]; if (c === 1) area.paper++; else if (c === 2) area.red++; else if (c === 3) area.black++; }
    for (const k in area) area[k] /= B.n;
    return { cls, cls3, merged, pieces, groups, area, figH: B.bottom - B.top + 1, ms: now() - t0 };
  }
  // C 段（换脸框才重算）：线稿
  function lines(B, A, faceBox, opt) {
    opt = Object.assign({}, DEFAULTS, opt);
    const t0 = now(), mask = lineMask(B, A.lineCC, faceBox, opt);
    return { mask, groups: traceLoops(mask, B.W, B.H), ms: now() - t0 };
  }
  // D 段（拖「直边程度」才重算）：拉直成多边形。顺序：外形（纸，带黑边）→ 分块线（开放折线）→ 红 → 黑 → 线稿（Ln 为 null = 不画线稿，默认）
  function shapes(Ly, Ln, eps, opt) {
    opt = Object.assign({}, DEFAULTS, opt);
    const t0 = now(), out = [];
    for (const rings of simplifyGroups(Ly.groups.sil, eps * 0.8, 400)) out.push({ c: 'paper', outline: true, rings });
    if (Ly.pieces && Ly.pieces.chains.length) { // 分块线：拉直；一头悬空的短线不画；悬空的一头往外多伸 2px（藏进红 / 黑块或外轮廓里）
      const minLen = opt.pieceSpur * Ly.figH, polys = [];
      for (const c of Ly.pieces.chains) {
        const free = c.ends[0] === 1 || c.ends[1] === 1;
        if ((c.closed || free) && c.len < minLen) continue;
        const pts = c.closed ? dpClosed(c.pts.slice(0, -2), eps) : dpOpen(c.pts, eps);
        if (!pts || pts.length < 4) continue;
        if (!c.closed) for (const [e, ok] of [[0, c.ends[0] === 1], [1, c.ends[1] === 1]]) {
          if (!ok) continue;
          const m = pts.length >> 1, i = e ? m - 1 : 0, j = e ? m - 2 : 1, dx = pts[i * 2] - pts[j * 2], dy = pts[i * 2 + 1] - pts[j * 2 + 1], L = Math.hypot(dx, dy) || 1;
          pts[i * 2] += dx / L * 2; pts[i * 2 + 1] += dy / L * 2;
        }
        polys.push({ pts, closed: !!c.closed });
      }
      if (polys.length) out.push({ c: 'black', piece: true, width: opt.pieceWidth, polys });
    }
    // 红块、黑块：折点离外形边 ≤ snapSil 像素的挪到外形边上。色块和外形是各自拉直的，贴着外轮廓的色块会和外形边差 1–4px：
    // 差在里面就露一条纸色细缝（红块边上一条浅线、黑块和喇叭锥之间一条灰线），差在外面就把黑色外轮廓吃掉一块
    const sil = []; for (const sh of out) if (sh.outline) sil.push(...sh.rings);
    for (const [grp, c] of [[Ly.groups.red, 'red'], [Ly.groups.black, 'black']]) {
      for (const rings of simplifyGroups(grp, eps, 80)) { if (opt.snapSil > 0) snapToSil(rings, sil, opt.snapSil); out.push({ c, rings }); }
    }
    if (Ln) for (const rings of simplifyGroups(Ln.groups, opt.lineEps, 14)) out.push({ c: 'black', line: true, rings });
    out.ms = now() - t0;
    return out;
  }
  function snapToSil(rings, sil, r) {
    const segs = [];
    for (const s of sil) { const n = s.length >> 1; for (let i = 0; i < n; i++) { const j = (i + 1) % n; segs.push(s[i * 2], s[i * 2 + 1], s[j * 2], s[j * 2 + 1]); } }
    for (const ring of rings) for (let i = 0; i < ring.length; i += 2) {
      const px = ring[i], py = ring[i + 1]; let bd = r * r, bx = px, by = py;
      for (let k = 0; k < segs.length; k += 4) {
        const ax = segs[k], ay = segs[k + 1], dx = segs[k + 2] - ax, dy = segs[k + 3] - ay, L2 = dx * dx + dy * dy;
        if (Math.abs(px - ax) > r + Math.abs(dx) || Math.abs(py - ay) > r + Math.abs(dy)) continue; // 外框都够不着
        let t = L2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = ax + t * dx, qy = ay + t * dy, d2 = (px - qx) * (px - qx) + (py - qy) * (py - qy);
        if (d2 < bd) { bd = d2; bx = qx; by = qy; }
      }
      ring[i] = bx; ring[i + 1] = by;
    }
  }
  // 一口气跑完（Node 测试、批量用）。redPick: 'auto' | 'none' | [色块号...]；lines: true 才算线稿（Ln 否则为 null）
  function run(rgba, W, H, opt) {
    opt = Object.assign({}, DEFAULTS, opt);
    const T = {}; let t0 = now();
    const B = prepare(rgba, W, H); T.prepare = now() - t0;
    const A = analyze(B, opt); Object.assign(T, A.t);
    const roles = opt.redPick === 'none' ? rolesFromSet(A.clusters, new Set(), opt) : Array.isArray(opt.redPick) ? rolesFromSet(A.clusters, new Set(opt.redPick), opt) : autoRoles(A.clusters, opt);
    const Ly = layers(B, A, roles, opt); T.layers = Ly.ms;
    const Ln = opt.lines ? lines(B, A, opt.faceBox || null, opt) : null; T.lines = Ln ? Ln.ms : 0; // 默认不画线稿
    const S = shapes(Ly, Ln, opt.eps, opt); T.shapes = S.ms;
    T.total = Object.values(T).reduce((a, b) => a + b, 0);
    return { B, A, roles, Ly, Ln, shapes: S, t: T };
  }

  // ================================================================ 找脸和嘴（给版式用：喇叭尖对准嘴、红圆框住脸）
  // rgba：人物头部那一段（裁掉透明边后的上 3%–35%，缩到人物高约 1400 的比例），宽 w 高 h。
  // 做法：不透明的浅橙色（肤色）像素 → 3×3 开运算 → 连通块。脸和手的区别：脸里有被皮肤整圈围住的非皮肤块（嘴；
  // 眼睛一般连着刘海，不成洞）。面积 ≥ 最大块 30% 的几块里，先挑脸下 65% 有这种洞的最大一块，洞的重心就是嘴；
  // 都没有洞就取最靠上的一块，嘴按脸框的 72% 高估。55 张 Our Notes 立绘实测 49 张找对。
  // 返回 { box: [x0, y0, x1, y1], mouth: [x, y], mouthFound } ；找不到返回 null（页面退回旧的估计，用户也可以点）
  function findFace(rgba, w, h) {
    const N = w * h, skin = new Uint8Array(N), lab = new Float64Array(3);
    for (let p = 0; p < N; p++) {
      const q = p * 4; if (rgba[q + 3] <= 200) continue;
      rgbToLab(rgba[q], rgba[q + 1], rgba[q + 2], lab, 0);
      const C = Math.hypot(lab[1], lab[2]), hue = (Math.atan2(lab[2], lab[1]) * 180) / Math.PI;
      if (lab[0] > 62 && C > 4 && C < 32 && hue > 20 && hue < 80) skin[p] = 1;
    }
    const cc = labelCC(morphBin(morphBin(skin, w, h, 1, false), w, h, 1, true), w, h);
    if (!cc.n) return null;
    let big = 0; for (let l = 1; l <= cc.n; l++) if (cc.area[l] > big) big = cc.area[l];
    const cand = [];
    for (let l = 1; l <= cc.n; l++) if (cc.area[l] >= big * 0.3 && cc.area[l] >= N * 0.002 && cc.x1[l] - cc.x0[l] + 1 >= w * 0.04 && cc.y1[l] - cc.y0[l] >= 8 && cc.y1[l] < h - 2) { // 碰到下边的是身子，不是脸；太瘦太扁的也不是
      const r = (cc.x1[l] - cc.x0[l] + 1) / (cc.y1[l] - cc.y0[l] + 1); if (r >= 0.55 && r <= 2) cand.push(l);
    }
    if (!cand.length) return null;
    cand.sort((p, q) => cc.area[q] - cc.area[p]);
    const reach = new Uint8Array(N), st = new Int32Array(N), hole = new Uint8Array(N);
    const boxOf = (l) => { const bx0 = cc.x0[l], by0 = cc.y0[l], bx1 = cc.x1[l] + 1, by1 = cc.y1[l] + 1; return { box: [bx0, by0, bx1, by1], mouth: [(bx0 + bx1) / 2, by0 + (by1 - by0) * 0.72], mouthFound: false }; };
    for (const face of cand.slice(0, 4)) {
      const bx0 = cc.x0[face], by0 = cc.y0[face], bx1 = cc.x1[face] + 1, by1 = cc.y1[face] + 1, bw = bx1 - bx0, bh = by1 - by0;
      const res = boxOf(face);
      // 洞：从四边把「不是这块」的像素 4 连通地灌一遍，灌不到的就是被它整圈围住的
      reach.fill(0); hole.fill(0); let sp = 0;
      const push = (p) => { if (!reach[p] && cc.lab[p] !== face) { reach[p] = 1; st[sp++] = p; } };
      for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
      for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
      while (sp) { const p = st[--sp], x = p % w; if (x > 0) push(p - 1); if (x < w - 1) push(p + 1); if (p >= w) push(p - w); if (p < N - w) push(p + w); }
      for (let p = 0; p < N; p++) if (!reach[p] && cc.lab[p] !== face) hole[p] = 1;
      const hc = labelCC(hole, w, h), sx = new Float64Array(hc.n + 1), sy = new Float64Array(hc.n + 1);
      for (let p = 0; p < N; p++) { const l = hc.lab[p]; if (l) { sx[l] += p % w; sy[l] += (p / w) | 0; } }
      const minA = Math.max(6, 0.0015 * bw * bh);
      let m = 0;
      for (let l = 1; l <= hc.n; l++) if (hc.area[l] >= minA && sy[l] / hc.area[l] >= by0 + bh * 0.35 && (!m || hc.area[l] > hc.area[m])) m = l;
      if (!m) continue;
      // 张嘴时上下唇、牙齿可能分成几块：把离最大块不远的几块合起来取重心
      const mcx = sx[m] / hc.area[m], mcy = sy[m] / hc.area[m];
      let A = 0, X = 0, Y = 0;
      for (let l = 1; l <= hc.n; l++) {
        if (hc.area[l] < minA || Math.hypot(sx[l] / hc.area[l] - mcx, sy[l] / hc.area[l] - mcy) > bw * 0.12) continue;
        A += hc.area[l]; X += sx[l]; Y += sy[l];
      }
      res.mouth = [X / A, Y / A]; res.mouthFound = true;
      return res;
    }
    // 都没有嘴洞（闭嘴的细线连到了脸边）：取最靠上的一块
    return boxOf(cand.reduce((p, q) => (cc.y0[q] < cc.y0[p] ? q : p)));
  }

  // ================================================================ 输出：SVG 文本 / Path2D
  function ringsToD(rings) {
    let s = '';
    for (const r of rings) {
      s += 'M' + +r[0].toFixed(1) + ',' + +r[1].toFixed(1);
      for (let i = 2; i < r.length; i += 2) s += 'L' + +r[i].toFixed(1) + ',' + +r[i + 1].toFixed(1);
      s += 'Z';
    }
    return s;
  }
  function polysToD(polys) {
    let s = '';
    for (const q of polys) { const r = q.pts; s += 'M' + +r[0].toFixed(1) + ',' + +r[1].toFixed(1); for (let i = 2; i < r.length; i += 2) s += 'L' + +r[i].toFixed(1) + ',' + +r[i + 1].toFixed(1); if (q.closed) s += 'Z'; }
    return s;
  }
  // 和页面画布同一个画法：外轮廓 7px 黑边 → 填纸 → 分块线（只画在外形里面）→ 红、黑块各描一圈同色 5px 细边再填色 → 线稿
  // → 外轮廓只在外形外面再描一遍（盖住伸出外形的细边）
  function toSVG(list, W, H, pal, outline) {
    pal = Object.assign({}, PAL, pal || {}); outline = outline ?? DEFAULTS.outline;
    const sil = list.filter((sh) => sh.outline).map((sh) => ringsToD(sh.rings)).join('');
    const out = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`,
      `<defs><clipPath id="inside"><path d="${sil}" clip-rule="evenodd"/></clipPath><clipPath id="outside"><path d="M-20,-20H${W + 20}V${H + 20}H-20Z${sil}" clip-rule="evenodd"/></clipPath></defs>`];
    out.push(`<path d="${sil}" fill="none" stroke="${pal.black}" stroke-width="${outline}" stroke-linejoin="miter" stroke-miterlimit="4"/>`);
    out.push(`<path d="${sil}" fill="${pal.paper}" fill-rule="evenodd"/>`);
    for (const sh of list) if (sh.piece) out.push(`<path d="${polysToD(sh.polys)}" fill="none" stroke="${pal.black}" stroke-width="${sh.width}" stroke-linecap="round" stroke-linejoin="miter" stroke-miterlimit="4" clip-path="url(#inside)" data-piece="1"/>`);
    for (const c of ['black', 'red']) for (const sh of list) if (sh.c === c && !sh.outline && !sh.line && !sh.piece) out.push(`<path d="${ringsToD(sh.rings)}" fill="none" stroke="${pal[c]}" stroke-width="5" stroke-linejoin="round"/>`);
    for (const sh of list) if (!sh.outline && !sh.piece) out.push(`<path d="${ringsToD(sh.rings)}" fill="${pal[sh.c]}" fill-rule="evenodd"${sh.line ? ' data-line="1"' : ''}/>`);
    out.push(`<path d="${sil}" fill="none" stroke="${pal.black}" stroke-width="${outline}" stroke-linejoin="miter" stroke-miterlimit="4" clip-path="url(#outside)"/>`);
    out.push('</svg>');
    return out.join('\n');
  }
  // 每层一个 Path2D（偶奇规则填色；piece 是分块线，描边不填色）：{ sil, red, black, line, piece }
  function toPaths(list) {
    const P = { sil: new Path2D(), red: new Path2D(), black: new Path2D(), line: new Path2D(), piece: new Path2D() };
    for (const sh of list) {
      if (sh.piece) { for (const q of sh.polys) { const r = q.pts; P.piece.moveTo(r[0], r[1]); for (let i = 2; i < r.length; i += 2) P.piece.lineTo(r[i], r[i + 1]); if (q.closed) P.piece.closePath(); } continue; }
      const path = P[sh.outline ? 'sil' : sh.line ? 'line' : sh.c];
      for (const r of sh.rings) { path.moveTo(r[0], r[1]); for (let i = 2; i < r.length; i += 2) path.lineTo(r[i], r[i + 1]); path.closePath(); }
    }
    return P;
  }

  return {
    DEFAULTS, PAL, prepare, analyze, analyzeAsync, makePool, autoRoles, rolesFromSet, baseRole, layers, lines, shapes, run, toSVG, toPaths, ringsToD, findFace,
    _internal: { meanShiftGen, kmeans, classify, mergeSmall, pieceMap, pieceChains, dpOpen, lineComponents, lineMask, traceLoops, dpClosed, simplifyGroups, labelCC, boxSum, morphBin, ellMax, ellMin, pyrDown3, pyrUp3, rgbToLab, labToRgb },
  };
});
