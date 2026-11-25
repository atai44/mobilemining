import { localEngine, recognize, type Rect } from './lib/ocr/client';
import { scan, settings, view, ocrState, showToast, textFromLines, trimLine, type Scan } from './store';
import type { OcrLine, Orientation, Point } from './lib/ocr/types';
import { processFurigana } from './lib/ocr/ruby';
import { arrange, type LaidOutLine } from './lib/ocr/layout';
import { OcrSession, pointInQuad } from './lib/ocr/session';
import { areaCorners, areaOverlap, areasIntersect, inArea, quadCentre, type Area } from './lib/areas';
export { areaCorners, areasIntersect, inArea, type Area };
import { lookupPrefix } from './lib/db';
import { openPdf, renderPage } from './lib/pdf';
import type { PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { checkFurigana, type FuriganaCheck } from './lib/rubyCheck';
import { dicts } from './store';

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

// --- User-drawn section boxes -----------------------------------------------------------------

/**
 * Applies user boxes to section groups: each box's lines leave their groups and form a section
 * where its first line was in the reading order. Newer boxes win.
 */
function applyAreas(groups: string[][], lines: OcrLine[], areas: Area[]): string[][] {
  let out = groups.map((g) => [...g]);
  const centre = new Map(lines.map((l) => [l.key!, quadCentre(l.quad)]));
  for (const a of areas) {
    const keys = [...centre.entries()].filter(([, c]) => inArea(a, c)).map(([k]) => k);
    if (!keys.length) continue;
    const set = new Set(keys);
    const at = out.findIndex((g) => g.some((k) => set.has(k)));
    out = out.map((g) => g.filter((k) => !set.has(k)));
    out.splice(at < 0 ? out.length : at, 0, keys);
    out = out.filter((g) => g.length);
  }
  return out;
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
  /** User-drawn section boxes (rotatable), applied on top of the other sections, newest last. */
  areas: Area[];
  /** Keys of the lines read from each box (their characters are cut out of every other line). */
  areaReads: Map<string, Set<string>>;
  seq: number;
  /** The user edited the text by hand: stop overwriting it with OCR results. */
  edited: boolean;
  error: string | null;
  phase: NonNullable<Scan['progress']>['phase'];
}
const freshPage = (): Page => ({ session: null, extra: [], replaced: new Set(), deleted: new Set(), sections: null, areas: [], areaReads: new Map(), seq: 0, edited: false, error: null, phase: 'models' });
let page: Page = freshPage();
/** Photos whose orientation was already checked (so manual rotation isn't undone). */
const checkedOrientation = new WeakSet<HTMLCanvasElement>();

/** Rotates a canvas counter-clockwise by 90/180/270°. */
function rotateCanvas(src: HTMLCanvasElement, ccw: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  const quarter = ((ccw / 90) % 4 + 4) % 4;
  c.width = quarter % 2 ? src.height : src.width;
  c.height = quarter % 2 ? src.width : src.height;
  const ctx = c.getContext('2d')!;
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate((-quarter * Math.PI) / 2);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  return c;
}

let rebuildTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleRebuild() {
  if (rebuildTimer) return;
  rebuildTimer = setTimeout(() => { rebuildTimer = null; rebuild(); }, 120);
}

// Furigana readings checked against the dictionary: "base|ocr" -> corrected reading (or null).
const rubyChecked = new Map<string, FuriganaCheck | null>();
const rubyAlts = new Map<string, string[][]>();
const rubyQueue = new Set<string>();
let rubyBusy = false;

async function checkRubyQueue() {
  if (rubyBusy || !dicts.value?.jmdict) return;
  rubyBusy = true;
  try {
    while (rubyQueue.size) {
      const key = rubyQueue.values().next().value as string;
      rubyQueue.delete(key);
      const [base, ocr] = key.split('|');
      try {
        rubyChecked.set(key, await checkFurigana(base, ocr, (p) => lookupPrefix(p), rubyAlts.get(key)));
      } catch {
        rubyChecked.set(key, null);
      }
    }
  } finally {
    rubyBusy = false;
  }
  scheduleRebuild();
}

/** Applies dictionary-checked readings to furigana, queueing unchecked ones. */
function checkRuby(lines: OcrLine[]): OcrLine[] {
  let queued = false;
  const out = lines.map((l) => {
    if (!l.ruby?.length) return l;
    return {
      ...l,
      ruby: l.ruby.flatMap((r) => {
        const base = l.chars.slice(r.from, r.to).map((c) => c.c).join('');
        const key = base + '|' + r.text;
        const res = rubyChecked.get(key);
        if (res === undefined) {
          rubyAlts.set(key, l.chars.slice(r.from, r.to).map((c) => (c.alts ?? []).filter((a) => a.p >= 0.01).map((a) => a.c)));
          rubyQueue.add(key);
          queued = true;
          return [r];
        }
        if (!res) return [r];
        if (res.fix) {
          // Persist the corrected kanji in the OCR result (old one kept as an alternative).
          const ch = l.chars[r.from + res.fix.i];
          if (ch && ch.c !== res.fix.c) {
            ch.alts = [{ c: ch.c, p: ch.p }, ...(ch.alts ?? []).filter((a) => a.c !== res.fix!.c)];
            ch.c = res.fix.c;
            ch.p = Math.max(ch.p, 0.9);
            ch.fixed = 'furigana';
          }
        }
        return res.parts.map((f) => ({ from: r.from + f.from, to: r.from + f.to, text: f.text }));
      }),
    };
  });
  if (queued) checkRubyQueue();
  return out;
}

/** Manual sections, with the pieces of lines cut by a section box in place of the line. */
function withPieces(sections: string[][] | null, lines: OcrLine[]): string[][] | null {
  if (!sections) return null;
  const pieces = new Map<string, string[]>();
  for (const l of lines) {
    const k = l.key!, cut = k.indexOf('~');
    if (cut > 0) pieces.set(k.slice(0, cut), [...(pieces.get(k.slice(0, cut)) ?? []), k]);
  }
  return sections.map((g) => g.flatMap((k) => [k, ...(pieces.get(k) ?? [])]));
}

/** Recomputes the page (text, furigana, sections, pending lines) from OCR results and edits. */
export function rebuild() {
  const s = scan.value;
  if (!s?.canvas || page.edited) return;
  const sess = page.session;
  const fromSession = sess ? sess.lines.filter((l) => l.result && !page.replaced.has(l.key)).map((l) => l.result!) : [];
  let all = [...fromSession, ...page.extra].filter((l) => !page.deleted.has(l.key!));
  // A box that has been read owns everything inside it: cut its characters out of other lines.
  for (const a of page.areas) {
    const own = page.areaReads.get(a.id);
    if (own) all = all.flatMap((l) => (own.has(l.key!) ? [l] : trimLine(l, (c) => !inArea(a, c))));
  }
  const processed = checkRuby(processFurigana(all, settings.value.display.furigana));
  let lines = arrange(processed, withPieces(page.sections, processed));
  const areaInfo: Scan['areas'] = [];
  if (page.areas.length) {
    const groups: string[][] = [];
    for (const l of lines as LaidOutLine[]) (groups[l.block] ??= []).push(l.key!);
    lines = arrange(processed, applyAreas(groups.filter(Boolean), processed, page.areas));
    for (const a of page.areas) {
      const mine = (lines as LaidOutLine[]).filter((l) => inArea(a, quadCentre(l.quad)));
      areaInfo.push({ ...a, section: mine.length ? (mine[0] as LaidOutLine).block : -1, count: mine.length, reading: areaJobs.has(a.id) });
    }
  }
  const pending = sess ? sess.lines.filter((l) => l.status !== 'done' && !page.replaced.has(l.key)).map((l) => ({ key: l.key, quad: l.geom.quad, busy: l.status === 'busy' })) : [];
  const total = sess?.lines.length ?? 0;
  const phase = page.error ? 'error' : page.phase === 'read' && sess?.finished ? 'done' : page.phase;
  (globalThis as { __mmLastOcr?: unknown }).__mmLastOcr = { raw: all, lines };
  setScan({
    lines, ...textFromLines(lines), pending,
    progress: { phase, done: sess?.done ?? 0, total },
    sectionsEdited: !!page.sections || page.areas.length > 0,
    areas: areaInfo,
    error: page.error,
  });
  if (phase === 'done' && !lines.length && !s.busy) showToast('No text found', 'info');
}

// --- PDFs ---------------------------------------------------------------------------------

const BASE = new URL(import.meta.env.BASE_URL, location.href).href;
let pdf: { doc: PDFDocumentProxy; name: string } | null = null;

export async function openPdfFile(file: Blob, name = 'PDF') {
  const doc = await openPdf(await file.arrayBuffer(), BASE);
  void pdf?.doc.cleanup();
  pdf = { doc, name };
  await showPdfPage(1);
}

/** Shows page n of the open PDF: its own text when it has some, otherwise OCR. */
export async function showPdfPage(n: number) {
  if (!pdf) return;
  const pages = pdf.doc.numPages;
  const num = Math.min(Math.max(1, n), pages);
  const { canvas, lines, textChars } = await renderPage(pdf.doc, num);
  const url = await canvasUrl(canvas);
  if (scan.value?.url) URL.revokeObjectURL(scan.value.url);
  page.session?.cancel();
  page = freshPage();
  checkedOrientation.add(canvas); // PDF pages come the right way up
  scan.value = {
    canvas, url, lines: [], text: [], meta: [], lineOf: [], ruby: [], geom: [], pending: [], progress: null, sectionsEdited: false,
    areas: [], busy: false, error: null, source: `${pdf.name} p.${num}`, doc: { page: num, pages },
  };
  view.value = 'scan';
  if (textChars >= 4) {
    page.extra = lines;
    page.phase = 'done';
    rebuild();
  } else {
    startAnalysis();
  }
}

export async function openImage(blob: Blob, source = '') {
  void pdf?.doc.cleanup();
  pdf = null;
  const canvas = await toCanvas(blob);
  const url = await canvasUrl(canvas);
  if (scan.value?.url) URL.revokeObjectURL(scan.value.url);
  scan.value = { canvas, url, lines: [], text: [], meta: [], lineOf: [], ruby: [], geom: [], pending: [], progress: null, sectionsEdited: false, areas: [], busy: false, error: null, source };
  view.value = 'scan';
  startAnalysis();
}

export function openText(text: string, source = '') {
  if (scan.value?.url) URL.revokeObjectURL(scan.value.url);
  page.session?.cancel();
  page = freshPage();
  const cps = Array.from(text.normalize('NFC'));
  scan.value = { canvas: null, url: null, lines: [], text: cps, meta: cps.map(() => null), lineOf: cps.map(() => -1), ruby: [], geom: cps.map(() => null), pending: [], progress: null, sectionsEdited: false, areas: [], busy: false, error: null, source };
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
    .then(async () => {
      if (scan.value?.canvas !== canvas) return;
      page.phase = 'detect';
      rebuild();
      // Photos often come out sideways or upside down: the session checks (once per photo) and
      // asks us to turn the page upright.
      const check = settings.value.ocr.autoRotate && !checkedOrientation.has(canvas);
      checkedOrientation.add(canvas);
      const rotatePage = async (rotate: number) => {
        if (scan.value?.canvas !== canvas) return null;
        const cv = rotateCanvas(canvas, rotate);
        checkedOrientation.add(cv);
        const old = scan.value.url;
        scan.value = { ...scan.value, canvas: cv, url: await canvasUrl(cv) };
        if (old) URL.revokeObjectURL(old);
        showToast(`Turned the photo ${rotate === 180 ? 'upside down' : rotate === 90 ? 'left' : 'right'} to make the text upright (⟳ to change)`, 'info');
        return cv;
      };
      const sess = new OcrSession(canvas, { ...o }, () => scheduleRebuild(), check ? rotatePage : undefined);
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
    m.fixed = 'user';
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
  // Nothing was detected here: leave it (⬚ Area reads a part of the photo on request).
  return -1;
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

/** Keys of read and not-yet-read lines whose centre lies inside `rect`. */
function keysInside(rect: Rect): string[] {
  const inside = (q: Point[]) => {
    const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4, cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;
    return cx >= rect.x && cx <= rect.x + rect.w && cy >= rect.y && cy <= rect.y + rect.h;
  };
  const keys = ((scan.value?.lines ?? []) as LaidOutLine[]).filter((l) => inside(l.quad)).map((l) => l.key!);
  for (const p of scan.value?.pending ?? []) if (inside(p.quad)) keys.push(p.key);
  return keys;
}

/**
 * Sets the box of section `i` (or creates a new section when i is null): the lines inside the box
 * belong to it; lines pushed out of it become their own section right after it.
 * Returns false when there is no text in the box (the caller can read the area instead).
 */
export function setSectionBox(i: number | null, rect: Rect): boolean {
  const inside = new Set(keysInside(rect));
  if (!inside.size) return false;
  editSections((secs) => {
    const out: string[][] = [];
    secs.forEach((g, gi) => {
      if (gi === i) {
        out.push([...inside]);
        const left = g.filter((k) => !inside.has(k));
        if (left.length) out.push(left);
      } else {
        out.push(g.filter((k) => !inside.has(k)));
      }
    });
    if (i === null) {
      // A user-drawn section goes where its text was in the reading order.
      const at = secs.findIndex((g) => g.some((k) => inside.has(k)));
      out.splice(at < 0 ? out.length : at, 0, [...inside]);
    }
    return out;
  });
  return true;
}

/** New section from a drawn box; reads the area when nothing was detected there. */
export async function newSectionFromBox(rect: Rect) {
  if (setSectionBox(null, rect)) return;
  if (!page.sections) page.sections = currentSections();
  await runOcr(rect);
}

/** Reads section i's box again (catches text the detector missed). */
export async function rereadSection(i: number, rect?: Rect) {
  const s = scan.value;
  if (!s?.canvas) return;
  const lines = (s.lines as LaidOutLine[]).filter((l) => l.block === i);
  if (!page.sections) page.sections = currentSections();
  const r = rect ?? sectionRect(lines, s.canvas.width, s.canvas.height);
  if (r) await runOcr(r, undefined, lines.map((l) => l.key!));
}

function sectionRect(lines: OcrLine[], W: number, H: number): Rect | null {
  if (!lines.length) return null;
  const xs = lines.flatMap((l) => l.quad.map((p) => p.x)), ys = lines.flatMap((l) => l.quad.map((p) => p.y));
  const pad = 6;
  const x = Math.max(0, Math.min(...xs) - pad), y = Math.max(0, Math.min(...ys) - pad);
  return { x, y, w: Math.min(W - x, Math.max(...xs) - x + pad), h: Math.min(H - y, Math.max(...ys) - y + pad) };
}

export function resetSections() {
  page.sections = null;
  for (const a of [...page.areas]) dropArea(a.id);
  page.deleted.clear();
  rebuild();
}

// --- Area (section box) actions --------------------------------------------------------------

/**
 * Creates a section box from a drawn rectangle; it replaces every older box it touches.
 * The box is read on its own right away (in the background; the box is usable meanwhile).
 */
export function createArea(rect: Rect): { area: Area; reading: Promise<void> } {
  const a: Area = { id: `u${++page.seq}`, cx: rect.x + rect.w / 2, cy: rect.y + rect.h / 2, w: rect.w, h: rect.h, angle: 0 };
  for (const o of page.areas) if (areasIntersect(o, a)) dropArea(o.id);
  page.areas.push(a);
  rebuild();
  return { area: a, reading: readArea(a.id) };
}

/** Moves / stretches / rotates a section box, and reads it again. */
export function updateArea(id: string, geom: Omit<Area, 'id'>) {
  page.areas = page.areas.map((a) => (a.id === id ? { ...geom, id } : a));
  // A box dragged over older boxes replaces them.
  const me = page.areas.find((a) => a.id === id);
  // Dragged mostly over another box: that one goes (a slight touch while stretching doesn't).
  if (me) for (const o of page.areas) if (o.id !== id && (areaOverlap(o, me) >= 0.3 || areaOverlap(me, o) >= 0.3)) dropArea(o.id);
  rebuild(); // show the new geometry now, even while an earlier read is still running
  void readArea(id);
}

export function deleteArea(id: string) {
  dropArea(id);
  rebuild();
}

/** Removes a box and the lines read from it (the text under it comes back). */
function dropArea(id: string) {
  page.areas = page.areas.filter((a) => a.id !== id);
  const r = page.areaReads.get(id);
  if (r) page.extra = page.extra.filter((l) => !r.has(l.key!));
  page.areaReads.delete(id);
}

const areaJobs = new Map<string, Promise<void>>();
const areaDirty = new Set<string>();

/**
 * Reads a section box on its own (its bounding rectangle, keeping only characters inside the
 * box). Called again while a read is running, it reads once more with the newest geometry.
 */
export function readArea(id: string): Promise<void> {
  const running = areaJobs.get(id);
  if (running) { areaDirty.add(id); return running; }
  const pg = page;
  const job = (async () => {
    await Promise.resolve(); // registered in areaJobs before the first rebuild
    try {
      do {
        areaDirty.delete(id);
        const a = pg.areas.find((x) => x.id === id);
        const s = scan.value;
        if (!a || !s?.canvas || page !== pg) return;
        rebuild(); // shows the box as being read
        // Read a little beyond the box so characters on its edge are seen whole; only those whose
        // centre is inside the box are kept.
        const pad = Math.min(60, Math.max(12, Math.min(a.w, a.h) * 0.3));
        const xs = areaCorners(a).map((p) => p.x), ys = areaCorners(a).map((p) => p.y);
        const x = Math.max(0, Math.floor(Math.min(...xs) - pad)), y = Math.max(0, Math.floor(Math.min(...ys) - pad));
        const rect = { x, y, w: Math.min(s.canvas.width, Math.ceil(Math.max(...xs) + pad)) - x, h: Math.min(s.canvas.height, Math.ceil(Math.max(...ys) + pad)) - y };
        if (rect.w < 4 || rect.h < 4) return;
        await ensureOcrEngine();
        const res = await recognize(s.canvas, rect, settings.value.ocr);
        const cur = pg.areas.find((x) => x.id === id);
        if (!cur || page !== pg) return;
        if (areaDirty.has(id)) continue; // moved meanwhile: read the new place
        const tag = `a${++pg.seq}_`;
        const found = res.lines.flatMap((l, i) => trimLine({ ...l, key: tag + i }, (c) => inArea(cur, c)));
        const prev = pg.areaReads.get(id);
        pg.extra = [...pg.extra.filter((l) => !prev?.has(l.key!)), ...found];
        pg.areaReads.set(id, new Set(found.map((l) => l.key!)));
      } while (areaDirty.has(id));
    } catch (e) {
      showToast(String((e as Error)?.message ?? e), 'error');
    } finally {
      areaJobs.delete(id);
      if (page === pg) rebuild();
    }
  })();
  areaJobs.set(id, job);
  return job;
}

/** Reads a section box again. */
export const rereadArea = readArea;

export async function rotateScan() {
  const s = scan.value;
  if (!s?.canvas) return;
  const c = rotateCanvas(s.canvas, 270); // 90° clockwise
  checkedOrientation.add(c);
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
