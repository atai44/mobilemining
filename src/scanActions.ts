import { localEngine, recognize, type Rect } from './lib/ocr/client';
import { scan, settings, view, ocrState, showToast, textFromLines, type Scan } from './store';
import type { OcrLine, Orientation, Point } from './lib/ocr/types';
import { processFurigana } from './lib/ocr/ruby';
import { arrange, type LaidOutLine } from './lib/ocr/layout';
import { OcrSession, pointInQuad } from './lib/ocr/session';

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

// --- Page state: progressive OCR session + user edits ------------------------------------------

interface Page {
  session: OcrSession | null;
  /** Lines from area re-reads (and the cloud engine). */
  extra: OcrLine[];
  /** Session lines replaced by an area re-read. */
  replaced: Set<string>;
  /** Lines the user deleted in section editing. */
  deleted: Set<string>;
  /** User-edited sections (line keys in reading order), or null for automatic. */
  sections: string[][] | null;
  seq: number;
  /** The user edited the text by hand: stop overwriting it with OCR results. */
  edited: boolean;
  error: string | null;
  phase: NonNullable<Scan['progress']>['phase'];
}
const freshPage = (): Page => ({ session: null, extra: [], replaced: new Set(), deleted: new Set(), sections: null, seq: 0, edited: false, error: null, phase: 'models' });
let page: Page = freshPage();

let rebuildTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleRebuild() {
  if (rebuildTimer) return;
  rebuildTimer = setTimeout(() => { rebuildTimer = null; rebuild(); }, 120);
}

/** Recomputes the page (text, furigana, sections, pending lines) from OCR results and edits. */
export function rebuild() {
  const s = scan.value;
  if (!s?.canvas || page.edited) return;
  const sess = page.session;
  const fromSession = sess ? sess.lines.filter((l) => l.result && !page.replaced.has(l.key)).map((l) => l.result!) : [];
  const all = [...fromSession, ...page.extra].filter((l) => !page.deleted.has(l.key!));
  const lines = arrange(processFurigana(all, settings.value.display.furigana), page.sections);
  const pending = sess ? sess.lines.filter((l) => l.status !== 'done' && !page.replaced.has(l.key)).map((l) => ({ key: l.key, quad: l.geom.quad, busy: l.status === 'busy' })) : [];
  const total = sess?.lines.length ?? 0;
  const phase = page.error ? 'error' : page.phase === 'read' && sess?.finished ? 'done' : page.phase;
  (globalThis as { __mmLastOcr?: unknown }).__mmLastOcr = { raw: all, lines };
  setScan({
    lines, ...textFromLines(lines), pending,
    progress: { phase, done: sess?.done ?? 0, total },
    sectionsEdited: !!page.sections,
    error: page.error,
  });
  if (phase === 'done' && !lines.length && !s.busy) showToast('No text found. Try ⬚ Area around the text, or retake the photo closer.', 'info');
}

export async function openImage(blob: Blob, source = '') {
  const canvas = await toCanvas(blob);
  const url = await canvasUrl(canvas);
  if (scan.value?.url) URL.revokeObjectURL(scan.value.url);
  scan.value = { canvas, url, lines: [], text: [], meta: [], lineOf: [], ruby: [], geom: [], pending: [], progress: null, sectionsEdited: false, busy: false, error: null, source };
  view.value = 'scan';
  startAnalysis();
}

export function openText(text: string, source = '') {
  if (scan.value?.url) URL.revokeObjectURL(scan.value.url);
  page.session?.cancel();
  page = freshPage();
  const cps = Array.from(text.normalize('NFC'));
  scan.value = { canvas: null, url: null, lines: [], text: cps, meta: cps.map(() => null), lineOf: cps.map(() => -1), ruby: [], geom: cps.map(() => null), pending: [], progress: null, sectionsEdited: false, busy: false, error: null, source };
  view.value = 'scan';
}

