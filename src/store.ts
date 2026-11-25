import { signal, effect } from '@preact/signals';
import { loadSettings, saveSettings, type Settings } from './lib/settings';
import { dictStatus, type DictStatus } from './lib/db';
import type { OcrChar, OcrLine } from './lib/ocr/types';

export type View = 'capture' | 'scan' | 'notes' | 'settings';

export interface Scan {
  canvas: HTMLCanvasElement | null;
  url: string | null;
  lines: OcrLine[];
  /** Code points of the document text (lines joined with \n). */
  text: string[];
  /** OCR metadata for each code point (null for separators or edited text). */
  meta: (OcrChar | null)[];
  /** Index into `lines` for each code point (-1 when unknown). */
  lineOf: number[];
  /** Furigana read from the photo, as code-point ranges of `text`. */
  ruby: { start: number; end: number; text: string }[];
  /** Outline of each character on the photo (x0,y0,x1,y1,x2,y2,x3,y3), null for separators/edited text. */
  geom: (number[] | null)[];
  /** Detected lines not read yet (drawn as placeholders on the photo). */
  pending: { key: string; quad: { x: number; y: number }[]; busy: boolean }[];
  /** Background reading progress. */
  progress: { phase: 'models' | 'detect' | 'read' | 'done' | 'error'; done: number; total: number } | null;
  /** The user edited the sections (reading order / grouping). */
  sectionsEdited: boolean;
  /** User-drawn section boxes: geometry, section number they produce, and how many lines they hold. */
  /** Page of a PDF being read. */
  doc?: { page: number; pages: number };
  areas: { id: string; cx: number; cy: number; w: number; h: number; angle: number; section: number; count: number; reading: boolean }[];
  busy: boolean;
  error: string | null;
  timing?: number;
  source: string;
}

export const view = signal<View>('capture');
export const settings = signal<Settings>(loadSettings());
export const dicts = signal<DictStatus | null>(null);
export const scan = signal<Scan | null>(null);
/** A photo or PDF is being opened (decoded): shown on the Read tab until the page appears. */
export const opening = signal<string | null>(null);
/** Dictionary install / import progress. Kept here so it survives leaving the Settings tab. */
export const dictProgress = signal<{ stage: string; done: number; total: number } | null>(null);
export const dictErrors = signal<string[]>([]);
export const toast = signal<{ text: string; kind: 'ok' | 'error' | 'info' } | null>(null);
export const ocrState = signal<{ state: 'idle' | 'loading' | 'ready' | 'error'; loaded?: number; total?: number; message?: string }>({ state: 'idle' });

effect(() => saveSettings(settings.value));

// Theme and highlight colour, applied to the page.
effect(() => {
  if (typeof document === 'undefined') return;
  const d = settings.value.display;
  const root = document.documentElement;
  if (d.theme === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', d.theme);
  const m = /^#?([0-9a-f]{6})$/i.exec(d.highlight ?? '');
  const n = parseInt(m ? m[1] : 'facc15', 16);
  root.style.setProperty('--hl', `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, 0.45)`);
});

export function updateSettings(fn: (s: Settings) => void) {
  const next = structuredClone(settings.value);
  fn(next);
  settings.value = next;
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function showToast(text: string, kind: 'ok' | 'error' | 'info' = 'info') {
  toast.value = { text, kind };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.value = null), kind === 'error' ? 6000 : 2500);
}

export async function refreshDicts() {
  try {
    dicts.value = await dictStatus();
  } catch (e) {
    dicts.value = {};
    console.error(e);
  }
}

export function textFromLines(lines: (OcrLine & { sep?: string })[]): Pick<Scan, 'text' | 'meta' | 'lineOf' | 'ruby' | 'geom'> {
  const text: string[] = [];
  const meta: (OcrChar | null)[] = [];
  const lineOf: number[] = [];
  const geom: (number[] | null)[] = [];
  const ruby: Scan['ruby'] = [];
  lines.forEach((l, li) => {
    const sep = li === 0 ? '' : l.sep ?? '\n';
    for (const c of sep) { text.push(c); meta.push(null); lineOf.push(-1); geom.push(null); }
    const charStart: number[] = [];
    const cells = charCells(l);
    l.chars.forEach((c, ci) => {
      charStart.push(text.length);
      // A recognized "character" may be multiple code points only for unusual symbols; keep 1:1.
      for (const cp of Array.from(c.c)) { text.push(cp); meta.push(c); lineOf.push(li); geom.push(cells[ci]); }
    });
    charStart.push(text.length);
    for (const r of l.ruby ?? []) ruby.push({ start: charStart[r.from], end: charStart[r.to], text: r.text });
  });
  return { text, meta, lineOf, ruby, geom };
}

