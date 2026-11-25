// Backup / restore without accounts or servers: everything the user set up (settings, Anki
// setup, mined cards, imported dictionaries) goes into one .zip file they keep, and can be
// restored on any device or browser. Dictionaries are written back out as standard Yomitan
// dictionary zips, so they can even be imported into Yomitan.
import { unzip, zip, strToU8, type Zippable } from 'fflate';
import { openDb, promisify, saveNote, type MinedNote } from './db';
import { listDictionaries, importYomitanDictionary } from './yomitan/importer';
import type { DictionaryRecord, YKanji, YKanjiMeta, YTag, YTerm, YTermMeta } from './yomitan/types';
import type { Settings } from './settings';

export const BACKUP_FORMAT = 1;

export interface BackupManifest {
  app: 'mobilemining';
  format: number;
  created: string;
  settings: Settings;
  notes: (Omit<MinedNote, 'image'> & { image?: string })[];
  dictionaries: { title: string; file: string }[];
}

export type BackupProgress = (stage: string, done: number, total: number) => void;

async function allByDict<T>(store: string, dict: string): Promise<T[]> {
  const db = await openDb();
  return (await promisify(db.transaction(store).objectStore(store).index('dict').getAll(dict))) as T[];
}

const zipAsync = (files: Zippable, level: 0 | 6 = 6) =>
  new Promise<Uint8Array>((resolve, reject) => zip(files, { level }, (err, out) => (err ? reject(err) : resolve(out))));
const unzipAsync = (data: Uint8Array) =>
  new Promise<Record<string, Uint8Array>>((resolve, reject) => unzip(data, (err, out) => (err ? reject(err) : resolve(out))));

const json = (v: unknown) => strToU8(JSON.stringify(v));
const chunks = <T>(arr: T[], n: number) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

/** Rebuilds a Yomitan dictionary zip (format 3) from what's stored in IndexedDB. */
export async function exportDictionary(rec: DictionaryRecord): Promise<Uint8Array> {
  const dict = rec.title;
  const [terms, meta, kanji, kanjiMeta, tags, media] = await Promise.all([
    allByDict<YTerm>('yterms', dict),
    allByDict<YTermMeta>('ytermMeta', dict),
    allByDict<YKanji>('ykanji', dict),
    allByDict<YKanjiMeta>('ykanjiMeta', dict),
    allByDict<YTag>('ytags', dict),
    allByDict<{ path: string; blob: Blob }>('media', dict),
  ]);
  const { importDate: _d, counts: _c, kinds: _k, styles, ...index } = rec;
  const files: Zippable = { 'index.json': json({ ...index, format: 3 }) };
  chunks(terms, 10000).forEach((c, i) => {
    files[`term_bank_${i + 1}.json`] = json(c.map((t) => [t.expression, t.reading === t.expression ? '' : t.reading, t.definitionTags.join(' '), t.rules.join(' '), t.score, t.glossary, t.sequence ?? 0, t.termTags.join(' ')]));
  });
  chunks(meta, 20000).forEach((c, i) => { files[`term_meta_bank_${i + 1}.json`] = json(c.map((m) => [m.expression, m.mode, m.data])); });
  chunks(kanji, 10000).forEach((c, i) => { files[`kanji_bank_${i + 1}.json`] = json(c.map((k) => [k.character, k.onyomi.join(' '), k.kunyomi.join(' '), k.tags.join(' '), k.meanings, k.stats])); });
  chunks(kanjiMeta, 20000).forEach((c, i) => { files[`kanji_meta_bank_${i + 1}.json`] = json(c.map((m) => [m.character, m.mode, m.data])); });
  if (tags.length) files['tag_bank_1.json'] = json(tags.map((t) => [t.name, t.category, t.order, t.notes, t.score]));
  if (styles) files['styles.css'] = strToU8(styles);
  for (const m of media) files[m.path] = [new Uint8Array(await m.blob.arrayBuffer()), { level: 0 }];
  return zipAsync(files);
}