/** Starts (or restarts) reading the whole photo in the background. Returns immediately. */
export function startAnalysis() {
  const s = scan.value;
  if (!s?.canvas) return;
  page.session?.cancel();
  page = freshPage();
  const canvas = s.canvas;
  const o = settings.value.ocr;
  setScan({ progress: { phase: 'models', done: 0, total: 0 }, error: null });
  if (o.engine === 'cloud') {
    page.phase = 'detect';
    rebuild();
    recognize(canvas, null, { ...o })
      .then((res) => {
        if (scan.value?.canvas !== canvas) return;
        page.extra = res.lines.map((l, i) => ({ ...l, key: `c${i}` }));
        page.phase = 'done';
        rebuild();
      })
      .catch((e) => { page.error = String(e?.message ?? e); rebuild(); showToast(page.error!, 'error'); });
    return;
  }
  ensureOcrEngine()
    .then(() => {
      if (scan.value?.canvas !== canvas) return;
      page.phase = 'detect';
      rebuild();
      const sess = new OcrSession(canvas, { ...o }, () => scheduleRebuild());
      page.session = sess;
      sess.ready.then(() => { if (page.session === sess) { page.phase = 'read'; rebuild(); } });
    })
    .catch((e) => { page.error = String(e?.message ?? e); rebuild(); showToast(page.error!, 'error'); });
}

/** Re-reads the whole photo (rect = null) or one area of it, optionally forcing the text direction. */
export async function runOcr(rect: Rect | null, orientation?: Orientation, replaceKeys?: string[]) {
  const s = scan.value;
  if (!s?.canvas) return;
  if (!rect) { startAnalysis(); return; }
  if (s.busy) return;
  setScan({ busy: true });
  try {
    await ensureOcrEngine();
    const o = settings.value.ocr;
    const res = await recognize(s.canvas, rect, { ...o, orientation: orientation ?? o.orientation });
    const tag = `a${++page.seq}_`;
    const found = res.lines.map((l, i) => ({ ...l, key: tag + i }));
    const inside = (q: Point[]) => {
      const cx = (q[0].x + q[2].x) / 2, cy = (q[0].y + q[2].y) / 2;
      return cx >= rect.x && cx <= rect.x + rect.w && cy >= rect.y && cy <= rect.y + rect.h;
    };
    // Replace what was there (read or still pending) with the new reading.
    const old = new Set(replaceKeys ?? []);
    for (const l of page.session?.lines ?? []) if (inside(l.geom.quad)) old.add(l.key);
    for (const l of page.extra) if (inside(l.quad)) old.add(l.key!);
    for (const k of old) page.replaced.add(k);
    page.session?.skip(old);
    page.extra = [...page.extra.filter((l) => !old.has(l.key!)), ...found];
    if (page.sections) {
      // Put the new lines where the old ones were (or in a new section at the end).
      const newKeys = found.map((l) => l.key);
      const at = page.sections.findIndex((g) => g.some((k) => old.has(k)));
      const secs = page.sections.map((g) => g.filter((k) => !old.has(k)));
      if (at >= 0) secs[at] = [...secs[at], ...newKeys];
      else secs.push(newKeys);
      page.sections = secs.filter((g) => g.length);
    }
    rebuild();
  } catch (e) {
    showToast(String((e as Error)?.message ?? e), 'error');
  } finally {
    setScan({ busy: false });
  }
}

/** Replaces one OCR'd character (keeps the old one as an alternative). */
export function correctChar(index: number, c: string) {
  const s = scan.value;
  if (!s) return;
  const m = s.meta[index];
  if (m && !page.edited && s.canvas) {
    m.alts = [{ c: m.c, p: m.p }, ...(m.alts ?? []).filter((a) => a.c !== c)];
    m.c = c;
    m.p = 1;
    rebuild();
  } else {
    const text = [...s.text];
    text[index] = c;
    scan.value = { ...s, text };
  }
}

/** The user typed their own text: keep it, and stop background reading. */
export function setEditedText(text: string) {
  const s = scan.value;
  if (!s) return;
  page.session?.cancel();
  page.edited = true;
  const cps = Array.from(text.normalize('NFC'));
  scan.value = { ...s, text: cps, meta: cps.map(() => null), lineOf: cps.map(() => -1), geom: cps.map(() => null), ruby: [], pending: [], progress: s.progress && { ...s.progress, phase: 'done' } };
}

