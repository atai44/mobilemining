// Pitch accent helpers: mora splitting, downstep patterns and HTML rendering (inline styles so
// the markup also renders inside Anki).
import { escapeHtml } from './kana';
import type { PitchInfo } from './yomitan/types';

const SMALL = new Set(Array.from('ゃゅょぁぃぅぇぉゎャュョァィゥェォヮ'));

export function morae(reading: string): string[] {
  const out: string[] = [];
  for (const c of reading) {
    if (SMALL.has(c) && out.length) out[out.length - 1] += c;
    else out.push(c);
  }
  return out;
}

/** High/low pattern for each mora, plus one extra entry for a following particle. */
export function pitchPattern(position: number | string, moraCount: number): boolean[] {
  if (typeof position === 'string') return Array.from(position).map((c) => c === 'H');
  const out: boolean[] = [];
  for (let i = 0; i <= moraCount; i++) {
    if (position === 0) out.push(i > 0);
    else if (position === 1) out.push(i === 0);
    else out.push(i > 0 && i < position);
  }
  return out;
}

export function downstepPosition(position: number | string): number {
  if (typeof position === 'number') return position;
  const i = position.indexOf('HL');
  if (i >= 0) return i + 1;
  return position.startsWith('H') ? 1 : 0;
}

export function pitchCategory(reading: string, position: number | string, isVerbOrAdj = false): string {
  const n = morae(reading).length;
  const p = downstepPosition(position);
  if (p === 0) return 'heiban';
  if (isVerbOrAdj) return 'kifuku';
  if (p === 1) return 'atamadaka';
  if (p === n) return 'odaka';
  return 'nakadaka';
}

/** Overline notation: high morae get a top border, the downstep gets a right border. */
export function pitchHtml(reading: string, info: PitchInfo): string {
  const m = morae(reading);
  const pattern = pitchPattern(info.position, m.length);
  const parts = m.map((mora, i) => {
    const high = pattern[i];
    const drop = high && pattern[i + 1] === false;
    const style = [high ? 'border-top:1px solid currentColor' : '', drop ? 'border-right:1px solid currentColor' : ''].filter(Boolean).join(';');
    return style ? `<span style="${style}">${escapeHtml(mora)}</span>` : escapeHtml(mora);
  });
  return `<span class="pitch" style="display:inline-block;line-height:1.6">${parts.join('')}</span>`;
}
