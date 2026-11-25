// Yomitan-style scanning: from a tapped character, try progressively shorter prefixes,
// deinflect each, and look the candidates up in the built-in JMdict and in imported
// Yomitan dictionaries. Results are grouped by (expression, reading) like Yomitan's
// "grouped" result mode, with definitions ordered by dictionary priority.
import { deinflect, posToConds, type Cond } from './deinflect';
import { hasKanji, isKana, normalizeText, toHiragana } from './kana';
import type { Entry, Sense } from './db';
import type { GlossaryItem, PitchInfo, YTerm, YTermMeta } from './yomitan/types';

export const BUILTIN_DICT = 'JMdict (built-in)';

export interface Definition {
  dict: string;
  /** Built-in JMdict senses */
  senses?: Sense[];
  /** Imported (Yomitan) glossary */
  glossary?: GlossaryItem[];
  tags: string[];
  termTags: string[];
  score: number;
  sequence?: number;
}

export interface Frequency { dict: string; value: number; display: string }
export interface Pitch { dict: string; reading: string; pitches: PitchInfo[] }

export interface TermResult {
  /** Built-in JMdict entry, when the term was found there. */
  entry?: Entry;
  /** Number of code points of the scanned text this result covers. */
  length: number;
  /** Surface text that matched (as it appears in the source). */
  source: string;
  /** The dictionary form searched for. */
  term: string;
  reasons: string[];
  expression: string;
  reading: string;
  /** Built-in JMdict senses (empty when only imported dictionaries matched). */
  senses: Sense[];
  definitions: Definition[];
  frequencies: Frequency[];
  pitches: Pitch[];
  common: boolean;
  priority: number;
  score: number;
  /** Other written forms of the same entry. */
  alternates: string[];
}

export type KeyLookup = (keys: string[]) => Promise<Map<string, Entry[]>>;

export interface LookupSources {
  builtin?: KeyLookup | null;
  yomitan?: (keys: string[]) => Promise<Map<string, YTerm[]>>;
  meta?: (expressions: string[]) => Promise<Map<string, YTermMeta[]>>;
  /** Dictionary names in priority order. */
  dictOrder?: string[];
  /** Dictionaries whose frequency values are occurrence counts (higher = more common). */
  occurrenceFreqDicts?: Set<string>;
}

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

/** Maps Yomitan deinflection rule identifiers (v1, v5, vs, vk, vz, adj-i, ...) to our conditions. */
export function yomitanConds(rules: string[], expression: string): Set<Cond> {
  const s = new Set<Cond>();
  for (const r of rules) {
    if (r.startsWith('v1')) s.add('v1');
    else if (r.startsWith('v5') || r === 'iku') s.add('v5');
    else if (r === 'vk') s.add('vk');
    else if (r === 'vs') s.add(expression.endsWith('する') || expression.endsWith('ずる') ? 'vs' : 'vs-n');
    else if (r === 'vz') s.add('vz');
    else if (r === 'adj-i') s.add('adj-i');
  }
  return s;
}

const COMMON_TAGS = new Set(['common', 'P', '★', 'priority']);

export function parseFrequency(data: unknown, reading: string): { value: number; display: string } | null {
  let d = data as Record<string, unknown> | number | string;
  if (d && typeof d === 'object' && 'frequency' in d) {
    if (typeof d.reading === 'string' && d.reading !== reading && toHiragana(d.reading) !== toHiragana(reading)) return null;
    d = d.frequency as typeof d;
  }
  if (typeof d === 'number') return { value: d, display: String(d) };
  if (typeof d === 'string') {
    const n = parseInt(d.replace(/[^\d]/g, ''), 10);
    return Number.isFinite(n) ? { value: n, display: d } : null;
  }
  if (d && typeof d === 'object' && typeof d.value === 'number') return { value: d.value, display: typeof d.displayValue === 'string' ? d.displayValue : String(d.value) };
  return null;
}

interface Group extends TermResult {
  key: string;
  matchedKanji: boolean;
  defIds: Set<string>;
}

