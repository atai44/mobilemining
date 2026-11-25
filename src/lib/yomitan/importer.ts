// Imports Yomitan dictionary .zip files (index.json + term/kanji/meta/tag banks + media)
// into IndexedDB, the same way Yomitan does.
import { unzipSync } from 'fflate';
import { openDb, promisify, txDone } from '../db';
import type { DictionaryIndex, DictionaryRecord, GlossaryItem, YKanji, YKanjiMeta, YTag, YTerm, YTermMeta } from './types';

export type ImportProgress = (stage: string, done: number, total: number) => void;

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  avif: 'image/avif', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff', ico: 'image/x-icon',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac',
};

const BANK_RE = /^(term_bank|term_meta_bank|kanji_bank|kanji_meta_bank|tag_bank)_(\d+)\.json$/;
const yieldToUi = () => new Promise((r) => setTimeout(r, 0));
const splitTags = (s: unknown): string[] => (typeof s === 'string' ? s.split(' ').filter(Boolean) : []);

/** Lists entries of a zip without decompressing them. */
function zipEntries(zip: Uint8Array): string[] {
  const names: string[] = [];
  unzipSync(zip, { filter: (f) => { names.push(f.name); return false; } });
  return names;
}

function readEntry(zip: Uint8Array, name: string): Uint8Array {
  const out = unzipSync(zip, { filter: (f) => f.name === name });
  const data = out[name];
  if (!data) throw new Error(`Missing ${name} in archive`);
  return data;
}

const decoder = new TextDecoder();
function readJson<T>(zip: Uint8Array, name: string): T {
  let text = decoder.decode(readEntry(zip, name));
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return JSON.parse(text) as T;
}

export function convertTermRow(row: unknown[], dict: string, version: number): YTerm {
  const [expression, reading, defTags, rules, score] = row as [string, string, string | null, string, number];
  const glossary = (version >= 3 ? (row[5] as GlossaryItem[]) : (row.slice(5) as GlossaryItem[])) ?? [];
  const exp = String(expression).normalize('NFC');
  return {
    dict,
    expression: exp,
    reading: reading ? String(reading).normalize('NFC') : exp,
    definitionTags: splitTags(defTags),
    rules: splitTags(rules),
    score: Number(score) || 0,
    glossary,
    sequence: version >= 3 && typeof row[6] === 'number' ? (row[6] as number) : undefined,
    termTags: version >= 3 ? splitTags(row[7]) : [],
  };
}

export function convertKanjiRow(row: unknown[], dict: string, version: number): YKanji {
  const [character, onyomi, kunyomi, tags] = row as [string, string, string, string];
  return {
    dict,
    character,
    onyomi: splitTags(onyomi),
    kunyomi: splitTags(kunyomi),
    tags: splitTags(tags),
    meanings: version >= 3 ? ((row[4] as string[]) ?? []) : (row.slice(4) as string[]),
    stats: version >= 3 ? ((row[5] as Record<string, string>) ?? {}) : {},
  };
}

async function putAll(storeName: string, records: unknown[], onBatch?: (n: number) => void) {
  const db = await openDb();
  const BATCH = 5000;
  for (let i = 0; i < records.length; i += BATCH) {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    for (const r of records.slice(i, i + BATCH)) store.put(r);
    await txDone(tx);
    onBatch?.(Math.min(i + BATCH, records.length));
    await yieldToUi();
  }
}

export async function listDictionaries(): Promise<DictionaryRecord[]> {
  const db = await openDb();
  return (await promisify(db.transaction('dictionaries').objectStore('dictionaries').getAll())) as DictionaryRecord[];
}

export async function deleteDictionary(title: string, onProgress?: ImportProgress): Promise<void> {
  const db = await openDb();
  const stores = ['yterms', 'ytermMeta', 'ykanji', 'ykanjiMeta', 'ytags', 'media'];
  for (const [i, name] of stores.entries()) {
    onProgress?.(`Removing ${title}`, i, stores.length);
    // Delete in chunks so huge dictionaries don't create one giant transaction.
    for (;;) {
      const tx = db.transaction(name, 'readwrite');
      const index = tx.objectStore(name).index('dict');
      const keys = await promisify(index.getAllKeys(IDBKeyRange.only(title), 5000));
      for (const k of keys) tx.objectStore(name).delete(k);
      await txDone(tx);
      if (keys.length < 5000) break;
      await yieldToUi();
    }
  }
  const tx = db.transaction('dictionaries', 'readwrite');
  tx.objectStore('dictionaries').delete(title);
  await txDone(tx);
}

