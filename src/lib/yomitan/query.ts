import { openDb, promisify } from '../db';
import type { DictionaryRecord, YKanji, YKanjiMeta, YTag, YTerm, YTermMeta } from './types';
import { listDictionaries } from './importer';
import { scopeDictionaryCss } from './render';

/** Looks up terms whose expression or reading equals any of `keys`, in enabled dictionaries. */
export async function lookupYTerms(keys: string[], enabled: Set<string>): Promise<Map<string, YTerm[]>> {
  const out = new Map<string, YTerm[]>();
  if (!enabled.size || !keys.length) return out;
  const db = await openDb();
  const tx = db.transaction('yterms');
  const store = tx.objectStore('yterms');
  const byExp = store.index('expression');
  const byReading = store.index('reading');
  await Promise.all(
    keys.map(async (k) => {
      const [a, b] = await Promise.all([promisify(byExp.getAll(k)), promisify(byReading.getAll(k))]);
      const seen = new Set<number>();
      const hits = ([...a, ...b] as YTerm[]).filter((t) => enabled.has(t.dict) && !seen.has(t.id!) && (seen.add(t.id!), true));
      if (hits.length) out.set(k, hits);
    }),
  );
  return out;
}

export async function lookupTermMeta(expressions: string[], enabled: Set<string>): Promise<Map<string, YTermMeta[]>> {
  const out = new Map<string, YTermMeta[]>();
  if (!enabled.size || !expressions.length) return out;
  const db = await openDb();
  const index = db.transaction('ytermMeta').objectStore('ytermMeta').index('expression');
  await Promise.all(
    [...new Set(expressions)].map(async (e) => {
      const hits = ((await promisify(index.getAll(e))) as YTermMeta[]).filter((m) => enabled.has(m.dict));
      if (hits.length) out.set(e, hits);
    }),
  );
  return out;
}

export async function lookupYKanji(c: string, enabled: Set<string>): Promise<{ kanji: YKanji[]; meta: YKanjiMeta[] }> {
  const db = await openDb();
  const tx = db.transaction(['ykanji', 'ykanjiMeta']);
  const [kanji, meta] = await Promise.all([
    promisify(tx.objectStore('ykanji').index('character').getAll(c)),
    promisify(tx.objectStore('ykanjiMeta').index('character').getAll(c)),
  ]);
  return {
    kanji: (kanji as YKanji[]).filter((k) => enabled.has(k.dict)),
    meta: (meta as YKanjiMeta[]).filter((k) => enabled.has(k.dict)),
  };
}

const tagCache = new Map<string, Map<string, YTag>>();
export async function dictionaryTags(dict: string): Promise<Map<string, YTag>> {
  let m = tagCache.get(dict);
  if (m) return m;
  const db = await openDb();
  const tags = (await promisify(db.transaction('ytags').objectStore('ytags').index('dict').getAll(dict))) as YTag[];
  m = new Map(tags.map((t) => [t.name, t]));
  tagCache.set(dict, m);
  return m;
}

const mediaUrls = new Map<string, Promise<string | null>>();
export function mediaUrl(dict: string, path: string): Promise<string | null> {
  const key = dict + '\u0000' + path;
  let p = mediaUrls.get(key);
  if (!p) {
    p = getMedia(dict, path).then((b) => (b ? URL.createObjectURL(b) : null));
    mediaUrls.set(key, p);
  }
  return p;
}

export async function getMedia(dict: string, path: string): Promise<Blob | null> {
  const db = await openDb();
  const rec = (await promisify(db.transaction('media').objectStore('media').get([dict, path]))) as { blob: Blob } | undefined;
  return rec?.blob ?? null;
}

/** Resolves <img data-media-*> placeholders inside `root` to blob URLs. */
export function resolveMediaImages(root: ParentNode) {
  root.querySelectorAll<HTMLImageElement>('img[data-media-path]:not([src])').forEach((img) => {
    mediaUrl(img.dataset.mediaDict ?? '', img.dataset.mediaPath ?? '').then((u) => { if (u) img.src = u; });
  });
}

// --- Dictionary registry / styles ------------------------------------------------------------

let dictCache: Promise<DictionaryRecord[]> | null = null;
export function cachedDictionaries(): Promise<DictionaryRecord[]> {
  dictCache ??= listDictionaries();
  return dictCache;
}
export function invalidateDictionaryCache() {
  dictCache = null;
  tagCache.clear();
  mediaUrls.clear();
  applyDictionaryStyles();
}

/** Injects (scoped) styles.css of all installed dictionaries into the page. */
export async function applyDictionaryStyles() {
  const dicts = await cachedDictionaries();
  let el = document.getElementById('dictionary-styles') as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement('style');
    el.id = 'dictionary-styles';
    document.head.appendChild(el);
  }
  el.textContent = dicts.filter((d) => d.styles).map((d) => scopeDictionaryCss(d.styles!, d.title)).join('\n');
}
