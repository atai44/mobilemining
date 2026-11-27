// The Android app (Capacitor): the same web app in a WebView, plus native pieces a browser can't
// have: AnkiDroid's API (adding notes directly), downloads without CORS, and saving files.
import { Capacitor, CapacitorHttp, registerPlugin } from '@capacitor/core';

export const isNative = (): boolean => Capacitor.isNativePlatform();

interface AnkiDroidPlugin {
  status(): Promise<{ installed: boolean; granted: boolean }>;
  requestAccess(): Promise<{ installed: boolean; granted: boolean }>;
  decks(): Promise<{ names: string[] }>;
  models(): Promise<{ names: string[] }>;
  fields(o: { model: string }): Promise<{ names: string[] }>;
  addDeck(o: { name: string }): Promise<{ id: string }>;
  addModel(o: { name: string; fields: string[]; cards: string[]; qfmt: string[]; afmt: string[]; css: string }): Promise<{ id: string }>;
  findDuplicates(o: { model: string; key: string }): Promise<{ ids: string[] }>;
  existing(o: { ids: string[] }): Promise<{ ids: string[] }>;
  addNote(o: { model: string; deck: string; fields: Record<string, string>; tags: string[] }): Promise<{ id: string }>;
  updateNote(o: { id: string; model: string; fields: Record<string, string> }): Promise<void>;
  addMedia(o: { name: string; ext: string; kind: 'image' | 'audio'; data: string }): Promise<{ tag: string; name: string }>;
  open(): Promise<void>;
}

export const AnkiDroid = registerPlugin<AnkiDroidPlugin>('AnkiDroid');

/** Size of JapanesePod101's "audio not available" clip. */
const MISSING_AUDIO_BYTES = 52288;

interface AudioRequest { url: string; filename: string; fields: string[] }

/**
 * The AnkiConnect calls the app uses, answered by AnkiDroid's API. Lets the Android app reuse
 * everything built for AnkiConnect: settings, field mapping, duplicates, images, audio.
 */
export class AnkiDroidClient {
  async version(): Promise<number> {
    const s = await AnkiDroid.status();
    if (!s.installed) throw new Error('AnkiDroid is not installed');
    if (!s.granted) throw new Error('Press Connect to allow access to AnkiDroid');
    return 1;
  }

  async requestPermission(): Promise<{ permission: 'granted' | 'denied' }> {
    const s = await AnkiDroid.requestAccess();
    return { permission: s.granted ? 'granted' : 'denied' };
  }

  async deckNames() { return (await AnkiDroid.decks()).names; }
  async modelNames() { return (await AnkiDroid.models()).names; }
  async modelFieldNames(modelName: string) { return (await AnkiDroid.fields({ model: modelName })).names; }
  async createDeck(deck: string) { return Number((await AnkiDroid.addDeck({ name: deck })).id); }

  async createModel(params: Record<string, unknown>): Promise<unknown> {
    const t = (params.cardTemplates as { Name: string; Front: string; Back: string }[]) ?? [];
    return AnkiDroid.addModel({
      name: String(params.modelName), fields: params.inOrderFields as string[], css: String(params.css ?? ''),
      cards: t.map((x) => x.Name), qfmt: t.map((x) => x.Front), afmt: t.map((x) => x.Back),
    });
  }

  /** Not available through AnkiDroid's API (see findDuplicateNotes). */
  async findNotes(_query: string): Promise<number[]> { return []; }

  async findDuplicateNotes(model: string, key: string): Promise<number[]> {
    return (await AnkiDroid.findDuplicates({ model, key })).ids.map(Number);
  }

  /** Which of these notes still exist in AnkiDroid. */
  async existingNotes(ids: number[]): Promise<number[]> {
    return ids.length ? (await AnkiDroid.existing({ ids: ids.map(String) })).ids.map(Number) : [];
  }

  /** Stores an image and returns the file name AnkiDroid gave it. */
  async storeMediaFile(filename: string, data: string): Promise<string> {
    const dot = filename.lastIndexOf('.');
    const r = await AnkiDroid.addMedia({ name: dot > 0 ? filename.slice(0, dot) : filename, ext: dot > 0 ? filename.slice(dot + 1) : 'jpg', kind: 'image', data });
    return r.name;
  }

