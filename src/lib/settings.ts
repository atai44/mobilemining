import type { Orientation } from './ocr/types';

export type AnkiMethod = 'ankiconnect' | 'ankimobile' | 'local';
export type ImageMode = 'page' | 'line' | 'none';
export type FuriganaMode = 'ruby' | 'remove' | 'keep';
export type DuplicateBehavior = 'prevent' | 'new' | 'overwrite';

export const BUILTIN_JMDICT = 'JMdict (built-in)';
export const BUILTIN_KANJIDIC = 'KANJIDIC2 (built-in)';

export interface DictionarySetting {
  name: string;
  enabled: boolean;
}

export interface Settings {
  ocr: {
    engine: 'local' | 'cloud';
    orientation: Orientation;
    detMaxSide: number;
    boxThresh: number;
    unclipRatio: number;
    cloudApiKey: string;
    /** Detect sideways / upside-down photos and turn them upright. */
    autoRotate: boolean;
  };
  display: {
    fontSize: number;
    vertical: boolean;
    highlightLowConfidence: boolean;
    hardLineBreaks: boolean;
    /** What to do with furigana detected in photos: show as ruby, drop, or keep as separate lines. */
    furigana: FuriganaMode;
  };
  /** Dictionaries in priority order (built-in and imported). */
  dictionaries: DictionarySetting[];
  anki: {
    method: AnkiMethod;
    url: string;
    key: string;
    deck: string;
    model: string;
    fields: Record<string, string>;
    tags: string;
    /** Yomitan semantics: prevent adding, add a new note anyway, or overwrite the existing note's fields. */
    duplicateBehavior: DuplicateBehavior;
    duplicateScope: 'collection' | 'deck' | 'deck-root';
    checkForDuplicates: boolean;
    /** Add with one tap from the popup (✎ opens the editor). Off: always open the editor. */
    quickAdd: boolean;
    /** How "view note" opens it in Anki: card browser or note editor. */
    noteGuiMode: 'browse' | 'edit';
    image: ImageMode;
    audio: boolean;
    mobile: { profile: string; deck: string; model: string; fields: Record<string, string> };
    /** Note type for the TSV export (empty fields: a fixed set of columns). */
    export: { deck: string; model: string; fields: Record<string, string> };
  };
}

export const DEFAULT_SETTINGS: Settings = {
  ocr: { engine: 'local', orientation: 'auto', detMaxSide: 1536, boxThresh: 0.5, unclipRatio: 1.5, cloudApiKey: '', autoRotate: true },
  display: { fontSize: 22, vertical: false, highlightLowConfidence: true, hardLineBreaks: false, furigana: 'ruby' },
  dictionaries: [
    { name: BUILTIN_JMDICT, enabled: true },
    { name: BUILTIN_KANJIDIC, enabled: true },
  ],
  anki: {
    method: 'local',
    url: 'http://127.0.0.1:8765',
    key: '',
    deck: '',
    model: '',
    fields: {},
    tags: 'mobilemining',
    duplicateBehavior: 'new',
    duplicateScope: 'collection',
    checkForDuplicates: true,
    quickAdd: true,
    noteGuiMode: 'browse',
    image: 'page',
    audio: true,
    mobile: {
      profile: 'User 1',
      deck: 'Default',
      model: 'Basic',
      fields: { Front: '{cloze-prefix}<b>{cloze-body}</b>{cloze-suffix}', Back: '{furigana}<br>{glossary}' },
    },
    export: { deck: '', model: '', fields: {} },
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

/** Settings from a backup or older version, completed with current defaults. */
export function completeSettings(over: unknown): Settings {
  return merge(structuredClone(DEFAULT_SETTINGS), over);
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      // v1 -> v2: allowDuplicates became duplicateBehavior
      if (parsed?.anki && 'allowDuplicates' in parsed.anki) {
        parsed.anki.duplicateBehavior ??= parsed.anki.allowDuplicates ? 'new' : 'prevent';
        delete parsed.anki.allowDuplicates;
      }
      return merge(DEFAULT_SETTINGS, parsed);
    }
  } catch { /* ignore */ }
  return structuredClone(DEFAULT_SETTINGS);
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch { /* storage may be unavailable */ }
}

/** Merges installed dictionary titles into the ordered settings list (new ones go last, enabled). */
export function syncDictionaryList(list: DictionarySetting[], installed: string[]): DictionarySetting[] {
  const all = new Set([BUILTIN_JMDICT, BUILTIN_KANJIDIC, ...installed]);
  const out = list.filter((d) => all.has(d.name));
  for (const name of all) if (!out.some((d) => d.name === name)) out.push({ name, enabled: true });
  return out;
}
