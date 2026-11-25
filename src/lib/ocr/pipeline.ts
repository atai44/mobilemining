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
  /** Centre line following the text (det px), in reading order. */
  mid: Point[];
  /** True text thickness (det px): median local width, unaffected by curvature or slant. */
  width: number;
  pix: number[];
}

/** Connected components of pixels above `thresh` (optionally only within `region`). */
function labelComponents(prob: Float32Array, w: number, h: number, thresh: number, region?: number[]): number[][] {
  const allowed = region ? new Uint8Array(w * h) : null;
  if (allowed) for (const i of region!) allowed[i] = 1;
  const ok = (i: number) => prob[i] > thresh && (!allowed || allowed[i] === 1);
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(region ? region.length + 1 : w * h);
  const out: number[][] = [];
  const starts = region ?? null;
  const n = starts ? starts.length : w * h;
  for (let k = 0; k < n; k++) {
    const start = starts ? starts[k] : k;
    if (seen[start] || !ok(start)) continue;
    let sp = 0;
    stack[sp++] = start;
    seen[start] = 1;
    const pix: number[] = [];
    while (sp) {
      const idx = stack[--sp];
      pix.push(idx);
      const x = idx % w;
      if (x > 0 && !seen[idx - 1] && ok(idx - 1)) { seen[idx - 1] = 1; stack[sp++] = idx - 1; }
      if (x < w - 1 && !seen[idx + 1] && ok(idx + 1)) { seen[idx + 1] = 1; stack[sp++] = idx + 1; }
      if (idx >= w && !seen[idx - w] && ok(idx - w)) { seen[idx - w] = 1; stack[sp++] = idx - w; }
      if (idx < w * (h - 1) && !seen[idx + w] && ok(idx + w)) { seen[idx + w] = 1; stack[sp++] = idx + w; }
    }
    out.push(pix);
  }
  return out;
}

/** Summarizes a pixel group as an oriented rectangle plus a curve-following centre line. */
function summarize(pix: number[], prob: Float32Array, w: number, boxThresh: number, unclipRatio: number): Component | null {
  const count = pix.length;
  if (count < 6) return null;
  let sum = 0, sx = 0, sy = 0;
  for (const idx of pix) { sum += prob[idx]; sx += idx % w; sy += Math.floor(idx / w); }
  const score = sum / count;
  if (score < boxThresh) return null;
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
  if (Math.min(lw, lh) < 3) return null;

  // Local cross-sections along the line: centre and width of the text in each slice.
  const bin = Math.max(3, Math.min(lh, lw) / 2);
  const nb = Math.max(1, Math.ceil(lw / bin));
  const bMin = new Float32Array(nb).fill(Infinity), bMax = new Float32Array(nb).fill(-Infinity), bSum = new Float32Array(nb), bCnt = new Int32Array(nb);
  for (const idx of pix) {
    const x = (idx % w) - cx, y = Math.floor(idx / w) - cy;
    const a = x * t.x + y * t.y, b = x * nrm.x + y * nrm.y;
    const k = Math.min(nb - 1, Math.max(0, Math.floor((a - tmin) / bin)));
    if (b < bMin[k]) bMin[k] = b;
    if (b > bMax[k]) bMax[k] = b;
    bSum[k] += b; bCnt[k]++;
  }
  const widths: number[] = [];
  const mid: Point[] = [];
  for (let k = 0; k < nb; k++) {
    if (bCnt[k] < 3) continue;
    widths.push(bMax[k] - bMin[k] + 1);
    const a = tmin + (k + 0.5) * bin, b = bSum[k] / bCnt[k];
    mid.push({ x: cx + a * t.x + b * nrm.x, y: cy + a * t.y + b * nrm.y });
  }
  widths.sort((p, q) => p - q);
  const kw = square ? Math.min(lw, lh) : widths[Math.floor(widths.length / 2)] ?? lh;
  // Unclip by the true (kernel) width, not the curvature-inflated box thickness.
  const d = (lw * kw * unclipRatio) / (2 * (lw + kw));
  return {
    cx, cy, t, n: nrm, tmin: tmin - d, tmax: tmax + d, nmin: nmin - d, nmax: nmax + d, score, square,
    mid: mid.length ? mid : [{ x: cx, y: cy }], width: kw + 2 * d, pix,
  };
}

