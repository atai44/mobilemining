import type { Orientation } from './ocr/types';

export type AnkiMethod = 'ankiconnect' | 'ankimobile' | 'local';
export type ImageMode = 'page' | 'line' | 'none';

export interface Settings {
  ocr: {
    engine: 'local' | 'cloud';
    orientation: Orientation;
    detMaxSide: number;
    boxThresh: number;
    unclipRatio: number;
    cloudApiKey: string;
  };
  display: {
    fontSize: number;
    vertical: boolean;
    highlightLowConfidence: boolean;
    hardLineBreaks: boolean;
  };
  anki: {
    method: AnkiMethod;
    url: string;
    key: string;
    deck: string;
    model: string;
    fields: Record<string, string>;
    tags: string;
    allowDuplicates: boolean;
    image: ImageMode;
    audio: boolean;
    mobile: { profile: string; deck: string; model: string; fields: Record<string, string> };
  };
}

export const DEFAULT_SETTINGS: Settings = {
  ocr: { engine: 'local', orientation: 'auto', detMaxSide: 1536, boxThresh: 0.5, unclipRatio: 1.5, cloudApiKey: '' },
  display: { fontSize: 22, vertical: false, highlightLowConfidence: true, hardLineBreaks: false },
  anki: {
    method: 'local',
    url: 'http://127.0.0.1:8765',
    key: '',
    deck: '',
    model: '',
    fields: {},
    tags: 'mobilemining',
    allowDuplicates: false,
    image: 'page',
    audio: true,
    mobile: {
      profile: 'User 1',
      deck: 'Default',
      model: 'Basic',
      fields: { Front: '{sentence}', Back: '{furigana-html}<br>{glossary}' },
    },
  },
};

const KEY = 'mobilemining.settings';

function merge<T>(base: T, over: unknown): T {
  if (!over || typeof over !== 'object' || Array.isArray(base) || typeof base !== 'object' || base === null) return (over ?? base) as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    const b = (base as Record<string, unknown>)[k];
    out[k] = b && typeof b === 'object' && !Array.isArray(b) && Object.keys(b).length ? merge(b, v) : v;
  }
  return out as T;
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return merge(DEFAULT_SETTINGS, JSON.parse(raw));
  } catch { /* ignore */ }
  return structuredClone(DEFAULT_SETTINGS);
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch { /* storage may be unavailable */ }
}
