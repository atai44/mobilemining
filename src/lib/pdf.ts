// PDF support (pdf.js, loaded on demand). Pages with a text layer (e-books, articles) use the
// PDF's own text and glyph positions: exact, instant, no OCR. Scanned pages fall back to OCR.
import type { OcrChar, OcrLine, Point } from './ocr/types';
import type { PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';

// Legacy build: polyfills newer JS (e.g. Map#getOrInsertComputed) that Safari and older browsers lack.
type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
let lib: Promise<PdfJs> | null = null;

function pdfjs(): Promise<PdfJs> {
  lib ??= (async () => {
    const [L, worker] = await Promise.all([import('pdfjs-dist/legacy/build/pdf.mjs'), import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')]);
    L.GlobalWorkerOptions.workerSrc = worker.default;
    return L;
  })();
  return lib;
}

export async function openPdf(data: ArrayBuffer, base: string): Promise<PDFDocumentProxy> {
  const L = await pdfjs();
  return L.getDocument({
    data,
    cMapUrl: base + 'pdfjs/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: base + 'pdfjs/standard_fonts/',
    wasmUrl: base + 'pdfjs/wasm/',
    iccUrl: base + 'pdfjs/iccs/',
  } as Parameters<PdfJs['getDocument']>[0]).promise;
}

interface Glyphs {
  vertical: boolean;
  /** Reading-frame quad [start-top, end-top, end-bottom, start-bottom] in canvas px. */
  quad: [Point, Point, Point, Point];
  chars: { c: string; at: Point }[]; // character centres
  size: number; // font size in px
}

const add = (a: Point, b: Point, k = 1): Point => ({ x: a.x + b.x * k, y: a.y + b.y * k });

/** Splits one pdf.js text item into positioned characters. */
function itemGlyphs(str: string, m: number[], width: number, height: number, ttb: boolean, scale: number): Glyphs | null {
  const chars = Array.from(str);
  if (!chars.length || !str.trim()) return null;
  const size = Math.hypot(m[2], m[3]) || Math.hypot(m[0], m[1]);
  if (!size) return null;
  const o = { x: m[4], y: m[5] };
  if (ttb) {
    // Vertical writing: the origin is the top centre of the first glyph; text runs down.
    const len = Math.max(height * scale, size * chars.length * 0.5);
    const down = { x: 0, y: 1 }, half = size / 2;
    const step = len / chars.length;
    return {
      vertical: true,
      size,
      quad: [{ x: o.x + half, y: o.y }, { x: o.x + half, y: o.y + len }, { x: o.x - half, y: o.y + len }, { x: o.x - half, y: o.y }],
      chars: chars.map((c, i) => ({ c, at: add(o, down, step * (i + 0.5)) })),
    };
  }
  // Horizontal: baseline origin; "up" is the text-space y axis mapped to the canvas.
  const len = Math.max(width * scale, 1);
  const along = { x: m[0] / Math.hypot(m[0], m[1]), y: m[1] / Math.hypot(m[0], m[1]) };
  const up = { x: -m[2], y: -m[3] }; // canvas y points down
  const upN = { x: up.x / size, y: up.y / size };
  const top = add(o, upN, size * 0.88), bottom = add(o, upN, -size * 0.12);
  const step = len / chars.length;
  return {
    vertical: false,
    size,
    quad: [top, add(top, along, len), add(bottom, along, len), bottom],
    chars: chars.map((c, i) => ({ c, at: add(add(o, along, step * (i + 0.5)), upN, size * 0.38) })),
  };
}

/** Does `b` continue line `a` (next glyphs on the same baseline / in the same column)? */
function continues(a: Glyphs, b: Glyphs): 'h' | 'v' | null {
  const s = Math.max(a.size, b.size);
  if (Math.min(a.size, b.size) < s * 0.7) return null;
  const last = a.chars[a.chars.length - 1].at, first = b.chars[0].at;
  const dx = first.x - last.x, dy = first.y - last.y;
  if ((!a.vertical || a.chars.length === 1) && (!b.vertical || b.chars.length === 1) && Math.abs(dy) < s * 0.3 && dx > 0 && dx < s * 1.6) return 'h';
  if ((a.vertical || a.chars.length === 1) && (b.vertical || b.chars.length === 1) && Math.abs(dx) < s * 0.3 && dy > 0 && dy < s * 1.6) return 'v';
  return null;
}

function toLine(parts: Glyphs[], vertical: boolean, key: string): OcrLine {
  const pts = parts.flatMap((p) => p.chars);
  const size = Math.max(...parts.map((p) => p.size));
  const xs = parts.flatMap((p) => p.quad.map((q) => q.x)), ys = parts.flatMap((p) => p.quad.map((q) => q.y));
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const quad: OcrLine['quad'] = vertical
    ? [{ x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }, { x: x0, y: y0 }]
    : [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
  const span = vertical ? y1 - y0 : x1 - x0;
  const chars: OcrChar[] = pts.map((p) => ({ c: p.c, p: 1, u: Math.min(1, Math.max(0, ((vertical ? p.at.y - y0 : p.at.x - x0) / Math.max(span, 1)))) }));
  const mid = pts.map((p) => (vertical ? { x: (x0 + x1) / 2, y: p.at.y } : { x: p.at.x, y: (y0 + y1) / 2 }));
  return { text: pts.map((p) => p.c).join(''), chars, vertical, quad, box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, score: 1, key, mid, width: size };
}

export interface RenderedPage { canvas: HTMLCanvasElement; lines: OcrLine[]; textChars: number }

/** Renders page `n` (1-based) and extracts its text layer as lines in canvas coordinates. */
export async function renderPage(doc: PDFDocumentProxy, n: number, maxSide = 2400): Promise<RenderedPage> {
  const L = await pdfjs();
  const page = await doc.getPage(n);
  const vp1 = page.getViewport({ scale: 1 });
  const scale = Math.min(maxSide / Math.max(vp1.width, vp1.height), 4);
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(vp.width);
  canvas.height = Math.round(vp.height);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, canvasContext: ctx, viewport: vp } as Parameters<typeof page.render>[0]).promise;

  const tc = await page.getTextContent();
  const glyphs: Glyphs[] = [];
  for (const it of tc.items) {
    if (!('str' in it)) continue;
    const m = L.Util.transform(vp.transform, it.transform) as number[];
    // Vertical presentation forms (︒︑︵…) → ordinary punctuation, so lookups and sentences match.
    const str = it.str.normalize('NFC').replace(/[︐-︙︰-﹏]/g, (c) => c.normalize('NFKC'));
    const g = itemGlyphs(str, m, it.width, it.height, it.dir === 'ttb', scale);
    if (g) glyphs.push(g);
  }
  // Join items into lines (PDFs often store one item per glyph or per run).
  const lines: OcrLine[] = [];
  let cur: Glyphs[] = [];
  let dir: 'h' | 'v' | null = null;
  const flush = () => {
    if (!cur.length) return;
    const vertical = dir ? dir === 'v' : cur[0].vertical;
    lines.push(toLine(cur, vertical, `p${lines.length}`));
    cur = [];
    dir = null;
  };
  for (const g of glyphs) {
    const prev = cur[cur.length - 1];
    const c = prev ? continues(prev, g) : null;
    if (prev && c && (!dir || dir === c)) { cur.push(g); dir = c; }
    else { flush(); cur = [g]; }
  }
  flush();
  return { canvas, lines, textChars: lines.reduce((n, l) => n + l.chars.length, 0) };
}
