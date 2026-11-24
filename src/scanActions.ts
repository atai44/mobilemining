import { localEngine, recognize, type Rect } from './lib/ocr/client';
import { scan, settings, view, ocrState, showToast, textFromLines, type Scan } from './store';
import type { OcrLine } from './lib/ocr/types';

const MAX_SIDE = 3000;

export function ensureOcrEngine(): Promise<void> {
  if (settings.value.ocr.engine === 'cloud') return Promise.resolve();
  if (ocrState.value.state === 'ready') return Promise.resolve();
  ocrState.value = { state: 'loading', loaded: 0, total: 0 };
  const files = new Map<string, { loaded: number; total: number }>();
  return localEngine
    .init((p) => {
      files.set(p.file, p);
      let loaded = 0, total = 0;
      for (const f of files.values()) { loaded += f.loaded; total += f.total; }
      ocrState.value = { state: 'loading', loaded, total };
    })
    .then((backend) => { ocrState.value = { state: 'ready', message: backend }; })
    .catch((e) => {
      ocrState.value = { state: 'error', message: String(e?.message ?? e) };
      throw e;
    });
}

async function toCanvas(blob: Blob): Promise<HTMLCanvasElement> {
  let bmp: ImageBitmap | HTMLImageElement;
  try {
    bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    // Older Safari: decode through an <img>
    bmp = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Could not decode this image.'));
      img.src = URL.createObjectURL(blob);
    });
  }
  const w = 'naturalWidth' in bmp ? bmp.naturalWidth : bmp.width;
  const h = 'naturalHeight' in bmp ? bmp.naturalHeight : bmp.height;
  const s = Math.min(1, MAX_SIDE / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * s);
  canvas.height = Math.round(h * s);
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  if ('close' in bmp) bmp.close();
  return canvas;
}

function canvasUrl(canvas: HTMLCanvasElement): Promise<string> {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(URL.createObjectURL(b!)), 'image/jpeg', 0.9));
}

function setScan(patch: Partial<Scan>) {
  if (scan.value) scan.value = { ...scan.value, ...patch };
}

export async function openImage(blob: Blob, source = '') {
  const canvas = await toCanvas(blob);
  const url = await canvasUrl(canvas);
  if (scan.value?.url) URL.revokeObjectURL(scan.value.url);
  scan.value = { canvas, url, lines: [], text: [], meta: [], lineOf: [], busy: false, error: null, source };
  view.value = 'scan';
  await runOcr(null);
}

export function openText(text: string, source = '') {
  if (scan.value?.url) URL.revokeObjectURL(scan.value.url);
  const cps = Array.from(text.normalize('NFC'));
  scan.value = { canvas: null, url: null, lines: [], text: cps, meta: cps.map(() => null), lineOf: cps.map(() => -1), busy: false, error: null, source };
  view.value = 'scan';
}

export async function runOcr(rect: Rect | null) {
  const s = scan.value;
  if (!s?.canvas || s.busy) return;
  setScan({ busy: true, error: null });
  try {
    await ensureOcrEngine();
    const o = settings.value.ocr;
    const { lines, ms } = await recognize(s.canvas, rect, { ...o, engine: o.engine, cloudApiKey: o.cloudApiKey });
    setScan({ lines, ...textFromLines(lines), busy: false, timing: ms });
    if (!lines.length) showToast('No text found. Try selecting the text area or retaking the photo closer.', 'info');
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    setScan({ busy: false, error: msg });
    showToast(msg, 'error');
  }
}

export async function rotateScan() {
  const s = scan.value;
  if (!s?.canvas) return;
  const c = document.createElement('canvas');
  c.width = s.canvas.height;
  c.height = s.canvas.width;
  const ctx = c.getContext('2d')!;
  ctx.translate(c.width, 0);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(s.canvas, 0, 0);
  if (s.url) URL.revokeObjectURL(s.url);
  scan.value = { ...s, canvas: c, url: await canvasUrl(c), lines: [], text: [], meta: [], lineOf: [] };
  await runOcr(null);
}

/** JPEG of the full page (downscaled) or of one recognized line, for the Anki card. */
export function cropImage(canvas: HTMLCanvasElement, line: OcrLine | null, maxSide = 1280): Promise<Blob | null> {
  let x = 0, y = 0, w = canvas.width, h = canvas.height;
  if (line) {
    const pad = Math.max(line.box.w, line.box.h) * 0.05 + Math.min(line.box.w, line.box.h) * 0.5;
    x = Math.max(0, line.box.x - pad);
    y = Math.max(0, line.box.y - pad);
    w = Math.min(canvas.width - x, line.box.w + pad * 2);
    h = Math.min(canvas.height - y, line.box.h + pad * 2);
  }
  const s = Math.min(1, maxSide / Math.max(w, h));
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(w * s));
  out.height = Math.max(1, Math.round(h * s));
  const ctx = out.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, x, y, w, h, 0, 0, out.width, out.height);
  return new Promise((resolve) => out.toBlob((b) => resolve(b), 'image/jpeg', 0.85));
}
