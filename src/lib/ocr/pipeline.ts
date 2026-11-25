// PaddleOCR (PP-OCRv6) text detection + recognition pipeline, written without OpenCV.
//
//  detection:  DB (differentiable binarization) probability map -> connected components ->
//              oriented rectangles (via principal component analysis) -> unclip
//  recognition: each line is resampled into an upright 48px-high strip. Vertical columns are
//              turned 90° counter-clockwise so the column's top becomes the strip's left,
//              which PP-OCR recognizes natively. CTC greedy decoding keeps per-character
//              alternatives so users can fix rare kanji with one tap.
import type { OcrChar, OcrLine, OcrOptions, Point, RGBAImage } from './types';

export interface Tensor { data: Float32Array; dims: number[] }
export type RunModel = (input: Tensor) => Promise<Tensor>;

const DET_MEAN = [0.485, 0.456, 0.406];
const DET_STD = [0.229, 0.224, 0.225];
const REC_H = 48;
const REC_MAX_W = 3200;

/** RGBA -> CHW float tensor in BGR channel order, ImageNet-normalized (det model input). */
export function detTensor(img: RGBAImage): Tensor {
  const { data, width: w, height: h } = img;
  const n = w * h;
  const out = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    const r = data[i * 4] / 255, g = data[i * 4 + 1] / 255, b = data[i * 4 + 2] / 255;
    out[i] = (b - DET_MEAN[0]) / DET_STD[0];
    out[n + i] = (g - DET_MEAN[1]) / DET_STD[1];
    out[2 * n + i] = (r - DET_MEAN[2]) / DET_STD[2];
  }
  return { data: out, dims: [1, 3, h, w] };
}

interface Component {
  cx: number; cy: number; // centroid (det px)
  t: Point; n: Point; // text direction & normal
  tmin: number; tmax: number; nmin: number; nmax: number;
  score: number;
  square: boolean;
}

/** Connected components on the thresholded probability map, each summarized as an oriented rectangle. */
export function findComponents(prob: Float32Array, w: number, h: number, thresh: number, boxThresh: number, unclipRatio: number): Component[] {
  const labels = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  const comps: Component[] = [];
  let label = 0;
  for (let start = 0; start < w * h; start++) {
    if (labels[start] || prob[start] <= thresh) continue;
    label++;
    let sp = 0;
    stack[sp++] = start;
    labels[start] = label;
    const pix: number[] = [];
    let sum = 0, sx = 0, sy = 0;
    while (sp) {
      const idx = stack[--sp];
      pix.push(idx);
      sum += prob[idx];
      const x = idx % w, y = (idx - x) / w;
      sx += x; sy += y;
      if (x > 0 && !labels[idx - 1] && prob[idx - 1] > thresh) { labels[idx - 1] = label; stack[sp++] = idx - 1; }
      if (x < w - 1 && !labels[idx + 1] && prob[idx + 1] > thresh) { labels[idx + 1] = label; stack[sp++] = idx + 1; }
      if (y > 0 && !labels[idx - w] && prob[idx - w] > thresh) { labels[idx - w] = label; stack[sp++] = idx - w; }
      if (y < h - 1 && !labels[idx + w] && prob[idx + w] > thresh) { labels[idx + w] = label; stack[sp++] = idx + w; }
    }
    const count = pix.length;
    if (count < 6) continue;
    const score = sum / count;
    if (score < boxThresh) continue;
    const cx = sx / count, cy = sy / count;
    // Second moments -> principal axis.
    let sxx = 0, syy = 0, sxy = 0;
    for (const idx of pix) {
      const x = (idx % w) - cx, y = Math.floor(idx / w) - cy;
      sxx += x * x; syy += y * y; sxy += x * y;
    }
    let theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    // Snap near-axis-aligned lines to avoid needless resampling blur.
    const deg = (theta * 180) / Math.PI;
    if (Math.abs(deg) < 2) theta = 0;
    else if (Math.abs(Math.abs(deg) - 90) < 2) theta = Math.sign(deg) * Math.PI / 2;
    let ax = { x: Math.cos(theta), y: Math.sin(theta) };
    let ext = extents(pix, w, cx, cy, ax);
    let square = false;
    // Single characters / blobs: PCA direction is meaningless; fall back to the axis-aligned box.
    if ((ext.amax - ext.amin + 1) / (ext.bmax - ext.bmin + 1) < 1.5) {
      ax = { x: 1, y: 0 };
      ext = extents(pix, w, cx, cy, ax);
      square = true;
    }
    // Long axis is ax; orient it for reading: horizontal lines left->right, vertical columns top->bottom.
    let t = ax;
    const vertical = !square && Math.abs(ax.y) > Math.abs(ax.x);
    if ((vertical && t.y < 0) || (!vertical && t.x < 0)) t = { x: -t.x, y: -t.y };
    const flip = t !== ax;
    let tmin = flip ? -ext.amax : ext.amin, tmax = flip ? -ext.amin : ext.amax;
    // normal = t rotated 90° clockwise (screen coords)
    const nrm = { x: -t.y, y: t.x };
    // b-axis of extents is (-ax.y, ax.x); if t was flipped the normal flips too.
    let nmin = flip ? -ext.bmax : ext.bmin, nmax = flip ? -ext.bmin : ext.bmax;
    // pixels are 1 unit wide
    tmin -= 0.5; tmax += 0.5; nmin -= 0.5; nmax += 0.5;
    const lw = tmax - tmin, lh = nmax - nmin;
    if (Math.min(lw, lh) < 3) continue;
    const d = (lw * lh * unclipRatio) / (2 * (lw + lh));
    comps.push({ cx, cy, t, n: nrm, tmin: tmin - d, tmax: tmax + d, nmin: nmin - d, nmax: nmax + d, score, square });
  }
  return comps;
}

