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

export function textFromLines(lines: OcrLine[]): Pick<Scan, 'text' | 'meta' | 'lineOf'> {
  const text: string[] = [];
  const meta: (OcrChar | null)[] = [];
  const lineOf: number[] = [];
  lines.forEach((l, li) => {
    if (li > 0) { text.push('\n'); meta.push(null); lineOf.push(-1); }
    for (const c of l.chars) {
      // A recognized "character" may be multiple code points only for unusual symbols; keep 1:1.
      for (const cp of Array.from(c.c)) { text.push(cp); meta.push(c); lineOf.push(li); }
    }
  });
  return { text, meta, lineOf };
}