  /** Downloads pronunciation audio (no CORS in the app) and returns its [sound:…] tag, or '' when there is none. */
  private async audioTag(a: AudioRequest): Promise<string> {
    try {
      const res = await CapacitorHttp.get({ url: a.url, responseType: 'blob' });
      const data = typeof res.data === 'string' ? res.data.replace(/\s/g, '') : '';
      if (res.status !== 200 || !data) return '';
      const bytes = Math.floor((data.length * 3) / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
      if (bytes === MISSING_AUDIO_BYTES || bytes < 500) return '';
      return (await AnkiDroid.addMedia({ name: a.filename.replace(/\.mp3$/, ''), ext: 'mp3', kind: 'audio', data })).tag;
    } catch (e) {
      console.warn('audio', e);
      return '';
    }
  }

  private async withAudio(fields: Record<string, string>, audio?: AudioRequest[]): Promise<Record<string, string>> {
    const out = { ...fields };
    for (const a of audio ?? []) {
      const tag = await this.audioTag(a);
      if (tag) for (const f of a.fields) out[f] = (out[f] ?? '') + tag;
    }
    return out;
  }

  async addNote(note: unknown): Promise<number> {
    const n = note as { deckName: string; modelName: string; fields: Record<string, string>; tags: string[]; audio?: AudioRequest[] };
    const r = await AnkiDroid.addNote({ model: n.modelName, deck: n.deckName, fields: await this.withAudio(n.fields, n.audio), tags: n.tags ?? [] });
    return Number(r.id);
  }

  async updateNoteFields(note: unknown): Promise<null> {
    const n = note as { id: number; fields: Record<string, string>; audio?: AudioRequest[]; modelName?: string };
    await AnkiDroid.updateNote({ id: String(n.id), model: n.modelName ?? '', fields: await this.withAudio(n.fields, n.audio) });
    return null;
  }

  async guiBrowse(_query: string): Promise<number[]> { await AnkiDroid.open(); return []; }
  async guiEditNote(_note: number): Promise<null> { await AnkiDroid.open(); return null; }
}

/** POSTs JSON with the app's native HTTP client (no CORS, plain http allowed). */
export async function nativePostJson(url: string, body: unknown): Promise<unknown> {
  const res = await CapacitorHttp.post({ url, headers: { 'Content-Type': 'application/json' }, data: body, connectTimeout: 8000, readTimeout: 60000 });
  if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
  return typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
}

// --- Files ---------------------------------------------------------------------------------

async function base64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * Hands a generated file to the user: a download in the browser; in the app (a WebView can't
 * download blobs) it is written to the cache and offered through Android's share sheet
 * (Save to Files, AnkiDroid for .apkg, …).
 */
export async function saveFile(blob: Blob, name: string): Promise<void> {
  if (!isNative()) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    return;
  }
  const [{ Filesystem, Directory }, { Share }] = await Promise.all([import('@capacitor/filesystem'), import('@capacitor/share')]);
  const CHUNK = 3 * 256 * 1024; // multiple of 3: base64 chunks concatenate cleanly
  const path = `export/${name}`;
  await Filesystem.writeFile({ path, directory: Directory.Cache, data: await base64(blob.slice(0, CHUNK)), recursive: true });
  for (let at = CHUNK; at < blob.size; at += CHUNK) {
    await Filesystem.appendFile({ path, directory: Directory.Cache, data: await base64(blob.slice(at, at + CHUNK)) });
  }
  const { uri } = await Filesystem.getUri({ path, directory: Directory.Cache });
  try {
    await Share.share({ title: name, files: [uri] });
  } catch (e) {
    if (!/cancel/i.test(String((e as Error)?.message ?? e))) throw e;
  }
}

/** Text on the clipboard ('' when empty or not allowed). Call from a tap: browsers require it. */
export async function readClipboardText(): Promise<string> {
  if (isNative()) {
    try {
      const { Clipboard } = await import('@capacitor/clipboard');
      const r = await Clipboard.read();
      if (r.value) return r.type.startsWith('text') ? r.value : '';
    } catch { /* fall back to the browser's clipboard */ }
  }
  try {
    return (await navigator.clipboard?.readText?.()) ?? '';
  } catch {
    return '';
  }
}

interface LookupPlugin {
  pending(): Promise<{ text: string; popup: boolean }>;
  close(): Promise<void>;
}
const Lookup = registerPlugin<LookupPlugin>('Lookup');

/** Text this window was opened for (Android: selected or shared text), and whether it is the lookup panel. */
export async function pendingLookup(): Promise<{ text: string; popup: boolean }> {
  if (!isNative()) return { text: '', popup: false };
  try { return await Lookup.pending(); } catch { return { text: '', popup: false }; }
}
export const closeLookupPanel = () => Lookup.close().catch(() => {});
