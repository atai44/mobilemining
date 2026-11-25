// Anki integration, modelled on Yomitan + AnkiConnect:
//  - Yomitan-compatible field markers ({expression}, {glossary}, {cloze-body}, {pitch-accents}, ...)
//    so field mappings (and Yomitan settings backups) carry over unchanged
//  - duplicate check / prevent / add new / overwrite, "view note" in Anki's browser
//  - one-click note type creation
//  - AnkiMobile (iOS) URL scheme and TSV export as fallbacks
import { ankiFurigana, escapeHtml, furiganaSegments, rubyHtml, toHiragana } from './kana';
import type { Definition, TermResult } from './lookup';
import type { MinedNote } from './db';
import type { Settings } from './settings';
import { glossaryText, renderGlossaryItem } from './yomitan/render';
import { getMedia } from './yomitan/query';
import { downstepPosition, pitchCategory, pitchHtml } from './pitch';

export const MARKERS: { name: string; description: string }[] = [
  { name: 'expression', description: 'Dictionary form, e.g. 食べる' },
  { name: 'reading', description: 'Reading in kana' },
  { name: 'furigana', description: 'Expression with <ruby> furigana' },
  { name: 'furigana-plain', description: 'Anki furigana syntax: 食[た]べる' },
  { name: 'glossary', description: 'All definitions with tags and dictionary names' },
  { name: 'glossary-brief', description: 'All definitions, no tags' },
  { name: 'glossary-no-dictionary', description: 'All definitions, without dictionary names' },
  { name: 'glossary-plain', description: 'All definitions as plain text' },
  { name: 'glossary-plain-no-dictionary', description: 'Plain text, without dictionary names' },
  { name: 'glossary-first', description: 'First dictionary only' },
  { name: 'glossary-first-brief', description: 'First dictionary only, no tags' },
  { name: 'glossary-first-no-dictionary', description: 'First dictionary only, no dictionary name' },
  { name: 'sentence', description: 'Sentence (plain)' },
  { name: 'sentence-bold', description: 'Sentence with the word in <b>bold</b>' },
  { name: 'sentence-furigana', description: 'Sentence with furigana read from the photo (<ruby>)' },
  { name: 'sentence-furigana-plain', description: 'Sentence with furigana in Anki syntax' },
  { name: 'cloze-prefix', description: 'Sentence text before the word' },
  { name: 'cloze-body', description: 'The word as it appeared in the sentence' },
  { name: 'cloze-body-kana', description: 'The word as it appeared, in kana' },
  { name: 'cloze-suffix', description: 'Sentence text after the word' },
  { name: 'image', description: 'Photo of the source (also {screenshot})' },
  { name: 'audio', description: 'Pronunciation audio (JapanesePod101)' },
  { name: 'pitch-accents', description: 'Pitch accent (overline notation)' },
  { name: 'pitch-accent-positions', description: 'Pitch accent downstep numbers' },
  { name: 'pitch-accent-categories', description: 'heiban / atamadaka / nakadaka / odaka / kifuku' },
  { name: 'frequencies', description: 'All frequency values' },
  { name: 'frequency-harmonic-rank', description: 'Harmonic mean of frequency ranks (for sorting)' },
  { name: 'frequency-average-rank', description: 'Average frequency rank' },
  { name: 'part-of-speech', description: 'Part of speech' },
  { name: 'conjugation', description: 'How the word was inflected' },
  { name: 'tags', description: 'Definition tags' },
  { name: 'dictionary', description: 'Name of the first dictionary' },
  { name: 'document-title', description: 'Source title (also {source})' },
  { name: 'search-query', description: 'The text that was looked up' },
  { name: 'date', description: 'Date mined' },
];

export function dictSlug(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '-');
}

export function audioUrl(expression: string, reading: string): string {
  const p = new URLSearchParams({ kana: reading });
  if (expression !== reading) p.set('kanji', expression);
  return `https://assets.languagepod101.com/dictionary/japanese/audiomp3.php?${p}`;
}
// MD5 of JapanesePod101's "audio not available" clip; AnkiConnect skips it.
export const JPOD_MISSING_AUDIO_MD5 = '7e2c2f954ef6051373ba916f000168dc';

