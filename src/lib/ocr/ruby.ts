// Furigana in photos is detected as separate, thinner lines of kana next to the main text
// (to the right of vertical columns, above horizontal lines). Left alone they end up spliced
// between lines of text. This finds them by geometry and either attaches them as ruby to the
// kanji they annotate, or drops them.
import { isKana, isKanji } from '../kana';
import type { OcrLine, Point, Ruby } from './types';

export type FuriganaMode = 'ruby' | 'remove' | 'keep';

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const thickness = (l: OcrLine) => dist(l.quad[0], l.quad[3]);

function kanaRatio(l: OcrLine): number {
  const cs = l.chars.filter((c) => c.c.trim() && !/[・ー〜。、]/.test(c.c));
  if (!cs.length) return 0;
  return cs.filter((c) => isKana(c.c)).length / cs.length;
}

/**
 * Index of the main line that `r` annotates, or -1.
 *
 * Works in each candidate line's own (rotated) reading frame, so tilted or slightly curved
 * photos don't confuse neighbouring lines: furigana always sits on the "top" side of its base
 * (above horizontal lines, right of vertical columns), i.e. at a negative offset along the
 * frame's normal, roughly half a base-thickness plus half a ruby-thickness away.
 */
function findBase(lines: OcrLine[], ri: number): number {
  const r = lines[ri];
  if (r.chars.length > 40) return -1;
  const mostlyKana = kanaRatio(r) >= 0.75;
  const tr = thickness(r);
  const rLen = dist(r.quad[0], r.quad[1]);
  const rubySize = Math.min(tr, rLen / Math.max(1, r.chars.length));
  const rc = centre(r);
  // Ruby extent along its own axis (used to require overlap with the base)
  const rEnds = [mix(r.quad[0], r.quad[3], 0.5), mix(r.quad[1], r.quad[2], 0.5)];
  let best = -1, bestScore = Infinity;
  lines.forEach((b, bi) => {
    if (bi === ri || b.vertical !== r.vertical || !b.chars.length) return;
    const tb = thickness(b);
    if (tr > tb * 0.95 || rubySize > tb * 0.72) return;
    // A tiny 1–3 character "line" right where furigana goes is furigana even if OCR misread it as kanji.
    if (!mostlyKana && !(r.chars.length <= 3 && rubySize <= tb * 0.6)) return;
    const L = Math.max(dist(b.quad[0], b.quad[1]), 1);
    const axis = { x: (b.quad[1].x - b.quad[0].x) / L, y: (b.quad[1].y - b.quad[0].y) / L };
    const nrm = { x: (b.quad[3].x - b.quad[0].x) / tb, y: (b.quad[3].y - b.quad[0].y) / tb };
    const m0 = mix(b.quad[0], b.quad[3], 0.5);
    const along = (p: Point) => ((p.x - m0.x) * axis.x + (p.y - m0.y) * axis.y) / L;
    // overlap along the base
    const [s0, s1] = rEnds.map(along).sort((x, y) => x - y);
    const ov = Math.min(s1, 1) - Math.max(s0, 0);
    if (ov < (s1 - s0) * 0.5 - 0.02) return;
    // perpendicular offset of the ruby centre from the base centre line
    const o = (rc.x - m0.x) * nrm.x + (rc.y - m0.y) * nrm.y;
    const expected = -(tb + tr) / 2;
    if (o > -tb * 0.2 || o < expected - tb * 0.45) return;
    const score = Math.abs(o - expected);
    if (score < bestScore) { bestScore = score; best = bi; }
  });
  return best;
}

const mix = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const centre = (l: OcrLine): Point => ({
  x: (l.quad[0].x + l.quad[1].x + l.quad[2].x + l.quad[3].x) / 4,
  y: (l.quad[0].y + l.quad[1].y + l.quad[2].y + l.quad[3].y) / 4,
});

function charPositions(l: OcrLine): number[] {
  const n = l.chars.length;
  return l.chars.map((c, i) => c.u ?? (i + 0.5) / n);
}

