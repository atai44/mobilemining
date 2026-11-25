// Renders Yomitan glossary items (plain strings, structured content, images) to sanitized HTML.
// Mirrors Yomitan's output (`gloss-sc-*` classes and `data-sc-*` attributes) so dictionary
// styles.css files written for Yomitan apply unchanged.
import { escapeHtml } from '../kana';
import type { GlossaryItem, StructuredContent, StructuredElement } from './types';

export interface RenderOptions {
  dict: string;
  /** 'placeholder': <img data-media> resolved later from IndexedDB; 'alt': replace images with their alt text. */
  images: 'placeholder' | 'alt';
}

const CONTAINER_TAGS = new Set(['ruby', 'rt', 'rp', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'span', 'div', 'ol', 'ul', 'li', 'details', 'summary']);

const STYLE_PROPS: Record<string, string> = {
  fontStyle: 'font-style', fontWeight: 'font-weight', fontSize: 'font-size', color: 'color', background: 'background',
  backgroundColor: 'background-color', textDecorationLine: 'text-decoration-line', textDecorationStyle: 'text-decoration-style',
  textDecorationColor: 'text-decoration-color', borderColor: 'border-color', borderStyle: 'border-style', borderRadius: 'border-radius',
  borderWidth: 'border-width', clipPath: 'clip-path', verticalAlign: 'vertical-align', textAlign: 'text-align', textEmphasis: 'text-emphasis',
  textShadow: 'text-shadow', margin: 'margin', marginTop: 'margin-top', marginLeft: 'margin-left', marginRight: 'margin-right',
  marginBottom: 'margin-bottom', padding: 'padding', paddingTop: 'padding-top', paddingLeft: 'padding-left', paddingRight: 'padding-right',
  paddingBottom: 'padding-bottom', wordBreak: 'word-break', whiteSpace: 'white-space', cursor: 'cursor', listStyleType: 'list-style-type',
};
const NUMERIC_EM = new Set(['marginTop', 'marginLeft', 'marginRight', 'marginBottom']);

