// Page layout for mixed text directions: groups lines into blocks (a vertical body, a
// horizontal heading, a caption, a speech bubble...), orders lines inside each block by that
// block's own direction, orders the blocks, and assigns the separator placed before each line:
//   ''   same row/column continued (detector split a line)
//   ' '  same row/column with a visible gap
//   '\n' next line in the same block (soft break: sentences and words can continue)
//   '\n\n' next block (hard break)
import type { OcrLine } from './types';

export type Sep = '' | ' ' | '\n' | '\n\n';
export interface LaidOutLine extends OcrLine { sep: Sep; block: number }

interface Box { x0: number; y0: number; x1: number; y1: number }
const boxOf = (l: OcrLine): Box => ({ x0: l.box.x, y0: l.box.y, x1: l.box.x + l.box.w, y1: l.box.y + l.box.h });
const thick = (l: OcrLine) => Math.hypot(l.quad[3].x - l.quad[0].x, l.quad[3].y - l.quad[0].y);

/** Overlap of [a0,a1] and [b0,b1] relative to the shorter one. */
function overlapRatio(a0: number, a1: number, b0: number, b1: number): number {
  const o = Math.min(a1, b1) - Math.max(a0, b0);
  return o / Math.max(1, Math.min(a1 - a0, b1 - b0));
}

/** Across-axis and along-axis intervals in the line's reading frame (axis-aligned approximation). */
function frame(l: OcrLine) {
  const b = boxOf(l);
  return l.vertical
    ? { across: [b.x0, b.x1] as const, along: [b.y0, b.y1] as const }
    : { across: [b.y0, b.y1] as const, along: [b.x0, b.x1] as const };
}

/** Same row (horizontal) / same column (vertical): a line the detector split in two. */
function continues(a: OcrLine, b: OcrLine): number | null {
  const fa = frame(a), fb = frame(b);
  if (overlapRatio(fa.across[0], fa.across[1], fb.across[0], fb.across[1]) < 0.6) return null;
  const t = Math.max(thick(a), thick(b));
  if (Math.min(thick(a), thick(b)) < t * 0.6) return null;
  const gap = Math.max(fb.along[0] - fa.along[1], fa.along[0] - fb.along[1]);
  return gap < t * 1.6 ? gap : null;
}

/** Neighbouring lines of one paragraph: side by side across, overlapping along, similar size. */
function adjacent(a: OcrLine, b: OcrLine): boolean {
  const fa = frame(a), fb = frame(b);
  const ta = thick(a), tb = thick(b);
  if (Math.min(ta, tb) < Math.max(ta, tb) * 0.65) return false;
  const gap = Math.max(fb.across[0] - fa.across[1], fa.across[0] - fb.across[1]);
  if (gap > Math.max(ta, tb) * 1.1) return false;
  return overlapRatio(fa.along[0], fa.along[1], fb.along[0], fb.along[1]) > 0.25 || Math.abs(fa.along[0] - fb.along[0]) < Math.max(ta, tb);
}

export function layoutLines(lines: OcrLine[]): LaidOutLine[] {
  const n = lines.length;
  if (!n) return [];
  // Union-find into blocks
  const parent = lines.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const a = lines[i], b = lines[j];
    if (a.vertical !== b.vertical) continue;
    if (continues(a, b) !== null || adjacent(a, b)) parent[find(i)] = find(j);
  }
  const groups = new Map<number, number[]>();
  lines.forEach((_, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), i]));

  const vertChars = lines.reduce((s, l) => s + (l.vertical ? l.chars.length : 0), 0);
  const pageVertical = vertChars > lines.reduce((s, l) => s + l.chars.length, 0) / 2;

  // Order lines inside each block: rows top→bottom (left→right within), columns right→left (top→bottom within)
  const blocks = [...groups.values()].map((idx) => {
    const v = lines[idx[0]].vertical;
    const key = (i: number) => (v ? -(lines[i].box.x + lines[i].box.w / 2) : lines[i].box.y + lines[i].box.h / 2);
    const sorted = [...idx].sort((a, b) => key(a) - key(b));
    const rows: number[][] = [];
    for (const i of sorted) {
      const row = rows[rows.length - 1];
      if (row && row.some((j) => { const fa = frame(lines[j]), fb = frame(lines[i]); return overlapRatio(fa.across[0], fa.across[1], fb.across[0], fb.across[1]) > 0.5; })) row.push(i);
      else rows.push([i]);
    }
    for (const row of rows) row.sort((a, b) => (v ? lines[a].box.y - lines[b].box.y : lines[a].box.x - lines[b].box.x));
    const b = idx.map((i) => boxOf(lines[i])).reduce((u, x) => ({ x0: Math.min(u.x0, x.x0), y0: Math.min(u.y0, x.y0), x1: Math.max(u.x1, x.x1), y1: Math.max(u.y1, x.y1) }));
    return { rows, box: b, vertical: v };
  });

  // Order blocks: bands top→bottom; within a band right→left on vertical pages, else left→right.
  blocks.sort((a, b) => a.box.y0 - b.box.y0);
  const bands: (typeof blocks)[] = [];
  for (const blk of blocks) {
    const band = bands.find((bd) => bd.some((o) => overlapRatio(o.box.y0, o.box.y1, blk.box.y0, blk.box.y1) > 0.5));
    if (band) band.push(blk);
    else bands.push([blk]);
  }
  bands.sort((a, b) => Math.min(...a.map((x) => x.box.y0)) - Math.min(...b.map((x) => x.box.y0)));
  const ordered = bands.flatMap((bd) => bd.sort((a, b) => (pageVertical ? b.box.x1 - a.box.x1 : a.box.x0 - b.box.x0)));

  const out: LaidOutLine[] = [];
  ordered.forEach((blk, bi) => {
    blk.rows.forEach((row, ri) => {
      row.forEach((i, k) => {
        let sep: Sep = '\n';
        if (out.length === 0) sep = '';
        else if (ri === 0 && k === 0) sep = '\n\n';
        else if (k > 0) {
          const gap = continues(lines[row[k - 1]], lines[i]);
          sep = gap !== null && gap > thick(lines[i]) * 0.45 ? ' ' : '';
        }
        out.push({ ...lines[i], sep, block: bi });
      });
    });
  });
  return out;
}
