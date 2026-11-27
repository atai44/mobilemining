import type { LineGeomMsg, OcrLine, OcrOptions, Point, RGBAImage, WorkerRequest, WorkerResponse } from './types';
import { sortLines, quadBox } from './pipeline';

export interface Rect { x: number; y: number; w: number; h: number }
export type Progress = (p: { file: string; loaded: number; total: number }) => void;

const BASE = new URL(import.meta.env.BASE_URL, location.href).href;

function roundTo32(v: number) {
  return Math.max(32, Math.round(v / 32) * 32);
}

/** Extracts an RGBA image of `rect` from `source`, scaled by `scale`. */
export function rasterize(source: CanvasImageSource, rect: Rect, outW: number, outH: number): RGBAImage {
  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, outW, outH);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, rect.x, rect.y, rect.w, rect.h, 0, 0, outW, outH);
  const img = ctx.getImageData(0, 0, outW, outH);
  return { data: img.data, width: outW, height: outH };
}

type Pending = { resolve: (m: WorkerResponse) => void; reject: (e: Error) => void };

class LocalEngine {
  private worker: Worker | null = null;
  private ready: Promise<string> | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private progress: Progress | null = null;

  init(onProgress?: Progress): Promise<string> {
    if (onProgress) this.progress = onProgress;
    if (this.ready) return this.ready;
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.ready = new Promise((resolve, reject) => {
      this.worker!.onmessage = (ev: MessageEvent<WorkerResponse>) => {
        const m = ev.data;
        if (m.type === 'progress') this.progress?.(m);
        else if (m.type === 'ready') resolve(m.backend);
        else if (m.type === 'error' && m.id === undefined) { this.ready = null; reject(new Error(m.message)); }
        else if (m.type === 'error') { this.pending.get(m.id!)?.reject(new Error(m.message)); this.pending.delete(m.id!); }
        else if ('id' in m) { this.pending.get(m.id)?.resolve(m); this.pending.delete(m.id); }
      };
      this.worker!.onerror = (e) => { this.ready = null; reject(new Error(e.message || 'OCR worker failed to start')); };
    });
    this.worker.postMessage({ type: 'init', base: BASE } satisfies WorkerRequest);
    return this.ready;
  }

  private async request<T extends WorkerResponse>(msg: WorkerRequest & { id: number }, transfer: Transferable[] = []): Promise<T> {
    await this.init();
    return new Promise<T>((resolve, reject) => {
      this.pending.set(msg.id, { resolve: resolve as (m: WorkerResponse) => void, reject });
      this.worker!.postMessage(msg, transfer);
    });
  }

  async run(det: RGBAImage, src: RGBAImage, opts: OcrOptions) {
    const m = await this.request<Extract<WorkerResponse, { type: 'result' }>>({ type: 'run', id: this.nextId++, det, src, opts }, [det.data.buffer, src.data.buffer]);
    return { lines: m.lines, ms: m.ms };
  }

  async setImage(imageId: number, src: RGBAImage) {
    await this.request({ type: 'image', id: this.nextId++, imageId, src }, [src.data.buffer]);
  }

  async detect(imageId: number, det: RGBAImage, opts: OcrOptions): Promise<LineGeomMsg[]> {
    const m = await this.request<Extract<WorkerResponse, { type: 'detected' }>>({ type: 'detect', id: this.nextId++, imageId, det, opts }, [det.data.buffer]);
    return m.geoms;
  }

  /**
   * Counter-clockwise rotation (0/90/180/270) that makes the page upright. Classifies square crops
   * around the given text lines (photos often have pictures, margins or desks around the text),
   * or three crops along the page when no lines are given.
   */
  async orientation(canvas: CanvasImageSource & { width: number; height: number }, around: Point[][] = []): Promise<{ rotate: number; scores: number[] }> {
    const W = canvas.width, H = canvas.height;
    let rects: Rect[];
    if (around.length) {
      rects = around.map((q) => {
        const xs = q.map((p) => p.x), ys = q.map((p) => p.y);
        const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
        const len = Math.hypot(q[1].x - q[0].x, q[1].y - q[0].y), th = Math.hypot(q[3].x - q[0].x, q[3].y - q[0].y);
        const side = Math.min(Math.min(W, H), Math.max(len * 1.1, th * 5));
        return { x: Math.min(Math.max(0, cx - side / 2), W - side), y: Math.min(Math.max(0, cy - side / 2), H - side), w: side, h: side };
      });
    } else {
      // Model preprocessing: short side → 256, centre 224 crop. Three crops along the long side.
      const side = (Math.min(W, H) * 224) / 256;
      const long = W >= H;
      rects = [0.3, 0.5, 0.7].map((f) => {
        const cx = long ? W * f : W / 2, cy = long ? H / 2 : H * f;
        return { x: Math.min(Math.max(0, cx - side / 2), W - side), y: Math.min(Math.max(0, cy - side / 2), H - side), w: side, h: side };
      });
    }
    const crops = rects.map((r) => rasterize(canvas, r, 224, 224));
    const m = await this.request<Extract<WorkerResponse, { type: 'oriented' }>>({ type: 'orient', id: this.nextId++, crops }, crops.map((c) => c.data.buffer));
    return { rotate: m.rotate, scores: m.scores };
  }

  /** Candidates for one hand-drawn character (dark strokes on white). */
  async handwriting(src: RGBAImage): Promise<{ c: string; p: number }[]> {
    const m = await this.request<Extract<WorkerResponse, { type: 'written' }>>({ type: 'write', id: this.nextId++, src }, [src.data.buffer]);
    return m.chars;
  }

