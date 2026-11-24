// IndexedDB storage: dictionary terms, kanji, mined notes, and misc metadata.
import { gunzip } from 'fflate';
import { normalizeText, toHiragana } from './kana';

export interface KEle { t: string; i?: string[]; p?: number; c?: 1 }
export interface REle { t: string; n?: 1; r?: string[]; i?: string[]; p?: number; c?: 1 }
export interface Sense { p: string[]; g: string[]; m?: string[]; f?: string[]; d?: string[]; n?: string; sk?: string[]; sr?: string[]; x?: string[] }
export interface Entry { id: number; k: KEle[]; r: REle[]; s: Sense[]; keys?: string[] }
export interface Kanji { c: string; on: string[]; kun: string[]; m: string[]; na?: string[]; sc?: number; g?: number; f?: number; j?: number; rad?: number }

export interface MinedNote {
  id?: number;
  created: number;
  fields: Record<string, string>; // marker values (expression, reading, sentence, ...)
  image?: Blob;
  status: 'pending' | 'added' | 'error';
  error?: string;
  ankiNoteId?: number;
}

const DB_NAME = 'mobilemining';
const DB_VERSION = 1;
let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const terms = db.createObjectStore('terms', { keyPath: 'id' });
      terms.createIndex('keys', 'keys', { multiEntry: true });
      db.createObjectStore('kanji', { keyPath: 'c' });
      db.createObjectStore('meta');
      db.createObjectStore('notes', { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Database is open in another tab; close it and reload.'));
  });
  return dbPromise;
}

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Transaction aborted'));
  });
}

export async function getMeta<T>(key: string): Promise<T | undefined> {
  const db = await openDb();
  return promisify(db.transaction('meta').objectStore('meta').get(key)) as Promise<T | undefined>;
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').put(value, key);
  await txDone(tx);
}

// --- Dictionary install --------------------------------------------------------------------

export interface DictStatus { jmdict?: { version: string; count: number }; kanjidic?: { version: string; count: number } }

export async function dictStatus(): Promise<DictStatus> {
  return (await getMeta<DictStatus>('dicts')) ?? {};
}

export type InstallProgress = (stage: string, done: number, total: number) => void;

async function download(url: string, label: string, onProgress: InstallProgress): Promise<Uint8Array> {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok || !res.body) throw new Error(`Download failed: ${url} (HTTP ${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress(`Downloading ${label}`, loaded, total);
  }
  const buf = new Uint8Array(loaded);
  let o = 0;
  for (const c of chunks) { buf.set(c, o); o += c.length; }
  return buf;
}

async function readJsonGz<T>(buf: Uint8Array): Promise<T> {
  // Some servers transparently decode .gz; only gunzip when the gzip magic bytes are present.
  let bytes = buf;
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    bytes = await new Promise<Uint8Array>((resolve, reject) => gunzip(buf, (err, out) => (err ? reject(err) : resolve(out))));
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

export function entryKeys(e: Entry): string[] {
  const keys = new Set<string>();
  for (const k of e.k) keys.add(normalizeText(k.t));
  for (const r of e.r) {
    keys.add(r.t);
    keys.add(toHiragana(r.t));
  }
  return [...keys];
}

const yieldToUi = () => new Promise((r) => setTimeout(r, 0));

export async function installDictionaries(base: string, onProgress: InstallProgress): Promise<void> {
  const db = await openDb();
  const jmBuf = await download(base + 'dict/jmdict.json.gz', 'JMdict', onProgress);
  onProgress('Unpacking JMdict', 0, 0);
  const jm = await readJsonGz<{ version: string; entries: Entry[] }>(jmBuf);
  {
    const tx = db.transaction('terms', 'readwrite');
    tx.objectStore('terms').clear();
    await txDone(tx);
  }
  const BATCH = 4000;
  for (let i = 0; i < jm.entries.length; i += BATCH) {
    const tx = db.transaction('terms', 'readwrite');
    const store = tx.objectStore('terms');
    for (const e of jm.entries.slice(i, i + BATCH)) {
      e.keys = entryKeys(e);
      store.put(e);
    }
    await txDone(tx);
    onProgress('Importing JMdict', Math.min(i + BATCH, jm.entries.length), jm.entries.length);
    await yieldToUi();
  }

  const kdBuf = await download(base + 'dict/kanjidic.json.gz', 'KANJIDIC2', onProgress);
  const kd = await readJsonGz<{ version: string; kanji: Kanji[] }>(kdBuf);
  {
    const tx = db.transaction('kanji', 'readwrite');
    const store = tx.objectStore('kanji');
    store.clear();
    for (const k of kd.kanji) store.put(k);
    await txDone(tx);
  }
  onProgress('Importing KANJIDIC2', kd.kanji.length, kd.kanji.length);

  const tags = await (await fetch(base + 'dict/tags.json')).json();
  await setMeta('tags', tags);
  await setMeta('dicts', {
    jmdict: { version: jm.version, count: jm.entries.length },
    kanjidic: { version: kd.version, count: kd.kanji.length },
  } satisfies DictStatus);
}

// --- Lookup ----------------------------------------------------------------------------------

/** Looks up many keys in one transaction. */
export async function lookupKeys(keys: string[]): Promise<Map<string, Entry[]>> {
  const db = await openDb();
  const tx = db.transaction('terms');
  const index = tx.objectStore('terms').index('keys');
  const out = new Map<string, Entry[]>();
  await Promise.all(
    keys.map(async (k) => {
      const res = (await promisify(index.getAll(k))) as Entry[];
      if (res.length) out.set(k, res);
    }),
  );
  return out;
}

export async function getKanji(c: string): Promise<Kanji | undefined> {
  const db = await openDb();
  return promisify(db.transaction('kanji').objectStore('kanji').get(c)) as Promise<Kanji | undefined>;
}

let tagCache: Record<string, string> | null = null;
export async function tagDescriptions(): Promise<Record<string, string>> {
  tagCache ??= (await getMeta<Record<string, string>>('tags')) ?? {};
  return tagCache;
}

// --- Mined notes -----------------------------------------------------------------------------

export async function saveNote(note: MinedNote): Promise<number> {
  const db = await openDb();
  const tx = db.transaction('notes', 'readwrite');
  const id = await promisify(tx.objectStore('notes').put(note));
  await txDone(tx);
  return id as number;
}

export async function listNotes(): Promise<MinedNote[]> {
  const db = await openDb();
  const all = (await promisify(db.transaction('notes').objectStore('notes').getAll())) as MinedNote[];
  return all.sort((a, b) => b.created - a.created);
}

export async function deleteNote(id: number): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('notes', 'readwrite');
  tx.objectStore('notes').delete(id);
  await txDone(tx);
}