// --- Glossary rendering (Yomitan-style HTML) --------------------------------------------------

interface GlossaryOpts { tags: boolean; dictionary: boolean; plain?: boolean }

function definitionItems(d: Definition, jmTags: Record<string, string>, plain: boolean): { tags: string[]; items: string[] }[] {
  if (d.senses) {
    return d.senses.map((s) => ({
      tags: [...s.p, ...(s.m ?? []), ...(s.f ?? []), ...(s.d ?? [])],
      items: s.g.map((g) => (plain ? g : escapeHtml(g))).concat(s.n ? [plain ? `(${s.n})` : `<small>(${escapeHtml(s.n)})</small>`] : []),
    }));
  }
  const items = (d.glossary ?? []).map((g) => (plain ? glossaryText(g) : renderGlossaryItem(g, { dict: d.dict, images: 'placeholder' }))).filter(Boolean);
  void jmTags;
  return [{ tags: d.tags, items }];
}

export function glossaryHtml(defs: Definition[], o: GlossaryOpts, jmTags: Record<string, string> = {}): string {
  const blocks: string[] = [];
  for (const d of defs) {
    for (const { tags, items } of definitionItems(d, jmTags, !!o.plain)) {
      if (!items.length) continue;
      if (o.plain) {
        const label = [o.tags ? tags.join(', ') : '', o.dictionary ? d.dict : ''].filter(Boolean).join(', ');
        blocks.push(`${label ? `(${label}) ` : ''}${items.join('; ')}`);
        continue;
      }
      const label = [...(o.tags ? tags.map((t) => escapeHtml(t)) : []), ...(o.dictionary ? [escapeHtml(d.dict)] : [])];
      const head = label.length ? `<i>(${label.join(', ')})</i> ` : '';
      const body = items.length === 1 ? items[0] : `<ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul>`;
      blocks.push(`<span data-dictionary="${escapeHtml(d.dict)}">${head}${body}</span>`);
    }
  }
  if (o.plain) return blocks.join('\n');
  if (!blocks.length) return '';
  const inner = blocks.length === 1 ? blocks[0] : `<ol>${blocks.map((b) => `<li>${b}</li>`).join('')}</ol>`;
  return `<div style="text-align: left;" class="yomitan-glossary">${inner}</div>`;
}

// --- Marker values ---------------------------------------------------------------------------

export interface MarkerContext {
  sentence: string;
  /** Code-point offset of the scanned word inside `sentence`, if known. */
  offset: number | null;
  source: string;
  /** JMdict tag descriptions */
  tags?: Record<string, string>;
  /** Furigana read from the photo: code-point ranges of `sentence` with their reading. */
  ruby?: { start: number; end: number; text: string }[];
  /** Dictionaries whose frequencies are occurrence counts. */
  occurrenceFreqDicts?: Set<string>;
}

function clozeBodyKana(r: TermResult): string {
  // Replace the part of the surface form shared with the dictionary form by its reading.
  const src = Array.from(r.source), exp = Array.from(r.expression);
  let n = 0;
  while (n < src.length && n < exp.length && src[n] === exp[n]) n++;
  let readingOfPrefix = '';
  let consumed = 0;
  for (const seg of furiganaSegments(r.expression, r.reading)) {
    const len = Array.from(seg.t).length;
    if (consumed + len > n) {
      if (!seg.r) readingOfPrefix += Array.from(seg.t).slice(0, n - consumed).join('');
      else if (n - consumed === len) readingOfPrefix += seg.r;
      else return toHiragana(r.source);
      break;
    }
    readingOfPrefix += seg.r ?? seg.t;
    consumed += len;
    if (consumed === n) break;
  }
  return toHiragana(readingOfPrefix + src.slice(n).join(''));
}

function harmonicMean(values: number[]): number {
  return values.length ? Math.round(values.length / values.reduce((a, v) => a + 1 / Math.max(v, 1), 0)) : 0;
}

