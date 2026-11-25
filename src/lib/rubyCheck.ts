// Furigana in photos is tiny, so OCR often loses small kana (ちよつと for ちょっと), dakuten
// (すいぶん for ずいぶん) or a character. Since we know which kanji the furigana sits on, the
// dictionary tells us which readings are possible: snap the OCR'd reading to the closest one.
import { furiganaSegments, toHiragana } from './kana';
import type { Entry } from './db';

const SMALL: Record<string, string> = { ぁ: 'あ', ぃ: 'い', ぅ: 'う', ぇ: 'え', ぉ: 'お', っ: 'つ', ゃ: 'や', ゅ: 'ゆ', ょ: 'よ', ゎ: 'わ' };

/** Comparison key: hiragana, full-size kana, no voicing marks. */
export function looseKana(s: string): string {
  return Array.from(toHiragana(s).normalize('NFD').replace(/[゙゚]/g, '').normalize('NFC')).map((c) => SMALL[c] ?? c).join('');
}

function editDistance(a: string[], b: string[]): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return dp[a.length][b.length];
}

/** Readings the dictionary allows for exactly the characters `base` (e.g. 這入 in 這入る → はい). */
export function candidateReadings(base: string, entries: Entry[]): string[] {
  const out = new Set<string>();
  const n = Array.from(base).length;
  for (const e of entries) {
    for (const k of e.k) {
      if (!k.t.startsWith(base)) continue;
      for (const r of e.r) {
        if (r.n || (r.r && !r.r.includes(k.t))) continue;
        if (k.t === base) { out.add(r.t); continue; }
        // reading of the leading `base` characters, when it ends on a segment boundary
        let used = 0, reading = '';
        for (const seg of furiganaSegments(k.t, r.t)) {
          const len = Array.from(seg.t).length;
          if (used + len > n) { reading = ''; break; }
          reading += seg.r ?? seg.t;
          used += len;
          if (used === n) break;
        }
        if (used === n && reading) out.add(toHiragana(reading));
      }
    }
  }
  return [...out];
}

/**
 * Best dictionary reading for OCR'd furigana `ocr` over `base`, or null to keep it.
 * Differences in small kana / voicing marks are always fixed; one other differing character
 * only when exactly one reading is that close and the furigana is at least 3 kana long.
 */
export function snapReading(ocr: string, candidates: string[]): string | null {
  if (!candidates.length) return null;
  const oc = Array.from(looseKana(ocr));
  const strict = Array.from(toHiragana(ocr));
  const scored = candidates.map((c) => ({ c, d: editDistance(oc, Array.from(looseKana(c))), ds: editDistance(strict, Array.from(c)) }));
  const exact = scored.filter((x) => x.d === 0).sort((a, b) => a.ds - b.ds);
  if (exact.length) return exact[0].c;
  const near = scored.filter((x) => x.d === 1);
  if (near.length !== 1) return null;
  // Tiny furigana often loses a kana (てんし → てん); a wrong kana is only trusted in longer readings.
  const dropped = Array.from(looseKana(near[0].c)).length === oc.length + 1;
  return oc.length >= 3 || (dropped && oc.length >= 2) ? near[0].c : null;
}

export interface RubyPart { from: number; to: number; text: string }
export interface FuriganaCheck { parts: RubyPart[]; /** Kanji misread by OCR, fixed with the furigana's help. */ fix?: { i: number; c: string } }

/**
 * Checks furigana over `base` (characters `base`), possibly splitting it in two when one run of
 * furigana covers two words (一寸這入 / ちよつとはい → 一寸[ちょっと] 這入[はい]).
 * `lookup` returns dictionary entries for a prefix. Returns null to keep the OCR'd furigana.
 */
export async function checkFurigana(
  base: string,
  ocr: string,
  lookup: (prefix: string) => Promise<Entry[]>,
  alts: string[][] = [],
): Promise<FuriganaCheck | null> {
  const chars = Array.from(base);
  const whole = snapReading(ocr, candidateReadings(base, await lookup(base)));
  if (whole) return { parts: [{ from: 0, to: chars.length, text: whole }] };
  // The kanji may be misread instead: try OCR's runner-up characters (説論 + せつゆ → 説諭).
  if (Array.from(looseKana(ocr)).length >= 2) {
    for (let i = 0; i < chars.length; i++) {
      for (const a of (alts[i] ?? []).slice(0, 4)) {
        const variant = [...chars.slice(0, i), a, ...chars.slice(i + 1)].join('');
        const hit = candidateReadings(variant, await lookup(variant)).find((c) => looseKana(c) === looseKana(ocr));
        if (hit) return { parts: [{ from: 0, to: chars.length, text: hit }], fix: { i, c: a } };
      }
    }
  }
  if (chars.length < 2) return null;
  const o = Array.from(ocr);
  for (let i = 1; i < chars.length; i++) {
    const left = chars.slice(0, i).join(''), right = chars.slice(i).join('');
    const [lc, rc] = [candidateReadings(left, await lookup(left)), candidateReadings(right, await lookup(right))];
    if (!lc.length || !rc.length) continue;
    for (let j = 1; j < o.length; j++) {
      const a = o.slice(0, j).join(''), b = o.slice(j).join('');
      const la = lc.find((c) => looseKana(c) === looseKana(a));
      const rb = rc.find((c) => looseKana(c) === looseKana(b));
      // Only split when it corrects the reading; otherwise keep the furigana as one group.
      if (la && rb && la + rb !== ocr) return { parts: [{ from: 0, to: i, text: la }, { from: i, to: chars.length, text: rb }] };
      if (la && rb) return null;
    }
  }
  return null;
}