function extents(pix: number[], w: number, cx: number, cy: number, a: Point) {
  let amin = Infinity, amax = -Infinity, bmin = Infinity, bmax = -Infinity;
  for (const idx of pix) {
    const x = (idx % w) - cx, y = Math.floor(idx / w) - cy;
    const pa = x * a.x + y * a.y;
    const pb = -x * a.y + y * a.x;
    if (pa < amin) amin = pa;
    if (pa > amax) amax = pa;
    if (pb < bmin) bmin = pb;
    if (pb > bmax) bmax = pb;
  }
  return { amin, amax, bmin, bmax };
}

/** Bilinear sample with (optional) 2x2 supersampling, writing BGR-normalized CHW floats. */
function sampleStrip(src: RGBAImage, p0: Point, du: Point, dv: Point, outW: number, outH: number): Float32Array {
  const out = new Float32Array(3 * outW * outH);
  const plane = outW * outH;
  const { data, width: sw, height: sh } = src;
  const stepU = Math.hypot(du.x, du.y) / outW;
  const stepV = Math.hypot(dv.x, dv.y) / outH;
  const ss = Math.max(stepU, stepV) > 1.8 ? 2 : 1;
  const px = (x: number, y: number, c: number) => {
    x = Math.min(Math.max(x, 0), sw - 1);
    y = Math.min(Math.max(y, 0), sh - 1);
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const x1 = Math.min(x0 + 1, sw - 1), y1 = Math.min(y0 + 1, sh - 1);
    const fx = x - x0, fy = y - y0;
    const a = data[(y0 * sw + x0) * 4 + c], b = data[(y0 * sw + x1) * 4 + c];
    const cc = data[(y1 * sw + x0) * 4 + c], d = data[(y1 * sw + x1) * 4 + c];
    return (a * (1 - fx) + b * fx) * (1 - fy) + (cc * (1 - fx) + d * fx) * fy;
  };
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const u = (x + (sx + 0.5) / ss) / outW;
          const v = (y + (sy + 0.5) / ss) / outH;
          const X = p0.x + u * du.x + v * dv.x - 0.5;
          const Y = p0.y + u * du.y + v * dv.y - 0.5;
          r += px(X, Y, 0); g += px(X, Y, 1); b += px(X, Y, 2);
        }
      }
      const k = ss * ss * 127.5;
      const i = y * outW + x;
      out[i] = b / k - 1;
      out[plane + i] = g / k - 1;
      out[2 * plane + i] = r / k - 1;
    }
  }
  return out;
}

export interface LineGeom {
  quad: [Point, Point, Point, Point];
  vertical: boolean;
  score: number;
}

