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

/** Yomitan's downstep notation as its Anki templates write it: [6]. */
export function pitchPositionHtml(position: number | string): string {
  return `<span style="display:inline;"><span>[</span><span>${downstepPosition(position)}</span><span>]</span></span>`;
}

/** Yomitan's pitch graph (dots joined by a line, a triangle for the following particle), with inline styles. */
export function pitchGraphSvg(reading: string, position: number | string): string {
  const n = morae(reading).length;
  if (!n) return '';
  const pattern = pitchPattern(position, n);
  const line = 'fill:none;stroke-width:5;stroke:currentColor;';
  const dot = 'stroke-width:5;fill:currentColor;stroke:currentColor;';
  const points: string[] = [];
  let dots = '';
  for (let i = 0; i < n; i++) {
    const x = i * 50 + 25, y = pattern[i] ? 25 : 75;
    points.push(`${x} ${y}`);
    dots += pattern[i] && !pattern[i + 1]
      ? `<circle cx="${x}" cy="${y}" r="15" style="${line}"></circle><circle cx="${x}" cy="${y}" r="5" style="fill:currentColor;"></circle>`
      : `<circle cx="${x}" cy="${y}" r="15" style="${dot}"></circle>`;
  }
  const tx = n * 50 + 25, ty = pattern[n] ? 25 : 75;
  return `<svg xmlns="http://www.w3.org/2000/svg" focusable="false" viewBox="0 0 ${50 * (n + 1)} 100" style="display:inline-block;vertical-align:middle;height:1.5em;">`
    + `<path d="M${points.join(' L')}" style="${line}"></path>`
    + `<path d="M${points[n - 1]} L${tx} ${ty}" style="${line}stroke-dasharray:5 5;"></path>`
    + dots
    + `<path d="M0 13 L15 -13 L-15 -13 Z" transform="translate(${tx},${ty})" style="${line}"></path></svg>`;
}