/** Computes all marker values for a mined term. */
export function buildMarkerValues(r: TermResult, ctx: MarkerContext): Record<string, string> {
  const { sentence, source } = ctx;
  const jmTags = ctx.tags ?? {};
  const cps = Array.from(sentence);
  const srcLen = Array.from(r.source).length;
  let idx = ctx.offset ?? -1;
  if (idx < 0 || cps.slice(idx, idx + srcLen).join('') !== r.source) {
    const j = sentence.indexOf(r.source);
    idx = j >= 0 ? Array.from(sentence.slice(0, j)).length : -1;
  }
  const prefix = idx >= 0 ? cps.slice(0, idx).join('') : sentence;
  const body = idx >= 0 ? r.source : '';
  const suffix = idx >= 0 ? cps.slice(idx + srcLen).join('') : '';

  // Sentence with photo furigana
  let sfHtml = '', sfPlain = '';
  const rubies = [...(ctx.ruby ?? [])].sort((a, b) => a.start - b.start);
  let pos = 0;
  for (const rb of rubies) {
    if (rb.start < pos || rb.end > cps.length) continue;
    const pre = cps.slice(pos, rb.start).join('');
    const base = cps.slice(rb.start, rb.end).join('');
    sfHtml += escapeHtml(pre) + `<ruby>${escapeHtml(base)}<rt>${escapeHtml(rb.text)}</rt></ruby>`;
    sfPlain += pre + `${sfPlain || pre ? ' ' : ''}${base}[${rb.text}]`;
    pos = rb.end;
  }
  sfHtml += escapeHtml(cps.slice(pos).join(''));
  sfPlain += cps.slice(pos).join('');

  const defs = r.definitions.length ? r.definitions : [];
  const firstDict = defs[0]?.dict;
  const firstDefs = defs.filter((d) => d.dict === firstDict);
  const pos_ = [...new Set(r.senses.flatMap((s) => s.p))];
  const tagsAll = [...new Set(defs.flatMap((d) => [...d.tags, ...d.termTags]))];

  const occ = ctx.occurrenceFreqDicts ?? new Set<string>();
  const rankFreqs = r.frequencies.filter((f) => !occ.has(f.dict)).map((f) => f.value);
  const occFreqs = r.frequencies.filter((f) => occ.has(f.dict)).map((f) => f.value);
  const pitchList = r.pitches.flatMap((p) => p.pitches.map((pi) => ({ reading: p.reading, pi })));
  const isConj = r.senses.some((s) => s.p.some((p) => /^(v|adj-i)/.test(p)));

  const values: Record<string, string> = {
    expression: r.expression,
    reading: r.reading,
    furigana: rubyHtml(r.expression, r.reading),
    'furigana-plain': ankiFurigana(r.expression, r.reading),
    glossary: glossaryHtml(defs, { tags: true, dictionary: true }, jmTags),
    'glossary-brief': glossaryHtml(defs, { tags: false, dictionary: false }, jmTags),
    'glossary-no-dictionary': glossaryHtml(defs, { tags: true, dictionary: false }, jmTags),
    'glossary-plain': glossaryHtml(defs, { tags: true, dictionary: true, plain: true }, jmTags),
    'glossary-plain-no-dictionary': glossaryHtml(defs, { tags: true, dictionary: false, plain: true }, jmTags),
    'glossary-first': glossaryHtml(firstDefs, { tags: true, dictionary: true }, jmTags),
    'glossary-first-brief': glossaryHtml(firstDefs, { tags: false, dictionary: false }, jmTags),
    'glossary-first-no-dictionary': glossaryHtml(firstDefs, { tags: true, dictionary: false }, jmTags),
    sentence: escapeHtml(sentence),
    'sentence-bold': idx >= 0 ? `${escapeHtml(prefix)}<b>${escapeHtml(body)}</b>${escapeHtml(suffix)}` : escapeHtml(sentence),
    'sentence-furigana': sfHtml,
    'sentence-furigana-plain': sfPlain,
    'cloze-prefix': escapeHtml(prefix),
    'cloze-body': escapeHtml(body),
    'cloze-body-kana': escapeHtml(body ? clozeBodyKana(r) : ''),
    'cloze-suffix': escapeHtml(suffix),
    'pitch-accents': pitchList.length > 1 ? `<ol>${pitchList.map((p) => `<li>${pitchHtml(p.reading, p.pi)}</li>`).join('')}</ol>` : pitchList.map((p) => pitchHtml(p.reading, p.pi)).join(''),
    'pitch-accent-positions': [...new Set(pitchList.map((p) => String(downstepPosition(p.pi.position))))].join(', '),
    'pitch-accent-categories': [...new Set(pitchList.map((p) => pitchCategory(p.reading, p.pi.position, isConj)))].join(','),
    frequencies: r.frequencies.length ? `<ul style="text-align: left;">${r.frequencies.map((f) => `<li>${escapeHtml(f.dict)}: ${escapeHtml(f.display)}</li>`).join('')}</ul>` : '',
    'frequency-harmonic-rank': rankFreqs.length ? String(harmonicMean(rankFreqs)) : '9999999',
    'frequency-average-rank': rankFreqs.length ? String(Math.round(rankFreqs.reduce((a, b) => a + b, 0) / rankFreqs.length)) : '9999999',
    'frequency-harmonic-occurrence': occFreqs.length ? String(harmonicMean(occFreqs)) : '0',
    'frequency-average-occurrence': occFreqs.length ? String(Math.round(occFreqs.reduce((a, b) => a + b, 0) / occFreqs.length)) : '0',
    'part-of-speech': pos_.map((p) => jmTags[p] ?? p).join(', '),
    conjugation: escapeHtml(r.reasons.join(' « ')),
    tags: escapeHtml(tagsAll.join(', ')),
    dictionary: escapeHtml(firstDict ?? ''),
    'dictionary-alias': escapeHtml(firstDict ?? ''),
    'document-title': escapeHtml(source),
    source: escapeHtml(source),
    'search-query': escapeHtml(r.source),
    url: '',
    'clipboard-text': '',
    'selection-text': '',
    'popup-selection-text': '',
    'phonetic-transcriptions': '',
    date: new Date().toLocaleDateString(),
  };
  // Per-dictionary markers, e.g. {single-glossary-jitendex.org-[2024-01-01]}
  for (const d of new Set(defs.map((x) => x.dict))) {
    values[`single-glossary-${dictSlug(d)}`] = glossaryHtml(defs.filter((x) => x.dict === d), { tags: true, dictionary: false }, jmTags);
  }
  for (const f of r.frequencies) values[`single-frequency-number-${dictSlug(f.dict)}`] ??= String(f.value);
  // Legacy names from earlier versions of this app
  values['furigana-html'] = values.furigana;
  return values;
}