/** Projects ruby characters onto the base line's reading axis and assigns them to kanji runs. */
export function attachRuby(base: OcrLine, ruby: OcrLine): Ruby[] {
  const [b0, b1] = base.quad;
  const L = Math.max(dist(b0, b1), 1);
  const dir = { x: (b1.x - b0.x) / L, y: (b1.y - b0.y) / L };
  const [r0, r1, , r3] = ruby.quad;
  const mid = { x: (r3.x - r0.x) / 2, y: (r3.y - r0.y) / 2 };
  const rubyPos = charPositions(ruby).map((u) => {
    const p = { x: r0.x + u * (r1.x - r0.x) + mid.x, y: r0.y + u * (r1.y - r0.y) + mid.y };
    return ((p.x - b0.x) * dir.x + (p.y - b0.y) * dir.y) / L;
  });
  const basePos = charPositions(base);
  const diffs = basePos.slice(1).map((v, i) => v - basePos[i]).sort((a, b) => a - b);
  const pitch = diffs.length ? diffs[Math.floor(diffs.length / 2)] : 1 / Math.max(base.chars.length, 1);

  // Split ruby characters into clusters, one per annotated word.
  const order = rubyPos.map((s, i) => ({ s, c: ruby.chars[i].c })).sort((a, b) => a.s - b.s);
  const clusters: { s0: number; s1: number; text: string }[] = [];
  for (const o of order) {
    const last = clusters[clusters.length - 1];
    if (last && o.s - last.s1 <= pitch * 0.85) { last.s1 = o.s; last.text += o.c; }
    else clusters.push({ s0: o.s, s1: o.s, text: o.c });
  }

  const out: Ruby[] = [];
  for (const cl of clusters) {
    const centre = (cl.s0 + cl.s1) / 2;
    const near = basePos
      .map((u, i) => ({ u, i }))
      .filter(({ u }) => u >= cl.s0 - pitch * 0.75 && u <= cl.s1 + pitch * 0.75);
    if (!near.length) continue;
    const kanji = near.filter(({ i }) => isKanji(base.chars[i].c));
    let from: number, to: number;
    if (kanji.length) {
      // contiguous kanji run around the kanji closest to the cluster centre
      const seed = kanji.reduce((a, b) => (Math.abs(b.u - centre) < Math.abs(a.u - centre) ? b : a)).i;
      from = seed; to = seed + 1;
      while (from > 0 && isKanji(base.chars[from - 1].c) && basePos[from - 1] >= cl.s0 - pitch * 0.75) from--;
      while (to < base.chars.length && isKanji(base.chars[to].c) && basePos[to] <= cl.s1 + pitch * 0.75) to++;
    } else {
      from = near[0].i; to = near[near.length - 1].i + 1;
    }
    const prev = out[out.length - 1];
    if (prev && prev.from === from && prev.to === to) prev.text += cl.text;
    else if (!out.some((r) => from < r.to && to > r.from)) out.push({ from, to, text: cl.text });
  }
  out.sort((a, b) => a.from - b.from);
  return mergeAdjacent(out).map((r) => ({ ...r, text: cleanRubyText(r.text) })).filter((r) => r.text);
}

/** Furigana spread one kana per kanji (薔[ば]薇[ら]) belongs to one word: group adjacent runs. */
function mergeAdjacent(rubies: Ruby[]): Ruby[] {
  const merged: Ruby[] = [];
  for (const r of [...rubies].sort((a, b) => a.from - b.from)) {
    const last = merged[merged.length - 1];
    if (last && r.from < last.to) continue; // overlapping: keep the first
    if (last && last.to === r.from) { last.to = r.to; last.text += r.text; }
    else merged.push({ ...r });
  }
  return merged;
}

const SMALL_VOWELS: Record<string, string> = { ぁ: 'あ', ぃ: 'い', ぅ: 'う', ぇ: 'え', ぉ: 'お' };

/**
 * Furigana is tiny, so OCR misreads are common. Keep only kana, and turn small hiragana vowels
 * (which essentially never occur in furigana) into full-size ones: きのぅ -> きのう.
 */
export function cleanRubyText(t: string): string {
  return Array.from(t).filter((c) => isKana(c)).map((c) => SMALL_VOWELS[c] ?? c).join('');
}

/** Removes furigana lines from `lines`, attaching them as ruby when mode is 'ruby'. */
export function processFurigana(lines: OcrLine[], mode: FuriganaMode): OcrLine[] {
  if (mode === 'keep' || lines.length < 2) return lines;
  const bases = lines.map((_, i) => findBase(lines, i));
  const rubyOf = new Map<number, number[]>();
  bases.forEach((b, ri) => {
    // A line can't be both furigana and the base of other furigana.
    if (b >= 0 && bases[b] < 0) rubyOf.set(b, [...(rubyOf.get(b) ?? []), ri]);
  });
  const isRuby = new Set([...rubyOf.values()].flat());
  return lines
    .map((l, i) => {
      if (mode !== 'ruby' || !rubyOf.has(i)) return l;
      return { ...l, ruby: mergeAdjacent(rubyOf.get(i)!.flatMap((ri) => attachRuby(l, lines[ri]))) };
    })
    .filter((_, i) => !isRuby.has(i));
}
