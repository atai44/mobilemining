// Imports the useful parts of a Yomitan settings backup (Settings → Backup → Export Settings):
// AnkiConnect server/key, deck, note type, field markers, tags, duplicate handling, and
// dictionary order / enabled state.
import type { DictionarySetting, DuplicateBehavior, Settings } from '../settings';
import { MARKERS } from '../anki';

interface YomitanProfile { name?: string; options?: Record<string, unknown> }

export interface YomitanSettingsFile { profiles: YomitanProfile[]; profileCurrent: number }

export function parseYomitanSettings(json: unknown): YomitanSettingsFile {
  const root = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  const opts = (Array.isArray(root.profiles) ? root : (root.options as Record<string, unknown>)) ?? {};
  const profiles = (opts.profiles as YomitanProfile[]) ?? [];
  if (!Array.isArray(profiles) || !profiles.length || !profiles[0]?.options) {
    throw new Error('This does not look like a Yomitan settings export (no profiles found).');
  }
  return { profiles, profileCurrent: Math.min(Number(opts.profileCurrent) || 0, profiles.length - 1) };
}

export interface ImportSummary {
  notes: string[];
  warnings: string[];
}

const KNOWN = new Set([...MARKERS.map((m) => m.name), 'screenshot', 'clipboard-image', 'source', 'furigana-html', 'frequency-harmonic-occurrence', 'frequency-average-occurrence', 'dictionary-alias', 'url', 'clipboard-text', 'selection-text', 'popup-selection-text', 'phonetic-transcriptions']);

/** Applies a Yomitan profile to `s` (mutates) and returns what was imported. */
export function applyYomitanProfile(s: Settings, profile: YomitanProfile, installedDicts: string[]): ImportSummary {
  const notes: string[] = [];
  const warnings: string[] = [];
  const o = (profile.options ?? {}) as Record<string, any>;
  const anki = o.anki as Record<string, any> | undefined;
  if (anki) {
    if (typeof anki.server === 'string' && anki.server) s.anki.url = anki.server;
    if (typeof anki.apiKey === 'string') s.anki.key = anki.apiKey;
    if (Array.isArray(anki.tags)) s.anki.tags = anki.tags.join(' ');
    if (['prevent', 'new', 'overwrite'].includes(anki.duplicateBehavior)) s.anki.duplicateBehavior = anki.duplicateBehavior as DuplicateBehavior;
    if (['collection', 'deck', 'deck-root'].includes(anki.duplicateScope)) s.anki.duplicateScope = anki.duplicateScope;
    if (typeof anki.checkForDuplicates === 'boolean') s.anki.checkForDuplicates = anki.checkForDuplicates;
    if (anki.noteGuiMode === 'edit' || anki.noteGuiMode === 'browse') s.anki.noteGuiMode = anki.noteGuiMode;
    // Newer Yomitan: cardFormats[]; older: anki.terms
    const formats = Array.isArray(anki.cardFormats) ? anki.cardFormats : [];
    const term = formats.find((f: any) => f?.type === 'term' && f.model) ?? formats.find((f: any) => f?.type === 'term') ?? anki.terms;
    if (term && (term.deck || term.model)) {
      s.anki.method = 'ankiconnect';
      s.anki.deck = term.deck ?? '';
      s.anki.model = term.model ?? '';
      const fields: Record<string, string> = {};
      for (const [name, v] of Object.entries(term.fields ?? {})) {
        fields[name] = typeof v === 'string' ? v : typeof (v as any)?.value === 'string' ? (v as any).value : '';
      }
      s.anki.fields = fields;
      notes.push(`Anki: deck “${s.anki.deck}”, note type “${s.anki.model}”, ${Object.keys(fields).length} fields`);
      const unknown = new Set<string>();
      for (const t of Object.values(fields)) for (const m of t.matchAll(/\{([a-z0-9][a-z0-9._\-[\]]*)\}/gi)) {
        const name = m[1];
        if (!KNOWN.has(name) && !name.startsWith('single-glossary-') && !name.startsWith('single-frequency-number-')) unknown.add(name);
      }
      if (unknown.size) warnings.push(`These markers aren't supported yet and will be left empty: ${[...unknown].map((u) => `{${u}}`).join(', ')}`);
    }
    if (typeof anki.fieldTemplates === 'string' && anki.fieldTemplates.trim()) {
      warnings.push('Your custom Handlebars field templates were not imported; the standard marker definitions are used.');
    }
    if (formats.filter((f: any) => f?.type === 'term').length > 1) notes.push('Only the first term card format was imported.');
  }

  // Dictionaries: array in priority order (current) or {name: {priority, enabled}} (older versions)
  let ydicts: DictionarySetting[] = [];
  if (Array.isArray(o.dictionaries)) {
    ydicts = o.dictionaries.filter((d: any) => typeof d?.name === 'string').map((d: any) => ({ name: d.name, enabled: d.enabled !== false }));
  } else if (o.dictionaries && typeof o.dictionaries === 'object') {
    ydicts = Object.entries(o.dictionaries as Record<string, any>)
      .sort((a, b) => (b[1]?.priority ?? 0) - (a[1]?.priority ?? 0))
      .map(([name, d]) => ({ name, enabled: d?.enabled !== false }));
  }
  if (ydicts.length) {
    const installed = new Set(installedDicts);
    const matched = ydicts.filter((d) => installed.has(d.name));
    const missing = ydicts.filter((d) => !installed.has(d.name)).map((d) => d.name);
    const rest = s.dictionaries.filter((d) => !matched.some((m) => m.name === d.name));
    s.dictionaries = [...matched, ...rest];
    if (matched.length) notes.push(`Dictionary order and on/off state for ${matched.length} installed dictionar${matched.length === 1 ? 'y' : 'ies'}`);
    if (missing.length) warnings.push(`Not installed here (import their .zip files to use them): ${missing.join(', ')}`);
  }
  if (!notes.length) warnings.push('Nothing to import from this profile.');
  return { notes, warnings };
}