/** Media markers are filled in when the note is sent; everything else comes from `values`. */
const MEDIA_MARKERS = new Set(['image', 'screenshot', 'clipboard-image', 'audio']);

export function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{([a-z0-9][a-z0-9._\-[\]]*)\}/gi, (_m, name: string) => values[name] ?? '');
}

export function usesMarker(fields: Record<string, string>, marker: string): string[] {
  return Object.entries(fields).filter(([, t]) => t.includes(`{${marker}}`)).map(([f]) => f);
}

/** Guesses a marker for a note-type field name (Yomitan / Lapis / Kiku / JPMN conventions). */
export function guessMarker(field: string): string {
  const f = field.toLowerCase().replace(/[\s_-]/g, '');
  const table: [RegExp, string][] = [
    [/^(expression|word|vocab|vocabulary|term|front|kanji|target|key|targetword)$/, '{expression}'],
    [/^(expressionfurigana|wordfurigana|vocabfurigana|furigana)$/, '{furigana-plain}'],
    [/^(sentencefurigana)$/, '{sentence-furigana-plain}'],
    [/^(reading|kana|vocabkana|wordreading|expressionreading)$/, '{reading}'],
    [/^(expressionaudio|wordaudio|vocabaudio|audio|sound)$/, '{audio}'],
    [/^(sentenceaudio)$/, ''],
    [/^(maindefinition|meaning|definition|glossary|english|back|vocabdef|definitions)$/, '{glossary}'],
    [/^(sentence|context|example|sentencekanji)$/, '{cloze-prefix}<b>{cloze-body}</b>{cloze-suffix}'],
    [/^(picture|image|photo|screenshot|definitionpicture)$/, '{image}'],
    [/^(pitchposition|pitchaccent|pitch|graph)$/, '{pitch-accent-positions}'],
    [/^(pitchcategories|pitchcategory)$/, '{pitch-accent-categories}'],
    [/^(frequency|frequencies)$/, '{frequencies}'],
    [/^(freqsort|frequencysort|freq)$/, '{frequency-harmonic-rank}'],
    [/^(source|book|miscinfo|documenttitle)$/, '{document-title}'],
    [/^(selectiontext)$/, ''],
    [/^(pos|partofspeech)$/, '{part-of-speech}'],
  ];
  for (const [re, m] of table) if (re.test(f)) return m;
  if (/sentence/.test(f)) return '{cloze-prefix}<b>{cloze-body}</b>{cloze-suffix}';
  if (/(meaning|definition|gloss)/.test(f)) return '{glossary}';
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
  createDeck(deck: string) { return this.invoke<number>('createDeck', { deck }); }
  createModel(params: Record<string, unknown>) { return this.invoke<unknown>('createModel', params); }
  findNotes(query: string) { return this.invoke<number[]>('findNotes', { query }); }
  storeMediaFile(filename: string, data: string) { return this.invoke<string>('storeMediaFile', { filename, data }); }
  addNote(note: unknown) { return this.invoke<number>('addNote', { note }); }
  updateNoteFields(note: unknown) { return this.invoke<null>('updateNoteFields', { note }); }
  guiBrowse(query: string) { return this.invoke<number[]>('guiBrowse', { query }); }
  guiEditNote(note: number) { return this.invoke<null>('guiEditNote', { note }); }
}

