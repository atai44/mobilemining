// App-level dictionary wiring: which dictionaries are installed/enabled, in what order, and the
// lookup function the reader uses.
import { signal } from '@preact/signals';
import { lookupKeys } from './lib/db';
import { BUILTIN_DICT, findTerms, type TermResult } from './lib/lookup';
import { BUILTIN_JMDICT, syncDictionaryList } from './lib/settings';
import { applyDictionaryStyles, cachedDictionaries, invalidateDictionaryCache, lookupTermMeta, lookupYTerms } from './lib/yomitan/query';
import type { DictionaryRecord } from './lib/yomitan/types';
import { settings, updateSettings } from './store';

export const installedDictionaries = signal<DictionaryRecord[]>([]);

export async function refreshDictionaries() {
  invalidateDictionaryCache();
  const list = await cachedDictionaries();
  installedDictionaries.value = list;
  const synced = syncDictionaryList(settings.value.dictionaries, list.map((d) => d.title));
  if (JSON.stringify(synced) !== JSON.stringify(settings.value.dictionaries)) updateSettings((s) => (s.dictionaries = synced));
  await applyDictionaryStyles();
}

export function enabledDictionaries(): Set<string> {
  return new Set(settings.value.dictionaries.filter((d) => d.enabled).map((d) => d.name));
}

/** Occurrence-based frequency dictionaries (higher number = more common). */
export function occurrenceFreqDicts(): Set<string> {
  return new Set(installedDictionaries.value.filter((d) => d.frequencyMode === 'occurrence-based').map((d) => d.title));
}

export async function lookupAt(text: string[], index: number): Promise<TermResult[]> {
  const enabled = enabledDictionaries();
  const imported = new Set(installedDictionaries.value.map((d) => d.title).filter((t) => enabled.has(t)));
  const order = settings.value.dictionaries.map((d) => (d.name === BUILTIN_JMDICT ? BUILTIN_DICT : d.name));
  return findTerms(text, index, {
    builtin: enabled.has(BUILTIN_JMDICT) ? lookupKeys : null,
    yomitan: imported.size ? (keys) => lookupYTerms(keys, imported) : undefined,
    meta: imported.size ? (exprs) => lookupTermMeta(exprs, imported) : undefined,
    dictOrder: order,
    occurrenceFreqDicts: occurrenceFreqDicts(),
    crossLineBreaks: !settings.value.display.hardLineBreaks,
  });
}