/** Outline of each character on the photo, from the line's quad and the characters' positions along it. */
export function charCells(l: OcrLine): number[][] {
  const P = linePoint(l);
  return charSpans(l).map(([a0, a1]) => [...P(a0, 0), ...P(a1, 0), ...P(a1, 1), ...P(a0, 1)]);
}

/** Point at (along, across) ∈ [0,1]² in a line's quad. */
export function linePoint(l: OcrLine) {
  const [q0, q1, , q3] = l.quad;
  return (a: number, b: number) => [q0.x + a * (q1.x - q0.x) + b * (q3.x - q0.x), q0.y + a * (q1.y - q0.y) + b * (q3.y - q0.y)];
}

/** Where each character starts and ends along its line (0..1). */
export function charSpans(l: OcrLine): [number, number][] {
  const n = l.chars.length;
  if (!n) return [];
  const us = l.chars.map((c, i) => c.u ?? (i + 0.5) / n);
  const [q0, q1, , q3] = l.quad;
  const len = Math.hypot(q1.x - q0.x, q1.y - q0.y) || 1;
  const thick = Math.hypot(q3.x - q0.x, q3.y - q0.y);
  // Half a character (≈ half the line thickness) on each side when there is no neighbour.
  const half = Math.min(0.5, (thick * 0.5) / len);
  return us.map((u, i) => [i > 0 ? (us[i - 1] + u) / 2 : Math.max(0, u - half), i < n - 1 ? (u + us[i + 1]) / 2 : Math.min(1, u + half)]);
}

/**
 * The parts of a line whose characters pass `keep` (tested at each character's centre), as
 * separate lines. Used to cut a section box's characters out of the lines it overlaps.
 */
export function trimLine(l: OcrLine, keep: (p: { x: number; y: number }) => boolean): OcrLine[] {
  const spans = charSpans(l);
  const P = linePoint(l);
  const flags = spans.map(([a0, a1]) => { const [x, y] = P((a0 + a1) / 2, 0.5); return keep({ x, y }); });
  if (flags.every(Boolean)) return [l];
  const out: OcrLine[] = [];
  for (let i = 0; i < flags.length; ) {
    if (!flags[i]) { i++; continue; }
    let j = i;
    while (j < flags.length && flags[j]) j++;
    const a0 = spans[i][0], a1 = spans[j - 1][1], span = Math.max(a1 - a0, 1e-6);
    const pt = (a: number, b: number) => { const [x, y] = P(a, b); return { x, y }; };
    const quad: OcrLine['quad'] = [pt(a0, 0), pt(a1, 0), pt(a1, 1), pt(a0, 1)];
    const xs = quad.map((q) => q.x), ys = quad.map((q) => q.y);
    const chars = l.chars.slice(i, j).map((c, k) => ({ ...c, u: ((c.u ?? (i + k + 0.5) / l.chars.length) - a0) / span }));
    out.push({
      ...l, key: `${l.key}~${out.length}`, chars, text: chars.map((c) => c.c).join(''), quad,
      box: { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) },
      mid: [pt(a0, 0.5), pt(a1, 0.5)], ruby: undefined,
    });
    i = j;
  }
  return out;
}

/** Stable position of a character: its line's key and offset, which survive background updates. */
export function locate(s: Pick<Scan, 'lineOf' | 'lines'>, index: number): { key: string; ci: number } | null {
  const li = s.lineOf[index];
  const key = li >= 0 ? s.lines[li]?.key : undefined;
  if (key === undefined) return null;
  let start = index;
  while (start > 0 && s.lineOf[start - 1] === li) start--;
  return { key, ci: index - start };
}

export function indexOf(s: Pick<Scan, 'lineOf' | 'lines'>, pos: { key: string; ci: number }): number {
  const li = s.lines.findIndex((l) => l.key === pos.key);
  if (li < 0) return -1;
  const start = s.lineOf.indexOf(li);
  return start < 0 || s.lineOf[start + pos.ci] !== li ? -1 : start + pos.ci;
}