export async function createBackup(settings: Settings, includeDictionaries: boolean, onProgress: BackupProgress = () => {}): Promise<Blob> {
  const db = await openDb();
  const notes = (await promisify(db.transaction('notes').objectStore('notes').getAll())) as MinedNote[];
  const files: Zippable = {};
  const manifest: BackupManifest = { app: 'mobilemining', format: BACKUP_FORMAT, created: new Date().toISOString(), settings, notes: [], dictionaries: [] };
  for (const n of notes) {
    const { image, ...rest } = n;
    const entry: BackupManifest['notes'][number] = { ...rest };
    if (image) {
      entry.image = `notes/${n.id}.jpg`;
      files[entry.image] = [new Uint8Array(await image.arrayBuffer()), { level: 0 }];
    }
    manifest.notes.push(entry);
  }
  if (includeDictionaries) {
    const dicts = await listDictionaries();
    for (const [i, d] of dicts.entries()) {
      onProgress(`Packing ${d.title}`, i, dicts.length);
      const file = `dictionaries/${i + 1}.zip`;
      files[file] = [await exportDictionary(d), { level: 0 }];
      manifest.dictionaries.push({ title: d.title, file });
    }
  }
  files['backup.json'] = json(manifest);
  onProgress('Writing backup', 1, 1);
  return new Blob([(await zipAsync(files)) as BlobPart], { type: 'application/zip' });
}

export interface RestoreResult { settings: Settings | null; notes: number; dictionaries: string[]; errors: string[] }

/** Restores a backup: returns the settings to apply (the caller applies them) and imports the rest. */
export async function restoreBackup(file: Blob, onProgress: BackupProgress = () => {}): Promise<RestoreResult> {
  onProgress('Reading backup', 0, 0);
  const files = await unzipAsync(new Uint8Array(await file.arrayBuffer()));
  const raw = files['backup.json'];
  if (!raw) throw new Error('This is not a MobileMining backup (backup.json is missing).');
  const manifest = JSON.parse(new TextDecoder().decode(raw)) as BackupManifest;
  if (manifest.app !== 'mobilemining') throw new Error('This is not a MobileMining backup.');
  const result: RestoreResult = { settings: manifest.settings ?? null, notes: 0, dictionaries: [], errors: [] };

  const db = await openDb();
  const existing = new Set(((await promisify(db.transaction('notes').objectStore('notes').getAll())) as MinedNote[]).map((n) => n.created));
  for (const n of manifest.notes ?? []) {
    if (existing.has(n.created)) continue; // already here (restoring twice)
    const { image, id: _id, ...rest } = n;
    const note: MinedNote = { ...rest };
    if (image && files[image]) note.image = new Blob([files[image] as BlobPart], { type: 'image/jpeg' });
    await saveNote(note);
    result.notes++;
  }
  const dicts = manifest.dictionaries ?? [];
  for (const [i, d] of dicts.entries()) {
    const data = files[d.file];
    if (!data) { result.errors.push(`${d.title}: missing from backup`); continue; }
    try {
      await importYomitanDictionary(new Blob([data as BlobPart]), (stage, done, total) => onProgress(`${stage} (${i + 1}/${dicts.length})`, done, total));
      result.dictionaries.push(d.title);
    } catch (e) {
      result.errors.push(`${d.title}: ${(e as Error).message ?? e}`);
    }
  }
  return result;
}

/** Whether the browser promised to keep this site's data, and how much is stored. */
export async function storageStatus(): Promise<{ persisted: boolean | null; usage: number | null }> {
  const persisted = navigator.storage?.persisted ? await navigator.storage.persisted().catch(() => null) : null;
  const est = navigator.storage?.estimate ? await navigator.storage.estimate().catch(() => null) : null;
  return { persisted, usage: est?.usage ?? null };
}