  async rec(imageId: number, geoms: LineGeomMsg[]): Promise<(OcrLine | null)[]> {
    const m = await this.request<Extract<WorkerResponse, { type: 'recognized' }>>({ type: 'rec', id: this.nextId++, imageId, geoms });
    return m.lines;
  }
}

export const localEngine = new LocalEngine();

export interface RecognizeOptions extends OcrOptions {
  detMaxSide: number;
  engine: 'local' | 'cloud';
  cloudApiKey?: string;
}

/**
 * Recognizes text in `rect` of `source` (defaults to the whole image).
 * Returned coordinates are in `source` pixel space.
 */
export async function recognize(source: HTMLCanvasElement | ImageBitmap, rect: Rect | null, opts: RecognizeOptions): Promise<{ lines: OcrLine[]; ms: number }> {
  const r = rect ?? { x: 0, y: 0, w: source.width, h: source.height };
  const t0 = performance.now();
  let lines: OcrLine[];
  if (opts.engine === 'cloud') {
    lines = await cloudRecognize(source, r, opts.cloudApiKey ?? '');
  } else {
    // Small selections are upscaled so that text is large enough for the detector.
    const maxSide = Math.max(r.w, r.h);
    const srcScale = Math.min(2, Math.max(1, 1000 / maxSide));
    const srcW = Math.round(r.w * srcScale), srcH = Math.round(r.h * srcScale);
    const detScale = Math.min(opts.detMaxSide / Math.max(srcW, srcH), 2);
    const src = rasterize(source, r, srcW, srcH);
    const det = rasterize(source, r, roundTo32(srcW * detScale), roundTo32(srcH * detScale));
    const res = await localEngine.run(det, src, opts);
    lines = res.lines.map((l) => {
      const quad = l.quad.map((p) => ({ x: r.x + p.x / srcScale, y: r.y + p.y / srcScale })) as OcrLine['quad'];
      return { ...l, quad, box: quadBox(quad) };
    });
  }
  return { lines, ms: performance.now() - t0 };
}

// ---------------------------------------------------------------------------------------------
// Optional cloud engine (Google Cloud Vision). Covers far more rare/extension-plane kanji, at the
// cost of sending the image to Google. Requires the user's own API key.

interface Vertex { x?: number; y?: number }
interface VSymbol { text: string; confidence?: number; boundingBox?: { vertices: Vertex[] }; property?: { detectedBreak?: { type: string } } }

async function cloudRecognize(source: CanvasImageSource & { width: number; height: number }, r: Rect, key: string): Promise<OcrLine[]> {
  if (!key) throw new Error('Set a Google Cloud Vision API key in Settings to use the cloud engine.');
  const scale = Math.min(1, 2400 / Math.max(r.w, r.h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(r.w * scale);
  canvas.height = Math.round(r.h * scale);
  canvas.getContext('2d')!.drawImage(source, r.x, r.y, r.w, r.h, 0, 0, canvas.width, canvas.height);
  const b64 = canvas.toDataURL('image/jpeg', 0.92).split(',')[1];
  const res = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: [{ image: { content: b64 }, features: [{ type: 'DOCUMENT_TEXT_DETECTION' }], imageContext: { languageHints: ['ja'] } }],
    }),
  });
  const json = await res.json();
  if (!res.ok || json.responses?.[0]?.error) throw new Error(json.error?.message ?? json.responses?.[0]?.error?.message ?? `HTTP ${res.status}`);
  const pages = json.responses?.[0]?.fullTextAnnotation?.pages ?? [];
  const lines: OcrLine[] = [];
  let cur: VSymbol[] = [];
  const flush = () => {
    if (!cur.length) return;
    const pts: Point[] = cur.flatMap((s) => (s.boundingBox?.vertices ?? []).map((v) => ({ x: r.x + (v.x ?? 0) / scale, y: r.y + (v.y ?? 0) / scale })));
    const box = quadBox(pts.length ? pts : [{ x: r.x, y: r.y }]);
    const first = center(cur[0]), last = center(cur[cur.length - 1]);
    const vertical = cur.length > 1 ? Math.abs(last.y - first.y) > Math.abs(last.x - first.x) : box.h > box.w * 1.5;
    const quad: OcrLine['quad'] = vertical
      ? [{ x: box.x + box.w, y: box.y }, { x: box.x + box.w, y: box.y + box.h }, { x: box.x, y: box.y + box.h }, { x: box.x, y: box.y }]
      : [{ x: box.x, y: box.y }, { x: box.x + box.w, y: box.y }, { x: box.x + box.w, y: box.y + box.h }, { x: box.x, y: box.y + box.h }];
    const chars = cur.map((s) => ({ c: s.text.normalize('NFC'), p: s.confidence ?? 1 }));
    lines.push({ text: chars.map((c) => c.c).join(''), chars, vertical, quad, box, score: 1 });
    cur = [];
  };
  for (const page of pages)
    for (const block of page.blocks ?? [])
      for (const para of block.paragraphs ?? []) {
        for (const word of para.words ?? [])
          for (const sym of (word.symbols ?? []) as VSymbol[]) {
            cur.push(sym);
            const br = sym.property?.detectedBreak?.type;
            if (br === 'LINE_BREAK' || br === 'EOL_SURE_SPACE') flush();
            else if (br === 'SPACE' || br === 'SURE_SPACE') cur.push({ text: ' ', confidence: 1, boundingBox: sym.boundingBox });
          }
        flush();
      }
  return sortLines(lines);
}

function center(s: VSymbol): Point {
  const v = s.boundingBox?.vertices ?? [];
  const n = Math.max(v.length, 1);
  return { x: v.reduce((a, p) => a + (p.x ?? 0), 0) / n, y: v.reduce((a, p) => a + (p.y ?? 0), 0) / n };
}