function safeCssValue(v: string): string | null {
  return /url\s*\(|expression\s*\(|[<>;{}\\]|@import|javascript:/i.test(v) ? null : v;
}

function styleAttr(style: StructuredElement['style']): string {
  if (!style) return '';
  const parts: string[] = [];
  for (const [k, raw] of Object.entries(style)) {
    const prop = STYLE_PROPS[k];
    if (!prop || raw === undefined || raw === null) continue;
    let v = Array.isArray(raw) ? raw.join(' ') : typeof raw === 'number' ? (NUMERIC_EM.has(k) ? `${raw}em` : String(raw)) : String(raw);
    const safe = safeCssValue(v);
    if (safe === null) continue;
    v = safe;
    parts.push(`${prop}:${v}`);
  }
  return parts.length ? ` style="${escapeHtml(parts.join(';'))}"` : '';
}

/** Yomitan sets node.dataset[`sc${Key}`] = value, i.e. attribute data-sc-<kebab-key>. */
function dataAttrs(data: StructuredElement['data']): string {
  if (!data || typeof data !== 'object') return '';
  let out = '';
  for (const [k, v] of Object.entries(data)) {
    if (typeof v !== 'string' || !k) continue;
    const dsKey = 'sc' + k[0].toUpperCase() + k.slice(1);
    const attr = 'data-' + dsKey.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
    if (!/^data-[a-z0-9-]+$/.test(attr)) continue;
    out += ` ${attr}="${escapeHtml(v)}"`;
  }
  return out;
}

function textHtml(s: string): string {
  return escapeHtml(s).replace(/\n/g, '<br>');
}

function imageHtml(el: { path: string; width?: number; height?: number; title?: string; alt?: string; description?: string; sizeUnits?: string; pixelated?: boolean; imageRendering?: string; verticalAlign?: string; appearance?: string }, opts: RenderOptions, inline: boolean): string {
  if (opts.images === 'alt') return el.alt || el.description ? escapeHtml(el.alt || el.description || '') : '';
  const unit = el.sizeUnits === 'em' ? 'em' : 'px';
  const styles: string[] = [];
  if (el.width) styles.push(`width:${el.width}${unit}`);
  if (el.height) styles.push(`height:${el.height}${unit}`);
  if (!el.width && !el.height) styles.push('max-width:100%');
  if (el.pixelated || el.imageRendering === 'pixelated') styles.push('image-rendering:pixelated');
  else if (el.imageRendering === 'crisp-edges') styles.push('image-rendering:crisp-edges');
  if (el.verticalAlign && /^[a-z-]+$/.test(el.verticalAlign)) styles.push(`vertical-align:${el.verticalAlign}`);
  if (el.appearance === 'monochrome') styles.push('filter:grayscale(1)');
  return `<img class="gloss-image${inline ? ' gloss-image-inline' : ''}" data-media-dict="${escapeHtml(opts.dict)}" data-media-path="${escapeHtml(el.path)}" alt="${escapeHtml(el.alt ?? '')}"${el.title ? ` title="${escapeHtml(el.title)}"` : ''} style="${styles.join(';')}">`;
}

export function renderStructured(node: StructuredContent | undefined, opts: RenderOptions, lang?: string): string {
  if (node === undefined || node === null) return '';
  if (typeof node === 'string') return textHtml(node);
  if (Array.isArray(node)) return node.map((n) => renderStructured(n, opts, lang)).join('');
  if (typeof node !== 'object') return '';
  const el = node as StructuredElement;
  const tag = el.tag;
  if (tag === 'br') return '<br>';
  if (tag === 'img') return el.path ? imageHtml(el as StructuredElement & { path: string }, opts, true) : '';
  const langAttr = el.lang && /^[a-zA-Z-]+$/.test(el.lang) ? ` lang="${el.lang}"` : '';
  const inner = renderStructured(el.content, opts, el.lang ?? lang);
  if (tag === 'a') {
    const href = typeof el.href === 'string' ? el.href : '';
    if (href.startsWith('?')) {
      const q = new URLSearchParams(href.slice(1)).get('query') ?? '';
      return `<a class="gloss-link" data-query="${escapeHtml(q)}" href="#"${langAttr}>${inner}</a>`;
    }
    if (/^https?:/i.test(href)) return `<a class="gloss-link" href="${escapeHtml(href)}" target="_blank" rel="noreferrer noopener"${langAttr}>${inner}</a>`;
    return inner;
  }
  if (!CONTAINER_TAGS.has(tag)) return inner;
  let attrs = ` class="gloss-sc-${tag}"${langAttr}${dataAttrs(el.data)}`;
  if (tag === 'td' || tag === 'th') {
    if (el.colSpan) attrs += ` colspan="${Number(el.colSpan) | 0}"`;
    if (el.rowSpan) attrs += ` rowspan="${Number(el.rowSpan) | 0}"`;
  }
  if (['td', 'th', 'span', 'div', 'ol', 'ul', 'li', 'details', 'summary'].includes(tag)) attrs += styleAttr(el.style);
  if (el.title) attrs += ` title="${escapeHtml(el.title)}"`;
  if (tag === 'details' && el.open) attrs += ' open';
  const html = `<${tag}${attrs}>${inner}</${tag}>`;
  return tag === 'table' ? `<div class="gloss-sc-table-container">${html}</div>` : html;
}

export function renderGlossaryItem(item: GlossaryItem, opts: RenderOptions): string {
  if (typeof item === 'string') return textHtml(item);
  if (Array.isArray(item)) return `<span class="gloss-deinflection">→ ${escapeHtml(String(item[0]))}</span>`;
  if (!item || typeof item !== 'object') return '';
  if (item.type === 'text') return textHtml(item.text);
  if (item.type === 'image') return imageHtml(item, opts, false);
  if (item.type === 'structured-content') return `<span class="gloss-sc" data-dictionary="${escapeHtml(opts.dict)}">${renderStructured(item.content, opts)}</span>`;
  return '';
}

/** Plain text of a glossary item (for brief/plain markers and search). */
export function glossaryText(item: GlossaryItem): string {
  if (typeof item === 'string') return item;
  if (Array.isArray(item)) return '';
  if (item?.type === 'text') return item.text;
  if (item?.type === 'structured-content') return structuredText(item.content).replace(/\s+\n/g, '\n').trim();
  return '';
}

function structuredText(node: StructuredContent | undefined): string {
  if (node === undefined || node === null) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(structuredText).join('');
  if (node.tag === 'rt' || node.tag === 'rp' || node.tag === 'img') return '';
  if (node.tag === 'br') return '\n';
  const inner = structuredText(node.content);
  return ['div', 'li', 'tr', 'ol', 'ul', 'details', 'summary'].includes(node.tag) ? inner + '\n' : inner;
}

/**
 * Scopes a dictionary's styles.css to its own content, like Yomitan does, so one dictionary's
 * styles cannot affect the app or another dictionary.
 */
export function scopeDictionaryCss(css: string, dict: string): string {
  const scope = `[data-dictionary="${dict.replace(/["\\]/g, '\\$&')}"]`;
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    const rules: string[] = [];
    const walk = (list: CSSRuleList, wrap: (s: string) => string) => {
      for (const rule of Array.from(list)) {
        if (rule instanceof CSSStyleRule) {
          const sel = rule.selectorText.split(',').map((s) => `${scope} ${s.trim()}`).join(', ');
          rules.push(wrap(`${sel} { ${rule.style.cssText.replace(/url\([^)]*\)/gi, 'none')} }`));
        } else if (rule instanceof CSSMediaRule) {
          walk(rule.cssRules, (r) => wrap(`@media ${rule.conditionText} { ${r} }`));
        }
      }
    };
    walk(sheet.cssRules, (r) => r);
    return rules.join('\n');
  } catch {
    return '';
  }
}
