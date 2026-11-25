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
  busy: boolean;
  error: string | null;
  timing?: number;
  source: string;
}

export const view = signal<View>('capture');
export const settings = signal<Settings>(loadSettings());
export const dicts = signal<DictStatus | null>(null);
export const scan = signal<Scan | null>(null);
export const toast = signal<{ text: string; kind: 'ok' | 'error' | 'info' } | null>(null);
export const ocrState = signal<{ state: 'idle' | 'loading' | 'ready' | 'error'; loaded?: number; total?: number; message?: string }>({ state: 'idle' });

effect(() => saveSettings(settings.value));

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
  const n = l.chars.length;
  if (!n) return [];
  const us = l.chars.map((c, i) => c.u ?? (i + 0.5) / n);
  const [q0, q1, , q3] = l.quad;
  const P = (a: number, b: number) => [q0.x + a * (q1.x - q0.x) + b * (q3.x - q0.x), q0.y + a * (q1.y - q0.y) + b * (q3.y - q0.y)];
  const len = Math.hypot(q1.x - q0.x, q1.y - q0.y) || 1;
  const thick = Math.hypot(q3.x - q0.x, q3.y - q0.y);
  // Half a character (≈ half the line thickness) on each side when there is no neighbour.
  const half = Math.min(0.5, (thick * 0.5) / len);
  return us.map((u, i) => {
    const a0 = i > 0 ? (us[i - 1] + u) / 2 : Math.max(0, u - half);
    const a1 = i < n - 1 ? (u + us[i + 1]) / 2 : Math.min(1, u + half);
    return [...P(a0, 0), ...P(a1, 0), ...P(a1, 1), ...P(a0, 1)];
  });
}