/** Connected components on the thresholded probability map, each summarized as an oriented rectangle. */
export function findComponents(prob: Float32Array, w: number, h: number, thresh: number, boxThresh: number, unclipRatio: number): Component[] {
  const comps = labelComponents(prob, w, h, thresh).map((pix) => summarize(pix, prob, w, boxThresh, unclipRatio)).filter((c): c is Component => !!c);
  // Lines much wider than the page's typical line are usually two columns (or a column and its
  // furigana) that touch: split them by re-thresholding just that region more strictly.
  const lineWidths = comps.filter((c) => !c.square && c.tmax - c.tmin > 4 * c.width).map((c) => c.width).sort((a, b) => a - b);
  const median = lineWidths[Math.floor(lineWidths.length / 2)];
  if (!median || lineWidths.length < 3) return comps.map(({ pix: _p, ...c }) => ({ ...c, pix: [] }));
  const out: Component[] = [];
  for (const c of comps) {
    if (c.square || c.width < median * 1.45) { out.push(c); continue; }
    let parts: Component[] | null = null;
    for (const t2 of [0.35, 0.5, 0.65]) {
      const subs = labelComponents(prob, w, h, t2, c.pix).map((pix) => summarize(pix, prob, w, boxThresh * 0.8, unclipRatio)).filter((x): x is Component => !!x);
      const big = subs.filter((x) => x.pix.length > c.pix.length * 0.08);
      if (big.length >= 2 && big.every((x) => x.width < median * 1.3)) { parts = subs; break; }
    }
    out.push(...(parts ?? [c]));
  }
  return out.map(({ pix: _p, ...c }) => ({ ...c, pix: [] }));
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
  /** Curve-following centre line (src px), in reading order. */
  mid?: Point[];
  /** True text thickness (src px). */
  width?: number;
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
    // A square blob (one or two characters) has no direction of its own: follow the nearest
    // real line (pages can mix vertical body text with horizontal headings), else the page.
    let squareVertical = docVertical;
    if (c.square && orientation === 'auto') {
      let best = Infinity;
      for (const o of nonSquare) {
        // distance from the blob centre to the line's centre segment
        const dx = c.cx - o.cx, dy = c.cy - o.cy;
        const a = dx * o.t.x + dy * o.t.y;
        const ac = Math.min(Math.max(a, o.tmin), o.tmax);
        const d = Math.hypot(a - ac, dx * o.n.x + dy * o.n.y);
        const reach = 4 * Math.max(o.nmax - o.nmin, c.nmax - c.nmin);
        if (d < best && d < reach) { best = d; squareVertical = Math.abs(o.t.y) > Math.abs(o.t.x); }
      }
    }
    if (c.square && squareVertical) {
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
    const mid = c.mid
      .map((p) => ({ x: Math.min(Math.max((p.x + 0.5) * sx, 0), srcW), y: Math.min(Math.max((p.y + 0.5) * sy, 0), srcH) }))
      .sort((a, b) => (a.x - b.x) * t.x + (a.y - b.y) * t.y);
    const width = c.square ? Math.min(tmax - tmin, nmax - nmin) * (sx + sy) / 2 : c.width * (Math.abs(n.x) * sx + Math.abs(n.y) * sy);
    lines.push({ quad: [P(tmin, nmin), P(tmax, nmin), P(tmax, nmax), P(tmin, nmax)], vertical, score: c.score, mid, width });
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
    // Marks we recover (。、ー「」 small kana) occupy their own character cell; ink inside a
    // recognized character's cell is a detached stroke of that character (e.g. one stroke of こ).
    // Vertical 。、 hug the previous character (top-right of their own cell), so they get a smaller margin.
    const mid = (x0 + x1) / 2;
    const near = Math.min(Infinity, ...centers.map((c) => Math.abs(c - mid)));
    let y0 = H, y1 = -1;
    for (let xx = x0; xx < x1; xx++) for (let y = 0; y < H; y++) if (ink(xx, y)) { if (y < y0) y0 = y; if (y > y1) y1 = y; }
    const w = x1 - x0, h = y1 - y0 + 1;
    if (w < 3 && h < 3) continue;
    if (h > H * 0.8) continue; // fragment of a full-height glyph that was already read
    const t = tAt(x0, x1);
    if (near < H * 0.3) continue;
    if (h <= Math.max(3, H * 0.12) && w >= H * 0.4) { if (near >= H * 0.45) found.push({ c: 'ー', p: 0.8, t }); continue; }
    if (w <= H * 0.45 && h <= H * 0.45 && y1 <= H * 0.5) {
      const cx = Math.round((x0 + x1 - 1) / 2), cy = Math.round((y0 + y1) / 2);
      let filled = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (ink(cx + dx, cy + dy)) filled++;
      found.push({ c: filled <= 2 ? '。' : '、', p: 0.8, t });
      continue;
    }
    // Brackets sit inside the cell; ink touching the strip edge is a sliver of a neighbouring column.
    if (near < H * 0.45) continue;
    if (w <= H * 0.4 && h >= H * 0.45 && y0 > 1 && y1 < H - 2 && near >= H * 0.55) {
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

/** Step 1: find text lines (fast, whole image). Quads are in `src` pixel space. */
export async function detectLines(det: RGBAImage, srcW: number, srcH: number, opts: OcrOptions, runDet: RunModel): Promise<LineGeom[]> {
  const probT = await runDet(detTensor(det));
  const [, , ph, pw] = probT.dims;
  const comps = findComponents(probT.data, pw, ph, 0.2, opts.boxThresh, opts.unclipRatio);
  return componentsToLines(comps, pw, ph, srcW, srcH, opts.orientation);
}

/** Step 2: read one detected line. */
export async function recognizeLine(src: RGBAImage, g: LineGeom, runRec: RunModel, dict: string[]): Promise<OcrLine | null> {
  const strip = recTensor(src, g.quad);
  const out = await runRec(strip);
  let decoded = ctcDecode(out, dict);
  if (g.vertical && decoded.length) decoded = await restoreVerticalMarks(strip, out.dims[1], decoded, runRec, dict);
  const T = out.dims[1];
  const chars: OcrChar[] = decoded.map(({ t, ...c }) => ({ ...c, u: (t + 0.5) / T }));
  if (!chars.length) return null;
  return { text: chars.map((c) => c.c).join(''), chars, vertical: g.vertical, quad: g.quad, box: quadBox(g.quad), score: g.score, mid: g.mid, width: g.width };
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
  const geoms = await detectLines(det, src.width, src.height, opts, runDet);
  const t1 = performance.now();
  const lines: OcrLine[] = [];
  for (const g of geoms) {
    const l = await recognizeLine(src, g, runRec, dict);
    if (l) lines.push(l);
  }
  return { lines: sortLines(lines), ms: { det: t1 - t0, rec: performance.now() - t1 } };
}

// --- Page orientation -----------------------------------------------------------------------

const ORI_MEAN = [0.485, 0.456, 0.406];
const ORI_STD = [0.229, 0.224, 0.225];

/** CHW BGR tensor of a square RGBA crop rotated `quarter` × 90° counter-clockwise. */
function oriTensor(img: RGBAImage, quarter: number, out: Float32Array, offset: number) {
  const n = img.width; // square
  const plane = n * n;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      // source pixel for output (x, y) after CCW rotation
      let sx = x, sy = y;
      if (quarter === 1) { sx = n - 1 - y; sy = x; }
      else if (quarter === 2) { sx = n - 1 - x; sy = n - 1 - y; }
      else if (quarter === 3) { sx = y; sy = n - 1 - x; }
      const si = (sy * n + sx) * 4;
      const o = offset + y * n + x;
      out[o] = (img.data[si + 2] / 255 - ORI_MEAN[0]) / ORI_STD[0];
      out[o + plane] = (img.data[si + 1] / 255 - ORI_MEAN[1]) / ORI_STD[1];
      out[o + 2 * plane] = (img.data[si] / 255 - ORI_MEAN[2]) / ORI_STD[2];
    }
  }
}

/**
 * Page orientation from PP-LCNet doc_ori. Each crop is classified at all four rotations and the
 * rotations vote (a single centre crop is easily fooled by margins, pictures or curled pages).
 * Returns the counter-clockwise rotation (0/90/180/270) that makes the page upright, with scores.
 */
export async function pageOrientation(crops: RGBAImage[], runOri: RunModel): Promise<{ rotate: number; scores: number[] }> {
  const n = crops[0].width;
  const batch = crops.length * 4;
  const data = new Float32Array(batch * 3 * n * n);
  crops.forEach((c, ci) => { for (let q = 0; q < 4; q++) oriTensor(c, q, data, (ci * 4 + q) * 3 * n * n); });
  const out = await runOri({ data, dims: [batch, 3, n, n] });
  const scores = [0, 0, 0, 0];
  for (let ci = 0; ci < crops.length; ci++) {
    for (let r = 0; r < 4; r++) {
      const p = out.data.subarray((ci * 4 + r) * 4, (ci * 4 + r) * 4 + 4);
      // crop rotated by r quarters predicts label L => page needs (L + r) quarters CCW
      for (let k = 0; k < 4; k++) scores[k] += p[(k - r + 4) % 4];
    }
  }
  const total = crops.length * 4;
  const norm = scores.map((v) => v / total);
  const best = norm.indexOf(Math.max(...norm));
  return { rotate: best * 90, scores: norm };
}