export const client = (s: Settings) => new AnkiConnect(s.anki.url, s.anki.key);

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}

function renderFields(settings: Settings, values: Record<string, string>): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [field, tpl] of Object.entries(settings.anki.fields)) fields[field] = fillTemplate(tpl, values).trim();
  return fields;
}

function duplicateOptions(settings: Settings) {
  const a = settings.anki;
  const deckName = a.duplicateScope === 'deck-root' ? a.deck.split('::')[0] : a.deck;
  return {
    allowDuplicate: a.duplicateBehavior !== 'prevent' || !a.checkForDuplicates,
    duplicateScope: a.duplicateScope === 'collection' ? 'collection' : 'deck',
    duplicateScopeOptions: { deckName, checkChildren: a.duplicateScope === 'deck-root', checkAllModels: false },
  };
}

function quote(s: string): string {
  return `"${s.replace(/([\\"*_])/g, '\\$1')}"`;
}

/** Notes that duplicate this one (same first field, same note type, within the duplicate scope). */
export async function findDuplicates(settings: Settings, values: Record<string, string>): Promise<number[]> {
  const a = settings.anki;
  if (a.method !== 'ankiconnect' || !a.model || !a.checkForDuplicates) return [];
  const [firstField, tpl] = Object.entries(a.fields)[0] ?? [];
  if (!firstField) return [];
  const value = fillTemplate(tpl, { ...values, image: '', audio: '' }).replace(/<[^>]+>/g, '').trim();
  if (!value) return [];
  let query = `${quote('note:' + a.model)} ${quote(firstField + ':' + value)}`;
  if (a.duplicateScope === 'deck' && a.deck) query += ` ${quote('deck:' + a.deck)}`;
  if (a.duplicateScope === 'deck-root' && a.deck) query += ` ${quote('deck:' + a.deck.split('::')[0])}`;
  return client(settings).findNotes(query);
}

/** Uploads images referenced by dictionary glossaries (<img data-media-*>) and rewrites their src. */
async function uploadGlossaryImages(c: AnkiConnect, html: string): Promise<string> {
  const re = /<img [^>]*data-media-dict="([^"]*)" data-media-path="([^"]*)"[^>]*>/g;
  const matches = [...html.matchAll(re)];
  for (const m of matches) {
    const dict = m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    const path = m[2].replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    const blob = await getMedia(dict, path);
    if (!blob) { html = html.replace(m[0], ''); continue; }
    const ext = path.split('.').pop() ?? 'png';
    const name = `mobilemining_dict_${hash(dict + '/' + path)}.${ext}`;
    const stored = await c.storeMediaFile(name, await blobToBase64(blob));
    const style = /style="([^"]*)"/.exec(m[0])?.[1] ?? '';
    html = html.replace(m[0], `<img src="${escapeHtml(stored || name)}" style="${style}">`);
  }
  return html;
}

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

