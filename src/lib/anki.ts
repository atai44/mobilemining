// Anki integration:
//  - AnkiConnect (desktop Anki add-on 2055492159, or the "AnkiConnect Android" app for AnkiDroid)
//  - AnkiMobile (iOS) via its anki://x-callback-url/addnote URL scheme
//  - TSV export for manual import
import { ankiFurigana, escapeHtml, rubyHtml } from './kana';
import type { TermResult } from './lookup';
import type { MinedNote } from './db';
import type { Settings } from './settings';

export const MARKERS: { name: string; description: string }[] = [
  { name: 'expression', description: 'Dictionary form, e.g. 食べる' },
  { name: 'reading', description: 'Reading in kana' },
  { name: 'furigana', description: 'Anki furigana syntax: 食[た]べる' },
  { name: 'furigana-html', description: 'HTML <ruby> furigana' },
  { name: 'glossary', description: 'All definitions (HTML list)' },
  { name: 'glossary-brief', description: 'First definition only' },
  { name: 'part-of-speech', description: 'Part-of-speech tags' },
  { name: 'sentence', description: 'Sentence with the word in <b>bold</b>' },
  { name: 'sentence-plain', description: 'Sentence without formatting' },
  { name: 'cloze-prefix', description: 'Sentence text before the word' },
  { name: 'cloze-body', description: 'The word as it appeared in the sentence' },
  { name: 'cloze-suffix', description: 'Sentence text after the word' },
  { name: 'image', description: 'Photo of the source (page or line crop)' },
  { name: 'audio', description: 'Pronunciation audio (JapanesePod101)' },
  { name: 'source', description: 'Where you found it (free text)' },
  { name: 'date', description: 'Date mined' },
];

export function audioUrl(expression: string, reading: string): string {
  const p = new URLSearchParams({ kana: reading });
  if (expression !== reading) p.set('kanji', expression);
  return `https://assets.languagepod101.com/dictionary/japanese/audiomp3.php?${p}`;
}
// MD5 of JapanesePod101's "audio not available" clip; AnkiConnect skips it.
export const JPOD_MISSING_AUDIO_MD5 = '7e2c2f954ef6051373ba916f000168dc';

export function glossaryHtml(r: TermResult, tags: Record<string, string> = {}): string {
  const items = r.senses.map((s) => {
    const meta = [...s.p, ...(s.m ?? []), ...(s.f ?? [])].map((t) => `<span title="${escapeHtml(tags[t] ?? t)}">${escapeHtml(t)}</span>`).join(', ');
    const info = s.n ? ` <small>(${escapeHtml(s.n)})</small>` : '';
    return `<li>${meta ? `<i>(${meta})</i> ` : ''}${escapeHtml(s.g.join('; '))}${info}</li>`;
  });
  return items.length === 1 ? items[0].replace(/^<li>|<\/li>$/g, '') : `<ol>${items.join('')}</ol>`;
}

/** Computes all marker values for a mined term. */
export function buildMarkerValues(r: TermResult, sentence: string, sentenceStart: number | null, source: string, tags: Record<string, string>): Record<string, string> {
  // Locate the scanned surface form inside the sentence for bolding / cloze.
  let idx = sentenceStart ?? -1;
  if (idx < 0 || sentence.slice(idx, idx + r.source.length) !== r.source) idx = sentence.indexOf(r.source);
  const prefix = idx >= 0 ? sentence.slice(0, idx) : sentence;
  const body = idx >= 0 ? r.source : '';
  const suffix = idx >= 0 ? sentence.slice(idx + r.source.length) : '';
  const pos = [...new Set(r.senses.flatMap((s) => s.p))];
  return {
    expression: r.expression,
    reading: r.reading,
    furigana: ankiFurigana(r.expression, r.reading),
    'furigana-html': rubyHtml(r.expression, r.reading),
    glossary: glossaryHtml(r, tags),
    'glossary-brief': escapeHtml(r.senses[0]?.g.join('; ') ?? ''),
    'part-of-speech': pos.map((p) => tags[p] ?? p).join(', '),
    sentence: idx >= 0 ? `${escapeHtml(prefix)}<b>${escapeHtml(body)}</b>${escapeHtml(suffix)}` : escapeHtml(sentence),
    'sentence-plain': sentence,
    'cloze-prefix': escapeHtml(prefix),
    'cloze-body': escapeHtml(body),
    'cloze-suffix': escapeHtml(suffix),
    source: escapeHtml(source),
    date: new Date().toLocaleDateString(),
  };
}

export function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{([a-z-]+)\}/g, (m, name) => values[name] ?? m);
}

/** Guesses a marker for a note-type field name (like Yomitan does). */
export function guessMarker(field: string): string {
  const f = field.toLowerCase().replace(/[\s_-]/g, '');
  const table: [RegExp, string][] = [
    [/^(expression|word|vocab|vocabulary|term|front|kanji|target|key)$/, '{expression}'],
    [/furigana/, '{furigana}'],
    [/^(reading|kana|vocabkana|wordreading)$/, '{reading}'],
    [/(meaning|definition|glossary|english|back|vocabdef)/, '{glossary}'],
    [/(sentence|context|example)/, '{sentence}'],
    [/(picture|image|photo|screenshot)/, '{image}'],
    [/(audio|sound)/, '{audio}'],
    [/(source|book)/, '{source}'],
    [/(pos|partofspeech)/, '{part-of-speech}'],
  ];
  for (const [re, m] of table) if (re.test(f)) return m;
  return '';
}

