// Creating cards from a lookup: sentence context (with photo furigana), marker values,
// image, and sending according to the configured Anki method.
import { extractSentence, type TermResult } from './lib/lookup';
import { ankiMobileUrl, buildMarkerValues, isAndroid, sendToAnkiConnect, shareToAnkiDroid, type SendResult } from './lib/anki';
import { saveNote, tagDescriptions, type MinedNote } from './lib/db';
import type { ImageMode } from './lib/settings';
import { cropImage } from './scanActions';
import { occurrenceFreqDicts } from './dictionaries';
import { scan, settings, type Scan } from './store';

export interface MiningContext {
  sentence: string;
  /** Code-point offset of the tapped position inside `sentence`. */
  offset: number;
  ruby: { start: number; end: number; text: string }[];
}

/** The sentence around `index`, with soft line breaks removed and furigana re-based onto it. */
export function miningContext(s: Pick<Scan, 'text' | 'ruby'>, index: number, hardBreaks: boolean): MiningContext {
  const { start, end } = extractSentence(s.text, index, hardBreaks);
  const map = new Map<number, number>(); // text index -> sentence index
  const out: string[] = [];
  for (let i = start; i < end; i++) {
    if (s.text[i] === '\n') continue;
    map.set(i, out.length);
    out.push(s.text[i]);
  }
  map.set(end, out.length);
  let lead = 0;
  while (lead < out.length && /\s/.test(out[lead])) lead++;
  let trail = out.length;
  while (trail > lead && /\s/.test(out[trail - 1])) trail--;
  const sentence = out.slice(lead, trail).join('');
  const ruby = s.ruby
    .filter((r) => r.start >= start && r.end <= end)
    .map((r) => ({ start: (map.get(r.start) ?? 0) - lead, end: (map.get(r.end) ?? 0) - lead, text: r.text }))
    .filter((r) => r.start >= 0 && r.end <= trail - lead && r.end > r.start);
  return { sentence, offset: Math.max(0, (map.get(index) ?? lead) - lead), ruby };
}

export async function markerValues(result: TermResult, ctx: { sentence: string; offset: number | null; ruby: MiningContext['ruby']; source: string }) {
  return buildMarkerValues(result, { ...ctx, tags: await tagDescriptions(), occurrenceFreqDicts: occurrenceFreqDicts() });
}

export interface MineOutcome { note: MinedNote; sent: SendResult | null; error: string | null }

/** Saves a card locally and sends it with the configured method. */
export async function mineTerm(
  result: TermResult,
  values: Record<string, string>,
  image: Blob | null,
  force?: 'new' | 'overwrite',
): Promise<MineOutcome> {
  const st = settings.value;
  const note: MinedNote = { created: Date.now(), fields: values, image: image ?? undefined, status: 'pending' };
  let sent: SendResult | null = null;
  let error: string | null = null;
  if (st.anki.method === 'ankidroid') {
    // Share first: the browser only allows it right after the tap.
    try {
      await shareToAnkiDroid(st, values);
      note.status = 'added';
    } catch (e) {
      if ((e as Error).name !== 'AbortError') { error = String((e as Error).message ?? e); note.status = 'error'; note.error = error; }
    }
    note.id = await saveNote(note);
    return { note, sent, error };
  }
  if (st.anki.method === 'ankimobile' && isAndroid()) {
    error = 'AnkiMobile is iPhone/iPad only. On Android use AnkiDroid or AnkiConnect (Settings → Anki).';
    note.status = 'error';
    note.error = error;
  }
  note.id = await saveNote(note);
  if (error) return { note, sent, error };
  if (st.anki.method === 'ankiconnect') {
    try {
      sent = await sendToAnkiConnect(st, note, force);
      note.status = 'added';
      note.ankiNoteId = sent.noteId;
    } catch (e) {
      error = String((e as Error).message ?? e);
      note.status = 'error';
      note.error = error;
    }
    await saveNote(note);
  } else if (st.anki.method === 'ankimobile') {
    note.status = 'added';
    await saveNote(note);
    location.href = ankiMobileUrl(st, values);
  }
  return { note, sent, error };
}

/** One-tap mining from the popup: default sentence, default image. */
export async function quickMine(result: TermResult, index: number, force?: 'new' | 'overwrite'): Promise<MineOutcome> {
  const s = scan.value!;
  const st = settings.value;
  const ctx = miningContext(s, index, st.display.hardLineBreaks);
  const values = await markerValues(result, { ...ctx, source: s.source });
  const image = await defaultImage(s, index, st.anki.image);
  return mineTerm(result, values, image, force);
}

export async function defaultImage(s: Scan, index: number, mode: ImageMode): Promise<Blob | null> {
  if (!s.canvas || mode === 'none') return null;
  const li = s.lineOf[index] ?? -1;
  return cropImage(s.canvas, mode === 'line' && li >= 0 ? s.lines[li] : null);
}