/** Converts det-space components to source-space line quads, deciding orientation for square blobs. */
export function componentsToLines(comps: Component[], detW: number, detH: number, srcW: number, srcH: number, orientation: OcrOptions['orientation']): LineGeom[] {
  const sx = srcW / detW, sy = srcH / detH;
  const nonSquare = comps.filter((c) => !c.square);
  const vertCount = nonSquare.filter((c) => Math.abs(c.t.y) > Math.abs(c.t.x)).length;
  const docVertical = orientation === 'vertical' || (orientation === 'auto' && vertCount > nonSquare.length / 2);
  const lines: LineGeom[] = [];
  for (const c of comps) {
    let { t, n, tmin, tmax, nmin, nmax } = c;
    let vertical = Math.abs(t.y) > Math.abs(t.x);
    if (c.square && docVertical) {
      // Treat the blob as a short vertical column.
      t = { x: 0, y: 1 }; n = { x: -1, y: 0 };
      [tmin, tmax, nmin, nmax] = [c.nmin, c.nmax, -c.tmax, -c.tmin];
      vertical = true;
    }
    if (orientation === 'horizontal' && vertical) {
      // Forced horizontal: read the region as-is without rotating.
      // t' = -n, n' = t  (rotate the reading frame back by 90°)
      const t0 = t;
      t = { x: -n.x, y: -n.y }; n = t0;
      [tmin, tmax, nmin, nmax] = [-c.nmax, -c.nmin, c.tmin, c.tmax];
      vertical = false;
    }
    const P = (a: number, b: number): Point => ({
      x: Math.min(Math.max((c.cx + 0.5 + a * t.x + b * n.x) * sx, 0), srcW),
      y: Math.min(Math.max((c.cy + 0.5 + a * t.y + b * n.y) * sy, 0), srcH),
    });
    lines.push({ quad: [P(tmin, nmin), P(tmax, nmin), P(tmax, nmax), P(tmin, nmax)], vertical, score: c.score });
  }
  return lines;
}

export function recTensor(src: RGBAImage, quad: [Point, Point, Point, Point]): Tensor {
  const [p0, p1, , p3] = quad;
  const du = { x: p1.x - p0.x, y: p1.y - p0.y };
  const dv = { x: p3.x - p0.x, y: p3.y - p0.y };
  const lenU = Math.hypot(du.x, du.y), lenV = Math.max(Math.hypot(dv.x, dv.y), 1);
  const outW = Math.min(REC_MAX_W, Math.max(16, Math.ceil((REC_H * lenU) / lenV)));
  return { data: sampleStrip(src, p0, du, dv, outW, REC_H), dims: [1, 3, REC_H, outW] };
}

/** CTC greedy decode, keeping the top alternatives for each emitted character. `t` is the emitting timestep. */
export function ctcDecode(out: Tensor, dict: string[], altCount = 5): (OcrChar & { t: number })[] {
  const [, T, C] = out.dims;
  const d = out.data;
  const chars: (OcrChar & { t: number })[] = [];
  let prev = 0;
  for (let t = 0; t < T; t++) {
    const off = t * C;
    let best = 0, bestP = -Infinity;
    for (let c = 0; c < C; c++) if (d[off + c] > bestP) { bestP = d[off + c]; best = c; }
    if (best !== 0 && best !== prev) {
      const top: { c: number; p: number }[] = [];
      for (let c = 1; c < C; c++) {
        const p = d[off + c];
        if (c === best || p < 0.005) continue;
        if (top.length < altCount || p > top[top.length - 1].p) {
          top.push({ c, p });
          top.sort((a, b) => b.p - a.p);
          if (top.length > altCount) top.pop();
        }
      }
      const ch: OcrChar & { t: number } = { c: dict[best] ?? '', p: bestP, t };
      const alts = top.map((a) => ({ c: dict[a.c] ?? '', p: a.p })).filter((a) => a.c.trim());
      if (alts.length) ch.alts = alts;
      chars.push(ch);
    }
    prev = best;
  }
  // The recognizer emits ' ' between words in Latin text; trim edges.
  while (chars.length && chars[0].c === ' ') chars.shift();
  while (chars.length && chars[chars.length - 1].c === ' ') chars.pop();
  return chars.map((c) => ({ ...c, c: c.c.normalize('NFC') }));
}

/**
 * Vertical typesetting uses special glyph positions: 。、 and small kana sit in the top-right of
 * their cell, ー becomes a vertical bar and 「」 are rotated. After a column is turned into a
 * horizontal strip, the recognizer skips many of these. We find ink that no emitted character
 * accounts for and recover it: by shape (ー 。 、 「 」), or by moving the mark to where
 * horizontal text would place it (bottom-aligned) and recognizing the strip again.
 */