export interface SendResult { noteId: number; action: 'added' | 'updated' }

/**
 * Sends a mined note following the duplicate behavior setting:
 *  prevent: refuse if a duplicate exists; new: add anyway; overwrite: update the existing note.
 */
export async function sendToAnkiConnect(settings: Settings, note: MinedNote, force?: 'new' | 'overwrite'): Promise<SendResult> {
  const a = settings.anki;
  if (!a.deck || !a.model) throw new Error('Choose a deck and note type in Settings → Anki first.');
  const c = client(settings);
  const values = { ...note.fields };
  const imageFields = new Set([...usesMarker(a.fields, 'image'), ...usesMarker(a.fields, 'screenshot'), ...usesMarker(a.fields, 'clipboard-image')]);
  let img = '';
  if (note.image && imageFields.size) {
    const name = `mobilemining_${note.created}.jpg`;
    const stored = await c.storeMediaFile(name, await blobToBase64(note.image));
    img = `<img src="${escapeHtml(stored || name)}">`;
  }
  for (const m of MEDIA_MARKERS) values[m] = m === 'audio' ? '' : img;
  const fields = renderFields(settings, values);
  for (const [f, v] of Object.entries(fields)) if (v.includes('data-media-path')) fields[f] = await uploadGlossaryImages(c, v);

  const audioFields = usesMarker(a.fields, 'audio');
  const audio = a.audio && audioFields.length && values.expression
    ? [{ url: audioUrl(values.expression, values.reading), filename: `mobilemining_${values.reading}_${values.expression}.mp3`, skipHash: JPOD_MISSING_AUDIO_MD5, fields: audioFields }]
    : undefined;

  const behavior = force ?? a.duplicateBehavior;
  if (a.checkForDuplicates && behavior !== 'new') {
    const dupes = await findDuplicates(settings, note.fields);
    if (dupes.length) {
      if (behavior === 'prevent') throw new Error(`「${values.expression}」 is already in Anki.`);
      // overwrite: only replace fields that have a new non-empty value (Yomitan's "coalesce")
      const update: Record<string, unknown> = { id: dupes[0], fields: Object.fromEntries(Object.entries(fields).filter(([, v]) => v)) };
      if (audio) update.audio = audio;
      await c.updateNoteFields(update);
      return { noteId: dupes[0], action: 'updated' };
    }
  }
  const n: Record<string, unknown> = {
    deckName: a.deck,
    modelName: a.model,
    fields,
    tags: a.tags.split(/\s+/).filter(Boolean),
    options: { ...duplicateOptions(settings), allowDuplicate: true },
  };
  if (audio) n.audio = audio;
  return { noteId: await c.addNote(n), action: 'added' };
}

export async function viewNote(settings: Settings, noteId: number) {
  const c = client(settings);
  if (settings.anki.noteGuiMode === 'edit') await c.guiEditNote(noteId);
  else await c.guiBrowse(`nid:${noteId}`);
}

// --- Note type creation --------------------------------------------------------------------

export const MM_MODEL = 'MobileMining';
export const MM_FIELDS: Record<string, string> = {
  Word: '{expression}',
  Reading: '{reading}',
  Furigana: '{furigana-plain}',
  Meaning: '{glossary}',
  Sentence: '{cloze-prefix}<b>{cloze-body}</b>{cloze-suffix}',
  SentenceFurigana: '{sentence-furigana-plain}',
  Picture: '{image}',
  Audio: '{audio}',
  PitchAccent: '{pitch-accents}',
  Frequency: '{frequency-harmonic-rank}',
  Source: '{document-title}',
};