/** Imports one Yomitan dictionary archive. Replaces an installed dictionary with the same title. */
export async function importYomitanDictionary(file: Blob, onProgress: ImportProgress = () => {}): Promise<DictionaryRecord> {
  onProgress('Reading archive', 0, 0);
  const zip = new Uint8Array(await file.arrayBuffer());
  let names: string[];
  try {
    names = zipEntries(zip);
  } catch {
    throw new Error('Not a zip file. Yomitan dictionaries are .zip archives containing index.json.');
  }
  // Some archives wrap everything in a single top-level folder.
  const indexName = names.find((n) => n === 'index.json') ?? names.find((n) => /^[^/]+\/index\.json$/.test(n));
  if (!indexName) throw new Error('index.json not found: this does not look like a Yomitan dictionary.');
  const prefix = indexName.slice(0, -'index.json'.length);
  const index = readJson<DictionaryIndex>(zip, indexName);
  const version = Number(index.format ?? index.version ?? 0);
  if (!index.title || !index.revision || ![1, 2, 3].includes(version)) {
    throw new Error(`Unsupported dictionary (title "${index.title ?? '?'}", format ${version || '?'}).`);
  }
  const dict = index.title;

  const existing = await listDictionaries();
  if (existing.some((d) => d.title === dict)) await deleteDictionary(dict, onProgress);

  const banks = names
    .filter((n) => n.startsWith(prefix))
    .map((n) => ({ name: n, m: BANK_RE.exec(n.slice(prefix.length)) }))
    .filter((b): b is { name: string; m: RegExpExecArray } => !!b.m)
    .sort((a, b) => a.m[1].localeCompare(b.m[1]) || Number(a.m[2]) - Number(b.m[2]));

  const counts = { terms: 0, termMeta: 0, kanji: 0, kanjiMeta: 0, tags: 0, media: 0 };
  const kinds = new Set<string>();

  // Tags from index.json (format 1)
  if (index.tagMeta) {
    const tags: YTag[] = Object.entries(index.tagMeta).map(([name, t]) => ({ dict, name, category: t.category ?? '', order: t.order ?? 0, notes: t.notes ?? '', score: t.score ?? 0 }));
    await putAll('ytags', tags);
    counts.tags += tags.length;
  }

  for (const [bi, bank] of banks.entries()) {
    const kind = bank.m[1];
    const label = `Importing ${dict} (${bi + 1}/${banks.length})`;
    onProgress(label, bi, banks.length);
    const rows = readJson<unknown[][]>(zip, bank.name);
    if (!Array.isArray(rows)) continue;
    if (kind === 'term_bank') {
      await putAll('yterms', rows.map((r) => convertTermRow(r, dict, version)));
      counts.terms += rows.length;
      kinds.add('terms');
    } else if (kind === 'term_meta_bank') {
      const recs: YTermMeta[] = rows.map(([expression, mode, data]) => ({ dict, expression: String(expression).normalize('NFC'), mode: mode as YTermMeta['mode'], data }));
      await putAll('ytermMeta', recs);
      counts.termMeta += recs.length;
      for (const r of recs) kinds.add(r.mode);
    } else if (kind === 'kanji_bank') {
      await putAll('ykanji', rows.map((r) => convertKanjiRow(r, dict, version)));
      counts.kanji += rows.length;
      kinds.add('kanji');
    } else if (kind === 'kanji_meta_bank') {
      const recs: YKanjiMeta[] = rows.map(([character, mode, data]) => ({ dict, character: String(character), mode: mode as 'freq', data: data as YKanjiMeta['data'] }));
      await putAll('ykanjiMeta', recs);
      counts.kanjiMeta += recs.length;
      kinds.add('kanji-freq');
    } else if (kind === 'tag_bank') {
      const recs: YTag[] = rows.map(([name, category, order, notes, score]) => ({ dict, name: String(name), category: String(category ?? ''), order: Number(order) || 0, notes: String(notes ?? ''), score: Number(score) || 0 }));
      await putAll('ytags', recs);
      counts.tags += recs.length;
    }
    await yieldToUi();
  }

  // Media referenced by structured content (images), plus the optional dictionary stylesheet.
  let styles: string | undefined;
  const mediaNames = names.filter((n) => n.startsWith(prefix) && !n.endsWith('/') && !n.endsWith('.json') && n !== indexName);
  const media: { dict: string; path: string; blob: Blob }[] = [];
  for (const name of mediaNames) {
    const path = name.slice(prefix.length);
    if (path === 'styles.css') { styles = decoder.decode(readEntry(zip, name)); continue; }
    const ext = path.split('.').pop()?.toLowerCase() ?? '';
    if (!MIME[ext]) continue;
    media.push({ dict, path, blob: new Blob([readEntry(zip, name) as BlobPart], { type: MIME[ext] }) });
    if (media.length % 200 === 0) onProgress(`Importing media for ${dict}`, media.length, mediaNames.length);
  }
  if (media.length) await putAll('media', media);
  counts.media = media.length;

  const { tagMeta: _tm, ...rest } = index;
  const record: DictionaryRecord = { ...rest, title: dict, revision: String(index.revision), importDate: Date.now(), styles, counts, kinds: [...kinds] };
  const db = await openDb();
  const tx = db.transaction('dictionaries', 'readwrite');
  tx.objectStore('dictionaries').put(record);
  await txDone(tx);
  onProgress(`Imported ${dict}`, 1, 1);
  return record;
}