export async function restoreVerticalMarks(
  strip: Tensor,
  T: number,
  chars: (OcrChar & { t: number })[],
  runRec: RunModel,
  dict: string[],
): Promise<(OcrChar & { t: number })[]> {
  const [, , H, W] = strip.dims;
  const plane = H * W;
  const gray = new Float32Array(plane);
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < plane; i++) {
    const v = (strip.data[i] + strip.data[plane + i] + strip.data[2 * plane + i]) / 3;
    gray[i] = v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (max - min < 0.5) return chars;
  const thr = (min + max) / 2;
  const ink = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && gray[y * W + x] < thr;
  const colInk = new Int32Array(W);
  for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) if (ink(x, y)) colInk[x]++;
  const centers = chars.map((c) => ((c.t + 0.5) * W) / T);
  const found: (OcrChar & { t: number })[] = [];
  const shiftable: { x0: number; x1: number; y0: number; y1: number }[] = [];
  const tAt = (x0: number, x1: number) => Math.floor(((x0 + x1) / 2 / W) * T);
  const frac = (xa: number, xb: number, ya: number, yb: number) => {
    let n = 0, k = 0;
    for (let x = xa; x <= xb; x++) for (let y = ya; y <= yb; y++) { n++; if (ink(x, y)) k++; }
    return n ? k / n : 0;
  };

  for (let x = 0; x < W; ) {
    if (!colInk[x]) { x++; continue; }
    const x0 = x;
    while (x < W && colInk[x]) x++;
    const x1 = x; // exclusive
    if (centers.some((c) => c >= x0 - 3 && c <= x1 + 3)) continue;
    let y0 = H, y1 = -1;
    for (let xx = x0; xx < x1; xx++) for (let y = 0; y < H; y++) if (ink(xx, y)) { if (y < y0) y0 = y; if (y > y1) y1 = y; }
    const w = x1 - x0, h = y1 - y0 + 1;
    if (w < 3 && h < 3) continue;
    if (h > H * 0.8) continue; // fragment of a full-height glyph that was already read
    const t = tAt(x0, x1);
    if (h <= Math.max(3, H * 0.12) && w >= H * 0.4) { found.push({ c: 'ー', p: 0.8, t }); continue; }
    if (w <= H * 0.45 && h <= H * 0.45 && y1 <= H * 0.5) {
      const cx = Math.round((x0 + x1 - 1) / 2), cy = Math.round((y0 + y1) / 2);
      let filled = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (ink(cx + dx, cy + dy)) filled++;
      found.push({ c: filled <= 2 ? '。' : '、', p: 0.8, t });
      continue;
    }
    if (w <= H * 0.4 && h >= H * 0.45) {
      // Corner brackets: 「 is ┌ (ink on left edge + top edge), 」 is ┘.
      const e = 1;
      const left = frac(x0, x0 + e, y0, y1), right = frac(x1 - 1 - e, x1 - 1, y0, y1);
      const top = frac(x0, x1 - 1, y0, y0 + e), bottom = frac(x0, x1 - 1, y1 - e, y1);
      if (left > 0.7 && top > 0.6 && right < 0.4 && bottom < 0.4) { found.push({ c: '「', p: 0.7, t }); continue; }
      if (right > 0.7 && bottom > 0.6 && left < 0.4 && top < 0.4) { found.push({ c: '」', p: 0.7, t }); continue; }
    }
    shiftable.push({ x0, x1, y0, y1 });
  }

  if (shiftable.length) {
    // Bottom-align the remaining marks (small kana) and recognize the strip again.
    const data = strip.data.slice();
    for (const b of shiftable) {
      const h = b.y1 - b.y0 + 1;
      const ny0 = Math.max(0, H - 2 - h);
      for (let c = 0; c < 3; c++) {
        const off = c * plane;
        const blob: number[] = [];
        for (let y = b.y0; y <= b.y1; y++) for (let x = b.x0; x < b.x1; x++) blob.push(strip.data[off + y * W + x]);
        for (let y = 0; y < H; y++) for (let x = b.x0; x < b.x1; x++) data[off + y * W + x] = 1;
        let i = 0;
        for (let y = ny0; y < ny0 + h; y++) for (let x = b.x0; x < b.x1; x++) data[off + y * W + x] = blob[i++];
      }
    }
    const out2 = await runRec({ data, dims: strip.dims });
    const T2 = out2.dims[1];
    for (const ch of ctcDecode(out2, dict)) {
      const cx = ((ch.t + 0.5) * W) / T2;
      // Only kana/punctuation: shifted fragments of kanji would otherwise be read twice.
      if (!(ch.p > 0.5 && ch.c.trim() && !/\p{Script=Han}/u.test(ch.c) && shiftable.some((b) => cx >= b.x0 - 4 && cx <= b.x1 + 4))) continue;
      const t = Math.floor((cx / W) * T);
      // A detached stroke of the neighbouring character (e.g. one stroke of こ) reads as that character again.
      const next = chars.findIndex((c) => c.t > t);
      const neighbours = [chars[next < 0 ? chars.length - 1 : next - 1], next >= 0 ? chars[next] : undefined];
      if (neighbours.some((n) => n?.c === ch.c)) continue;
      found.push({ ...ch, t });
    }
  }

  const out = [...chars];
  for (const f of found.sort((a, b) => a.t - b.t)) {
    const at = out.findIndex((ch) => ch.t > f.t);
    out.splice(at < 0 ? out.length : at, 0, f);
  }
  return out;
}