const MM_CSS = `.card { font-family: "Hiragino Sans", "Noto Sans JP", "Yu Gothic", sans-serif; font-size: 22px; text-align: center; color: #1c1b19; background: #fbfaf7; line-height: 1.6; }
.nightMode.card, .night_mode .card { color: #ede9e1; background: #1d1c1a; }
.sentence { font-size: 30px; margin: 12px 0; }
.sentence b { color: #c2410c; }
.nightMode .sentence b { color: #fb923c; }
.word { font-size: 40px; margin-top: 8px; }
.pitch { margin: 4px 0 12px; }
.meaning { text-align: left; font-size: 18px; max-width: 640px; margin: 0 auto; }
.meaning ol, .meaning ul { padding-left: 1.4em; }
.picture img { max-width: 100%; max-height: 360px; margin-top: 16px; border-radius: 8px; }
.source { color: #8a867d; font-size: 14px; margin-top: 12px; }`;

export async function createMobileMiningModel(settings: Settings): Promise<string> {
  const c = client(settings);
  const existing = await c.modelNames();
  if (!existing.includes(MM_MODEL)) {
    await c.createModel({
      modelName: MM_MODEL,
      inOrderFields: Object.keys(MM_FIELDS),
      css: MM_CSS,
      isCloze: false,
      cardTemplates: [{
        Name: 'Sentence → Word',
        Front: '<div class="sentence">{{Sentence}}</div>',
        Back: '{{FrontSide}}<hr id="answer"><div class="word">{{furigana:Furigana}}</div>{{Audio}}<div class="pitch">{{PitchAccent}}</div><div class="meaning">{{Meaning}}</div><div class="picture">{{Picture}}</div><div class="source">{{Source}}</div>',
      }],
    });
  }
  return MM_MODEL;
}

// --- AnkiMobile (iOS) -------------------------------------------------------------------------

export function ankiMobileUrl(settings: Settings, values: Record<string, string>): string {
  const m = settings.anki.mobile;
  const p = new URLSearchParams();
  p.set('profile', m.profile);
  p.set('type', m.model);
  p.set('deck', m.deck);
  const v = { ...values, image: '', screenshot: '', audio: '' };
  for (const [field, tpl] of Object.entries(m.fields)) p.set(`fld${field}`, fillTemplate(tpl, v));
  if (settings.anki.tags) p.set('tags', settings.anki.tags);
  if (settings.anki.duplicateBehavior !== 'prevent') p.set('dupes', '1');
  p.set('x-success', location.href);
  return `anki://x-callback-url/addnote?${p.toString().replace(/\+/g, '%20')}`;
}

// --- TSV export -------------------------------------------------------------------------------

const TSV_COLUMNS = ['expression', 'reading', 'furigana-plain', 'glossary', 'sentence-bold', 'sentence-furigana-plain', 'pitch-accent-positions', 'frequency-harmonic-rank', 'source', 'date'];

/** A TSV field: one line, quoted when it contains quotes (Anki's importer understands CSV quoting). */
function tsvField(v: string): string {
  const s = (v ?? '').replace(/[\t\r\n]+/g, ' ');
  return s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Mined cards as a file for Anki's File → Import (desktop) / Import (AnkiDroid). With an export
 * note type configured (e.g. imported from Yomitan), its fields are filled from the same markers
 * as AnkiConnect, and the #notetype / #deck headers make Anki pick them automatically.
 * Images and audio can't travel in a text file and are left empty.
 */
export function notesToTsv(notes: MinedNote[], settings: Settings): string {
  const a = settings.anki;
  const ex = a.export;
  const names = Object.keys(ex.fields);
  const lines = ['#separator:tab', '#html:true'];
  if (names.length && ex.model) lines.push(`#notetype:${ex.model}`);
  if (names.length && ex.deck) lines.push(`#deck:${ex.deck}`);
  const columns = names.length ? names : TSV_COLUMNS;
  lines.push(`#columns:${[...columns, 'tags'].join('\t')}`, `#tags column:${columns.length + 1}`);
  for (const n of notes) {
    let row: string[];
    if (names.length) {
      const values: Record<string, string> = { ...n.fields };
      for (const m of MEDIA_MARKERS) values[m] = '';
      row = names.map((f) => fillTemplate(ex.fields[f], values).replace(/<img [^>]*data-media-path[^>]*>/g, '').trim());
    } else {
      row = TSV_COLUMNS.map((c) => n.fields[c] ?? n.fields[c.replace('-plain', '')] ?? '');
    }
    lines.push([...row, a.tags].map(tsvField).join('\t'));
  }
  return lines.join('\n') + '\n';
}
