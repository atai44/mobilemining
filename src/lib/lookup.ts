// Yomitan-style scanning: from a tapped character, try progressively shorter prefixes,
// deinflect each, and look the candidates up in the dictionary.
import { deinflect, posToConds, type Cond } from './deinflect';
import { hasKanji, isKana, normalizeText, toHiragana } from './kana';
import type { Entry, Sense } from './db';

export interface TermResult {
  entry: Entry;
  /** Number of code points of the scanned text this result covers. */
  length: number;
  /** Surface text that matched (as it appears in the source). */
  source: string;
  /** The dictionary form searched for. */
  term: string;
  reasons: string[];
  expression: string;
  reading: string;
  senses: Sense[];
  common: boolean;
  priority: number;
  /** Other written forms of the same entry. */
  alternates: string[];
}

export type KeyLookup = (keys: string[]) => Promise<Map<string, Entry[]>>;

const STOP = new Set(Array.from(' \t\n\r　。、，．！？!?「」『』（）()【】［］[]〈〉《》…‥：:；;"\'“”‘’・〜～'));

/** Returns the scan window (code points) starting at `start`, stopping at punctuation/whitespace. */
export function scanWindow(text: string[], start: number, maxLen = 20): string[] {
  const out: string[] = [];
  for (let i = start; i < text.length && out.length < maxLen; i++) {
    const c = text[i];
    if (STOP.has(c)) break;
    out.push(normalizeText(c));
  }
  return out;
}

function entryConds(e: Entry): Set<Cond> {
  const s = new Set<Cond>();
  for (const sense of e.s) for (const p of sense.p) {
    const c = posToConds(p);
    if (c) s.add(c);
  }
  return s;
}

export async function findTerms(text: string[], start: number, lookup: KeyLookup, maxResults = 24): Promise<TermResult[]> {
  const win = scanWindow(text, start);
  if (!win.length) return [];
  // Build candidates for each prefix length.
  const candidates: { length: number; term: string; conds: Cond[]; reasons: string[] }[] = [];
  for (let len = win.length; len >= 1; len--) {
    const prefix = win.slice(0, len).join('');
    for (const d of deinflect(prefix)) candidates.push({ length: len, ...d });
  }
  const keys = new Set<string>();
  for (const c of candidates) {
    keys.add(c.term);
    const h = toHiragana(c.term);
    if (h !== c.term) keys.add(h);
  }
  const found = await lookup([...keys]);

  const best = new Map<number, TermResult & { matchedKanji: boolean }>();
  for (const c of candidates) {
    const hits = [...(found.get(c.term) ?? []), ...(toHiragana(c.term) !== c.term ? found.get(toHiragana(c.term)) ?? [] : [])];
    for (const e of hits) {
      if (c.conds.length) {
        const ec = entryConds(e);
        if (!c.conds.some((x) => ec.has(x))) continue;
      }
      const prev = best.get(e.id);
      if (prev && (prev.length > c.length || (prev.length === c.length && prev.reasons.length <= c.reasons.length))) continue;
      const r = buildResult(e, c.term, win.slice(0, c.length).join(''), c.length, c.reasons);
      if (r) best.set(e.id, r);
    }
  }
  const results = [...best.values()];
  const sourceHasKanji = hasKanji(win[0]);
  results.sort((a, b) =>
    b.length - a.length ||
    // Exact (non-deinflected) matches before deinflected ones of the same length
    a.reasons.length - b.reasons.length ||
    // Prefer kanji-form matches when the source starts with kanji
    (sourceHasKanji ? Number(b.matchedKanji) - Number(a.matchedKanji) : 0) ||
    Number(b.common) - Number(a.common) ||
    a.priority - b.priority ||
    a.entry.id - b.entry.id,
  );
  return results.slice(0, maxResults).map(({ matchedKanji: _, ...r }) => r as TermResult);
}

function buildResult(e: Entry, term: string, source: string, length: number, reasons: string[]): (TermResult & { matchedKanji: boolean }) | null {
  const termN = normalizeText(term);
  const termH = toHiragana(termN);
  const kMatch = e.k.find((k) => normalizeText(k.t) === termN);
  const rMatch = e.r.find((r) => r.t === termN || toHiragana(r.t) === termH);
  if (!kMatch && !rMatch) return null;
  let expression: string;
  let reading: string;
  const usuallyKana = e.s.some((s) => s.m?.includes('uk'));
  if (kMatch) {
    expression = kMatch.t;
    const r = e.r.find((r) => !r.n && (!r.r || r.r.includes(kMatch.t))) ?? e.r[0];
    reading = r.t;
  } else {
    reading = rMatch!.t;
    const k = rMatch!.n ? undefined : e.k.find((k) => !rMatch!.r || rMatch!.r.includes(k.t));
    // Scanned as kana: keep the kana form when the word is usually written in kana or the source is kana.
    expression = !k || usuallyKana || [...source].every(isKana) ? rMatch!.t : k.t;
    if (expression === reading && k && !usuallyKana && ![...source].every(isKana)) expression = k.t;
  }
  const senses = e.s.filter(
    (s) => (!s.sk || !kMatch || s.sk.includes(kMatch.t)) && (!s.sr || s.sr.includes(reading)),
  );
  const forms = [kMatch ?? e.k[0], rMatch ?? e.r[0]].filter(Boolean);
  const common = forms.some((f) => f?.c) || e.k.some((k) => k.c) || e.r.some((r) => r.c);
  const priority = Math.min(...[...e.k, ...e.r].map((f) => f.p ?? 1000));
  const alternates = e.k.map((k) => k.t).filter((t) => t !== expression);
  return { entry: e, length, source, term, reasons, expression, reading, senses: senses.length ? senses : e.s, common, priority, alternates, matchedKanji: !!kMatch };
}

// --- Sentence extraction ---------------------------------------------------------------------

const SENTENCE_END = new Set(Array.from('。！？!?…\n'));
const QUOTE_OPEN = new Set(Array.from('「『（(【'));
const QUOTE_CLOSE = new Set(Array.from('」』）)】'));

/**
 * Extracts the sentence around code-point index `pos`. Line breaks inside a paragraph
 * (common in OCR of books) are treated as soft unless `hardBreaks` is set.
 */
export function extractSentence(text: string[], pos: number, hardBreaks = false): { sentence: string; start: number; end: number } {
  const isEnd = (c: string) => SENTENCE_END.has(c) && (c !== '\n' || hardBreaks);
  let start = pos;
  let depth = 0;
  let insideQuote = false;
  while (start > 0) {
    const c = text[start - 1];
    if (QUOTE_CLOSE.has(c)) depth++;
    else if (QUOTE_OPEN.has(c)) {
      if (depth === 0) { insideQuote = true; break; } // inside a quote: start after its opening bracket
      depth--;
    } else if (depth === 0 && isEnd(c)) break;
    start--;
  }
  let end = pos;
  depth = 0;
  while (end < text.length) {
    const c = text[end];
    if (QUOTE_OPEN.has(c)) depth++;
    else if (QUOTE_CLOSE.has(c)) {
      if (depth === 0) break;
      depth--;
    } else if (depth === 0 && isEnd(c)) {
      if (c !== '\n') end++;
      // include trailing closing punctuation
      const trailing = insideQuote ? /[！？!?。]/ : /[！？!?。」』）]/;
      while (end < text.length && trailing.test(text[end])) end++;
      break;
    }
    end++;
  }
  const sentence = text.slice(start, end).join('').replace(/\n/g, '').trim();
  return { sentence, start, end };
}