/** Character under an image point (nearest within half a character), or -1. */
export function charAt(p: Point): number {
  const g = scan.value?.geom ?? [];
  let best = -1, bestD = Infinity;
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (!c) continue;
    const q = [{ x: c[0], y: c[1] }, { x: c[2], y: c[3] }, { x: c[4], y: c[5] }, { x: c[6], y: c[7] }];
    if (pointInQuad(p, q)) return i;
    const cx = (c[0] + c[4]) / 2, cy = (c[1] + c[5]) / 2;
    const size = Math.hypot(c[6] - c[0], c[7] - c[1]);
    const d = Math.hypot(cx - p.x, cy - p.y);
    if (d < size * 0.75 && d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/**
 * The user tapped an image point that hasn't been read yet: read that line (plus its furigana
 * and neighbours) before anything else, or read the area around the tap if no line was found.
 */
export async function focusAt(p: Point): Promise<number> {
  let i = charAt(p);
  if (i >= 0) return i;
  const s = scan.value;
  if (!s?.canvas) return -1;
  const sess = page.session;
  if (sess) {
    await sess.ready;
    const li = sess.lineAt(p);
    if (li >= 0 && !page.replaced.has(sess.lines[li].key)) {
      await sess.prioritize([li, ...sess.neighbours(li)]);
      rebuild();
      i = charAt(p);
      if (i >= 0 || sess.lines[li].result) return i;
    }
  }
  // Nothing detected here: read a window around the tap.
  const W = s.canvas.width, H = s.canvas.height;
  const r = Math.max(160, Math.min(W, H) * 0.2);
  const rect = { x: Math.max(0, p.x - r), y: Math.max(0, p.y - r), w: 0, h: 0 };
  rect.w = Math.min(W - rect.x, 2 * r);
  rect.h = Math.min(H - rect.y, 2 * r);
  await runOcr(rect);
  return charAt(p);
}

// --- Section editing ----------------------------------------------------------------------

/** Current sections as line keys, in reading order. */
export function currentSections(): string[][] {
  const out: string[][] = [];
  for (const l of (scan.value?.lines ?? []) as LaidOutLine[]) {
    (out[l.block] ??= []).push(l.key!);
  }
  return out.filter(Boolean);
}

function editSections(fn: (secs: string[][]) => string[][]) {
  page.sections = fn(page.sections ? page.sections.map((g) => [...g]) : currentSections()).filter((g) => g.length);
  rebuild();
}

export const moveSection = (i: number, d: -1 | 1) => editSections((secs) => {
  const j = i + d;
  if (j >= 0 && j < secs.length) [secs[i], secs[j]] = [secs[j], secs[i]];
  return secs;
});

export const mergeSections = (a: number, b: number) => editSections((secs) => {
  if (a === b) return secs;
  const [lo, hi] = a < b ? [a, b] : [b, a];
  secs[lo] = [...secs[lo], ...secs[hi]];
  secs.splice(hi, 1);
  return secs;
});

/** Splits section i so that `key` (and the lines after it in reading order) start a new section. */
export const splitSection = (i: number, key: string) => editSections((secs) => {
  const ordered = ((scan.value?.lines ?? []) as LaidOutLine[]).filter((l) => l.block === i).map((l) => l.key!);
  const at = ordered.indexOf(key);
  if (at <= 0) return secs;
  secs.splice(i, 1, ordered.slice(0, at), ordered.slice(at));
  return secs;
});

export const deleteSection = (i: number) => editSections((secs) => {
  for (const k of secs[i] ?? []) page.deleted.add(k);
  secs.splice(i, 1);
  return secs;
});

/** Re-reads a section with a forced text direction. */
export async function redirectSection(i: number, orientation: 'horizontal' | 'vertical') {
  const s = scan.value;
  if (!s?.canvas) return;
  const lines = (s.lines as LaidOutLine[]).filter((l) => l.block === i);
  if (!lines.length) return;
  if (!page.sections) page.sections = currentSections();
  const xs = lines.flatMap((l) => l.quad.map((p) => p.x)), ys = lines.flatMap((l) => l.quad.map((p) => p.y));
  const pad = 6;
  const rect = { x: Math.max(0, Math.min(...xs) - pad), y: Math.max(0, Math.min(...ys) - pad), w: 0, h: 0 };
  rect.w = Math.min(s.canvas.width - rect.x, Math.max(...xs) - rect.x + pad);
  rect.h = Math.min(s.canvas.height - rect.y, Math.max(...ys) - rect.y + pad);
  await runOcr(rect, orientation, lines.map((l) => l.key!));
}

export function resetSections() {
  page.sections = null;
  page.deleted.clear();
  rebuild();
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
  scan.value = { ...s, canvas: c, url: await canvasUrl(c), lines: [], text: [], meta: [], lineOf: [], ruby: [], geom: [], pending: [] };
  startAnalysis();
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