export function quadBox(q: Point[]): OcrLine['box'] {
  const xs = q.map((p) => p.x), ys = q.map((p) => p.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** Reading order: rows top->bottom (left->right within a row), or columns right->left (top->bottom within). */
export function sortLines(lines: OcrLine[]): OcrLine[] {
  const vert = lines.reduce((n, l) => n + (l.vertical ? l.chars.length : 0), 0);
  const total = lines.reduce((n, l) => n + l.chars.length, 0);
  const vertical = vert > total / 2;
  const key = (l: OcrLine) => (vertical ? -(l.box.x + l.box.w / 2) : l.box.y + l.box.h / 2);
  const sorted = [...lines].sort((a, b) => key(a) - key(b));
  // Group overlapping lines (same row / column) and order them along the reading direction.
  const groups: OcrLine[][] = [];
  for (const l of sorted) {
    const g = groups[groups.length - 1];
    const ref = g?.[0];
    const overlap = ref
      ? vertical
        ? overlap1d(ref.box.x, ref.box.w, l.box.x, l.box.w)
        : overlap1d(ref.box.y, ref.box.h, l.box.y, l.box.h)
      : 0;
    if (g && overlap > 0.5) g.push(l);
    else groups.push([l]);
  }
  return groups.flatMap((g) => g.sort((a, b) => (vertical ? a.box.y - b.box.y : a.box.x - b.box.x)));
}

function overlap1d(a: number, al: number, b: number, bl: number): number {
  const o = Math.min(a + al, b + bl) - Math.max(a, b);
  return o / Math.max(1, Math.min(al, bl));
}

export async function runOcr(
  det: RGBAImage,
  src: RGBAImage,
  opts: OcrOptions,
  runDet: RunModel,
  runRec: RunModel,
  dict: string[],
): Promise<{ lines: OcrLine[]; ms: { det: number; rec: number } }> {
  const t0 = performance.now();
  const probT = await runDet(detTensor(det));
  const [, , ph, pw] = probT.dims;
  const comps = findComponents(probT.data, pw, ph, 0.2, opts.boxThresh, opts.unclipRatio);
  const geoms = componentsToLines(comps, pw, ph, src.width, src.height, opts.orientation);
  const t1 = performance.now();
  const lines: OcrLine[] = [];
  for (const g of geoms) {
    const strip = recTensor(src, g.quad);
    const out = await runRec(strip);
    let decoded = ctcDecode(out, dict);
    if (g.vertical && decoded.length) decoded = await restoreVerticalMarks(strip, out.dims[1], decoded, runRec, dict);
    const T = out.dims[1];
    const chars: OcrChar[] = decoded.map(({ t, ...c }) => ({ ...c, u: (t + 0.5) / T }));
    if (!chars.length) continue;
    lines.push({ text: chars.map((c) => c.c).join(''), chars, vertical: g.vertical, quad: g.quad, box: quadBox(g.quad), score: g.score });
  }
  return { lines: sortLines(lines), ms: { det: t1 - t0, rec: performance.now() - t1 } };
}