export async function findTerms(text: string[], start: number, sources: KeyLookup | LookupSources, maxResults = 24): Promise<TermResult[]> {
  const src: LookupSources = typeof sources === 'function' ? { builtin: sources } : sources;
  const order = src.dictOrder ?? [BUILTIN_DICT];
  const rank = (dict: string) => { const i = order.indexOf(dict); return i < 0 ? order.length : i; };
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
  const keyList = [...keys];
  const [found, yfound] = await Promise.all([
    src.builtin ? src.builtin(keyList) : Promise.resolve(new Map<string, Entry[]>()),
    src.yomitan ? src.yomitan(keyList) : Promise.resolve(new Map<string, YTerm[]>()),
  ]);

  const groups = new Map<string, Group>();
  const touch = (key: string, init: () => Group, c: { length: number; reasons: string[]; term: string }, source: string, matchedKanji: boolean) => {
    let g = groups.get(key);
    if (!g) { g = init(); groups.set(key, g); return g; }
    if (c.length > g.length || (c.length === g.length && c.reasons.length < g.reasons.length)) {
      Object.assign(g, { length: c.length, reasons: c.reasons, term: c.term, source });
    }
    g.matchedKanji ||= matchedKanji;
    return g;
  };

  for (const c of candidates) {
    const source = win.slice(0, c.length).join('');
    const h = toHiragana(c.term);
    // Built-in JMdict
    for (const e of [...(found.get(c.term) ?? []), ...(h !== c.term ? found.get(h) ?? [] : [])]) {
      if (c.conds.length) {
        const ec = entryConds(e);
        if (!c.conds.some((x) => ec.has(x))) continue;
      }
      const r = buildResult(e, c.term, source, c.length, c.reasons);
      if (!r) continue;
      const key = r.expression + '\u0000' + r.reading;
      const g = touch(key, () => ({ ...r, key, defIds: new Set() }), c, source, r.matchedKanji);
      const id = 'b' + e.id;
      if (!g.defIds.has(id)) {
        g.defIds.add(id);
        if (!g.entry) Object.assign(g, { entry: r.entry, senses: r.senses, common: g.common || r.common, priority: Math.min(g.priority, r.priority), alternates: r.alternates });
        g.definitions.push(...r.definitions);
      }
    }
    // Imported dictionaries
    for (const t of [...(yfound.get(c.term) ?? []), ...(h !== c.term ? yfound.get(h) ?? [] : [])]) {
      if (c.conds.length) {
        const tc = yomitanConds(t.rules, t.expression);
        if (!c.conds.some((x) => tc.has(x))) continue;
      }
      const key = t.expression + '\u0000' + t.reading;
      const matchedKanji = hasKanji(t.expression) && normalizeText(t.expression) === normalizeText(c.term);
      const g = touch(key, () => ({
        key, defIds: new Set(), matchedKanji, length: c.length, source, term: c.term, reasons: c.reasons,
        expression: t.expression, reading: t.reading, senses: [], definitions: [], frequencies: [], pitches: [],
        common: false, priority: 1000, score: t.score, alternates: [],
      }), c, source, matchedKanji);
      const id = 'y' + t.id;
      if (g.defIds.has(id)) continue;
      g.defIds.add(id);
      g.score = Math.max(g.score, t.score);
      if ([...t.termTags, ...t.definitionTags].some((x) => COMMON_TAGS.has(x))) g.common = true;
      g.definitions.push({ dict: t.dict, glossary: t.glossary, tags: t.definitionTags, termTags: t.termTags, score: t.score, sequence: t.sequence });
    }
  }

  const results = [...groups.values()];
  for (const g of results) g.definitions.sort((a, b) => rank(a.dict) - rank(b.dict) || b.score - a.score);

  // Frequency / pitch metadata
  if (src.meta && results.length) {
    const meta = await src.meta(results.map((g) => g.expression));
    for (const g of results) {
      for (const m of meta.get(g.expression) ?? []) {
        if (m.mode === 'freq') {
          const f = parseFrequency(m.data, g.reading);
          if (f) g.frequencies.push({ dict: m.dict, ...f });
        } else if (m.mode === 'pitch') {
          const d = m.data as { reading?: string; pitches?: PitchInfo[] };
          if (d?.reading && toHiragana(d.reading) === toHiragana(g.reading) && Array.isArray(d.pitches)) g.pitches.push({ dict: m.dict, reading: d.reading, pitches: d.pitches });
        }
      }
      g.frequencies.sort((a, b) => rank(a.dict) - rank(b.dict) || a.value - b.value);
      g.pitches.sort((a, b) => rank(a.dict) - rank(b.dict));
    }
  }

  const occ = src.occurrenceFreqDicts ?? new Set<string>();
  const freqCompare = (a: Group, b: Group) => {
    for (const fa of a.frequencies) {
      const fb = b.frequencies.find((f) => f.dict === fa.dict);
      if (fb && fa.value !== fb.value) return occ.has(fa.dict) ? fb.value - fa.value : fa.value - fb.value;
    }
    return 0;
  };
  const sourceHasKanji = hasKanji(win[0]);
  results.sort((a, b) =>
    b.length - a.length ||
    // Exact (non-deinflected) matches before deinflected ones of the same length
    a.reasons.length - b.reasons.length ||
    // Prefer kanji-form matches when the source starts with kanji
    (sourceHasKanji ? Number(b.matchedKanji) - Number(a.matchedKanji) : 0) ||
    freqCompare(a, b) ||
    Number(b.common) - Number(a.common) ||
    a.priority - b.priority ||
    b.score - a.score ||
    rank(a.definitions[0]?.dict ?? '') - rank(b.definitions[0]?.dict ?? '') ||
    (a.entry?.id ?? 0) - (b.entry?.id ?? 0),
  );
  return results.slice(0, maxResults).map(({ matchedKanji: _m, key: _k, defIds: _d, ...r }) => r as TermResult);
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
  const filtered = e.s.filter(
    (s) => (!s.sk || !kMatch || s.sk.includes(kMatch.t)) && (!s.sr || s.sr.includes(reading)),
  );
  const senses = filtered.length ? filtered : e.s;
  const forms = [kMatch ?? e.k[0], rMatch ?? e.r[0]].filter(Boolean);
  const common = forms.some((f) => f?.c) || e.k.some((k) => k.c) || e.r.some((r) => r.c);
  const priority = Math.min(...[...e.k, ...e.r].map((f) => f.p ?? 1000));
  const alternates = e.k.map((k) => k.t).filter((t) => t !== expression);
  return {
    entry: e, length, source, term, reasons, expression, reading, senses, common, priority, alternates, matchedKanji: !!kMatch,
    definitions: [{ dict: BUILTIN_DICT, senses, tags: [], termTags: common ? ['common'] : [], score: 0, sequence: e.id }],
    frequencies: [], pitches: [], score: 0,
  };
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
