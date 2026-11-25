// Kana / kanji helpers. All functions are code-point aware so supplementary-plane
// kanji (CJK Extension B and beyond, e.g. 𠮷) are handled as single characters.

const HAN_RE = /\p{Script=Han}/u;
const KANA_RE = /[\p{Script=Hiragana}\p{Script=Katakana}ー]/u;
const JAPANESE_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー々〆〇ヵヶ]/u;

export function chars(s: string): string[] {
  return Array.from(s);
}

export function isKanji(c: string): boolean {
  return HAN_RE.test(c) || c === '々' || c === '〆' || c === 'ヶ';
}

export function isKana(c: string): boolean {
  return KANA_RE.test(c);
}

export function isJapanese(c: string): boolean {
  return JAPANESE_RE.test(c);
}

export function hasKanji(s: string): boolean {
  for (const c of s) if (isKanji(c)) return true;
  return false;
}

export function isHiragana(c: string): boolean {
  const cp = c.codePointAt(0)!;
  return cp >= 0x3041 && cp <= 0x3096;
}

export function isKatakana(c: string): boolean {
  const cp = c.codePointAt(0)!;
  return cp >= 0x30a1 && cp <= 0x30f6;
}

export function toHiragana(s: string): string {
  let out = '';
  for (const c of s) {
    const cp = c.codePointAt(0)!;
    out += cp >= 0x30a1 && cp <= 0x30f6 ? String.fromCodePoint(cp - 0x60) : c;
  }
  return out;
}

export function toKatakana(s: string): string {
  let out = '';
  for (const c of s) {
    const cp = c.codePointAt(0)!;
    out += cp >= 0x3041 && cp <= 0x3096 ? String.fromCodePoint(cp + 0x60) : c;
  }
  return out;
}

const HALF_KATA = 'ｦｧｨｩｪｫｬｭｮｯｰｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ';
const FULL_KATA = 'ヲァィゥェォャュョッーアイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワン';

/**
 * Normalizes OCR / user text for dictionary lookup:
 *  - NFC (maps CJK Compatibility Ideographs U+F900.. to their unified forms)
 *  - half-width katakana -> full-width (with voicing marks)
 *  - full-width ASCII -> ASCII
 */
export function normalizeText(s: string): string {
  let out = '';
  const arr = Array.from(s.normalize('NFC'));
  for (let i = 0; i < arr.length; i++) {
    const c = arr[i];
    const hk = HALF_KATA.indexOf(c);
    if (hk >= 0) {
      let k = FULL_KATA[hk];
      const next = arr[i + 1];
      if (next === 'ﾞ') { k = String.fromCodePoint(k.codePointAt(0)! + 1); i++; }
      else if (next === 'ﾟ') { k = String.fromCodePoint(k.codePointAt(0)! + 2); i++; }
      out += k;
      continue;
    }
    const cp = c.codePointAt(0)!;
    if (cp >= 0xff01 && cp <= 0xff5e) { out += String.fromCodePoint(cp - 0xfee0); continue; }
    if (c === '·' || c === '•') { out += '・'; continue; }
    out += c;
  }
  return out;
}

/**
 * Splits an expression/reading pair into furigana segments, e.g.
 * 食べ物 / たべもの -> [{t:'食', r:'た'}, {t:'べ'}, {t:'物', r:'もの'}]
 */
export interface FuriSeg { t: string; r?: string }

export function furiganaSegments(expression: string, reading: string): FuriSeg[] {
  if (!reading || expression === reading || !hasKanji(expression)) return [{ t: expression }];
  // Group expression into alternating kanji / kana runs.
  const groups: { t: string; kanji: boolean }[] = [];
  for (const c of expression) {
    const k = isKanji(c) || !isKana(c);
    const last = groups[groups.length - 1];
    if (last && last.kanji === k) last.t += c;
    else groups.push({ t: c, kanji: k });
  }
  const result = segment(groups, 0, toHiragana(reading), reading);
  return result ?? [{ t: expression, r: reading }];
}

function segment(groups: { t: string; kanji: boolean }[], gi: number, readingH: string, reading: string): FuriSeg[] | null {
  if (gi === groups.length) return readingH.length === 0 ? [] : null;
  const g = groups[gi];
  if (!g.kanji) {
    const kanaH = toHiragana(g.t);
    if (!readingH.startsWith(kanaH)) return null;
    const rest = segment(groups, gi + 1, readingH.slice(kanaH.length), reading.slice(kanaH.length));
    return rest ? [{ t: g.t }, ...rest] : null;
  }
  // kanji run: try every split length (at least one kana per kanji run)
  const maxLen = readingH.length - remainingMinKana(groups, gi + 1);
  for (let len = 1; len <= maxLen; len++) {
    const rest = segment(groups, gi + 1, readingH.slice(len), reading.slice(len));
    if (rest) return [{ t: g.t, r: reading.slice(0, len) }, ...rest];
  }
  return null;
}

function remainingMinKana(groups: { t: string; kanji: boolean }[], from: number): number {
  let n = 0;
  for (let i = from; i < groups.length; i++) n += groups[i].kanji ? 1 : groups[i].t.length;
  return n;
}

/** Anki-style furigana: 食[た]べ 物[もの] */
export function ankiFurigana(expression: string, reading: string): string {
  return furiganaSegments(expression, reading)
    .map((s, i) => (s.r ? `${i > 0 ? ' ' : ''}${s.t}[${s.r}]` : s.t))
    .join('');
}

/** HTML ruby furigana. */
export function rubyHtml(expression: string, reading: string): string {
  return furiganaSegments(expression, reading)
    .map((s) => (s.r ? `<ruby>${escapeHtml(s.t)}<rt>${escapeHtml(s.r)}</rt></ruby>` : escapeHtml(s.t)))
    .join('');
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