// --- AnkiConnect ---------------------------------------------------------------------------

export class AnkiConnect {
  constructor(private url: string, private key: string) {}

  async invoke<T>(action: string, params: Record<string, unknown> = {}): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.url, {
        method: 'POST',
        body: JSON.stringify({ action, version: 6, params, ...(this.key ? { key: this.key } : {}) }),
      });
    } catch {
      throw new Error(
        `Could not reach AnkiConnect at ${this.url}. Is Anki running with AnkiConnect installed, and is this site's origin (${location.origin}) in AnkiConnect's webCorsOriginList?`,
      );
    }
    const json = (await res.json()) as { result: T; error: string | null };
    if (json.error) throw new Error(`AnkiConnect: ${json.error}`);
    return json.result;
  }

  version() { return this.invoke<number>('version'); }
  requestPermission() { return this.invoke<{ permission: 'granted' | 'denied'; requireApiKey?: boolean }>('requestPermission'); }
  deckNames() { return this.invoke<string[]>('deckNames'); }
  modelNames() { return this.invoke<string[]>('modelNames'); }
  modelFieldNames(modelName: string) { return this.invoke<string[]>('modelFieldNames', { modelName }); }
  canAddNotes(notes: unknown[]) { return this.invoke<boolean[]>('canAddNotes', { notes }); }
  storeMediaFile(filename: string, data: string) { return this.invoke<string>('storeMediaFile', { filename, data }); }
  addNote(note: unknown) { return this.invoke<number>('addNote', { note }); }
  guiBrowse(query: string) { return this.invoke<number[]>('guiBrowse', { query }); }
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}

function ankiNote(settings: Settings, values: Record<string, string>) {
  const a = settings.anki;
  const fields: Record<string, string> = {};
  for (const [field, tpl] of Object.entries(a.fields)) fields[field] = fillTemplate(tpl, values);
  return {
    deckName: a.deck,
    modelName: a.model,
    fields,
    tags: a.tags.split(/\s+/).filter(Boolean),
    options: { allowDuplicate: a.allowDuplicates, duplicateScope: 'deck' },
  };
}

export async function canAdd(settings: Settings, values: Record<string, string>): Promise<boolean> {
  const a = settings.anki;
  if (a.method !== 'ankiconnect' || !a.deck || !a.model) return true;
  const client = new AnkiConnect(a.url, a.key);
  const [ok] = await client.canAddNotes([ankiNote(settings, { ...values, image: '', audio: '' })]);
  return ok;
}

export async function sendToAnkiConnect(settings: Settings, note: MinedNote): Promise<number> {
  const a = settings.anki;
  if (!a.deck || !a.model) throw new Error('Choose a deck and note type in Settings → Anki first.');
  const client = new AnkiConnect(a.url, a.key);
  const values = { ...note.fields };
  const usesImage = Object.values(a.fields).some((t) => t.includes('{image}'));
  if (note.image && usesImage) {
    const name = `mobilemining_${note.created}.jpg`;
    const stored = await client.storeMediaFile(name, await blobToBase64(note.image));
    values.image = `<img src="${escapeHtml(stored || name)}">`;
  } else values.image = '';
  const audioFields = Object.entries(a.fields).filter(([, t]) => t.includes('{audio}')).map(([f]) => f);
  values.audio = '';
  const n: Record<string, unknown> = ankiNote(settings, values);
  if (a.audio && audioFields.length && values.expression) {
    n.audio = [{
      url: audioUrl(values.expression, values.reading),
      filename: `mobilemining_${values.reading}_${values.expression}.mp3`,
      skipHash: JPOD_MISSING_AUDIO_MD5,
      fields: audioFields,
    }];
  }
  return client.addNote(n);
}

// --- AnkiMobile (iOS) -------------------------------------------------------------------------

export function ankiMobileUrl(settings: Settings, values: Record<string, string>): string {
  const m = settings.anki.mobile;
  const p = new URLSearchParams();
  p.set('profile', m.profile);
  p.set('type', m.model);
  p.set('deck', m.deck);
  for (const [field, tpl] of Object.entries(m.fields)) p.set(`fld${field}`, fillTemplate(tpl, { ...values, image: '', audio: '' }));
  if (settings.anki.tags) p.set('tags', settings.anki.tags);
  if (settings.anki.allowDuplicates) p.set('dupes', '1');
  p.set('x-success', location.href);
  return `anki://x-callback-url/addnote?${p.toString().replace(/\+/g, '%20')}`;
}

// --- TSV export -------------------------------------------------------------------------------

const TSV_COLUMNS = ['expression', 'reading', 'furigana', 'glossary', 'sentence', 'source', 'date'];

export function notesToTsv(notes: MinedNote[], tags: string): string {
  const clean = (s: string) => (s ?? '').replace(/[\t\r\n]+/g, ' ');
  const lines = [
    '#separator:tab',
    '#html:true',
    `#columns:${[...TSV_COLUMNS, 'tags'].join('\t')}`,
    `#tags column:${TSV_COLUMNS.length + 1}`,
  ];
  for (const n of notes) lines.push([...TSV_COLUMNS.map((c) => clean(n.fields[c] ?? '')), tags].join('\t'));
  return lines.join('\n') + '\n';
}
