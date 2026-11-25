import { describe, expect, it } from 'vitest';
import { convertKanjiRow, convertTermRow } from '../../src/lib/yomitan/importer';
import { renderGlossaryItem, renderStructured, glossaryText } from '../../src/lib/yomitan/render';
import { findTerms, parseFrequency, yomitanConds } from '../../src/lib/lookup';
import { buildMarkerValues, fillTemplate, guessMarker, notesToTsv } from '../../src/lib/anki';
import { pitchCategory, pitchHtml, pitchPattern, morae } from '../../src/lib/pitch';
import { applyYomitanProfile, parseYomitanSettings } from '../../src/lib/yomitan/settingsImport';
import { DEFAULT_SETTINGS } from '../../src/lib/settings';
import { attachRuby, processFurigana } from '../../src/lib/ocr/ruby';
import { chars } from '../../src/lib/kana';
import type { YTerm, YTermMeta } from '../../src/lib/yomitan/types';
import type { OcrLine } from '../../src/lib/ocr/types';

describe('Yomitan importer rows', () => {
  it('converts v3 term rows', () => {
    const t = convertTermRow(['読む', 'よむ', 'v5 vt', 'v5', 10, ['to read'], 123, 'P'], 'D', 3);
    expect(t).toMatchObject({ expression: '読む', reading: 'よむ', definitionTags: ['v5', 'vt'], rules: ['v5'], score: 10, glossary: ['to read'], sequence: 123, termTags: ['P'] });
  });
  it('fills an empty reading with the expression and handles v1 rows', () => {
    expect(convertTermRow(['テレビ', '', '', '', 0, ['TV']], 'D', 3).reading).toBe('テレビ');
    expect(convertTermRow(['猫', 'ねこ', 'n', '', 1, 'cat', 'feline'], 'D', 1).glossary).toEqual(['cat', 'feline']);
  });
  it('converts kanji rows', () => {
    expect(convertKanjiRow(['猫', 'ビョウ', 'ねこ', 'jouyou', ['cat'], { strokes: '11' }], 'K', 3)).toMatchObject({ onyomi: ['ビョウ'], kunyomi: ['ねこ'], meanings: ['cat'], stats: { strokes: '11' } });
  });
});

describe('structured content', () => {
  const opts = { dict: 'Jitendex', images: 'placeholder' as const };
  it('renders Yomitan classes, data attributes and safe styles', () => {
    const html = renderStructured({ tag: 'span', data: { content: 'part-of-speech-info', subKey: 'x' }, style: { fontWeight: 'bold', marginTop: 0.5, color: 'url(javascript:x)' }, content: ['verb', { tag: 'br' }] }, opts);
    expect(html).toBe('<span class="gloss-sc-span" data-sc-content="part-of-speech-info" data-sc-sub-key="x" style="font-weight:bold;margin-top:0.5em">verb<br></span>');
  });
  it('escapes text and drops unknown tags/attributes', () => {
    expect(renderStructured({ tag: 'script', content: '<b>x</b>' } as never, opts)).toBe('&lt;b&gt;x&lt;/b&gt;');
  });
  it('renders internal links and images', () => {
    expect(renderStructured({ tag: 'a', href: '?query=%E7%8C%AB&wildcards=off', content: '猫' }, opts)).toContain('data-query="猫"');
    expect(renderGlossaryItem({ type: 'image', path: 'img/a.png', width: 10 }, opts)).toContain('data-media-path="img/a.png"');
    expect(renderGlossaryItem({ type: 'image', path: 'a.png', alt: 'pic' }, { ...opts, images: 'alt' })).toBe('pic');
  });
  it('extracts plain text', () => {
    expect(glossaryText({ type: 'structured-content', content: { tag: 'ul', content: [{ tag: 'li', content: 'to read' }, { tag: 'li', content: ['to ', { tag: 'ruby', content: ['詠', { tag: 'rt', content: 'よ' }] }, 'む'] }] } })).toBe('to read\nto 詠む');
  });
});

const yterms: YTerm[] = [
  { id: 1, dict: 'Jitendex', expression: '読む', reading: 'よむ', definitionTags: ['v5'], rules: ['v5'], score: 5, glossary: [{ type: 'structured-content', content: 'to read' }], termTags: ['★'] },
  { id: 2, dict: 'Jitendex', expression: '勉強', reading: 'べんきょう', definitionTags: ['n'], rules: ['vs'], score: 1, glossary: ['study'], termTags: [] },
  { id: 3, dict: 'Other', expression: '読む', reading: 'よむ', definitionTags: [], rules: ['v5'], score: 0, glossary: ['to recite'], termTags: [] },
];
const meta: YTermMeta[] = [
  { id: 1, dict: 'JPDB', expression: '読む', mode: 'freq', data: { reading: 'よむ', frequency: { value: 830, displayValue: '830㋕' } } },
  { id: 2, dict: 'Kanjium', expression: '読む', mode: 'pitch', data: { reading: 'よむ', pitches: [{ position: 1 }] } },
];
const ylookup = async (keys: string[]) => {
  const m = new Map<string, YTerm[]>();
  for (const k of keys) {
    const hits = yterms.filter((t) => t.expression === k || t.reading === k);
    if (hits.length) m.set(k, hits);
  }
  return m;
};
const mlookup = async (exprs: string[]) => new Map(exprs.map((e) => [e, meta.filter((m) => m.expression === e)]));

describe('lookup with imported dictionaries', () => {
  it('deinflects using Yomitan rules and groups definitions from several dictionaries', async () => {
    const r = await findTerms(chars('読まなかった'), 0, { yomitan: ylookup, meta: mlookup, dictOrder: ['Other', 'Jitendex'] });
    expect(r[0].expression).toBe('読む');
    expect(r[0].length).toBe(6);
    expect(r[0].definitions.map((d) => d.dict)).toEqual(['Other', 'Jitendex']);
    expect(r[0].common).toBe(true);
    expect(r[0].frequencies).toEqual([{ dict: 'JPDB', value: 830, display: '830㋕' }]);
    expect(r[0].pitches[0].pitches[0].position).toBe(1);
  });
  it('handles suru nouns with the vs rule', async () => {
    const r = await findTerms(chars('勉強した'), 0, { yomitan: ylookup });
    expect(r[0].expression).toBe('勉強');
    expect(r[0].length).toBe(4);
  });
  it('maps rules to conditions', () => {
    expect([...yomitanConds(['vs'], '勉強')]).toEqual(['vs-n']);
    expect([...yomitanConds(['vs'], '愛する')]).toEqual(['vs']);
    expect([...yomitanConds(['v1d', 'v5k-s'], 'x')]).toEqual(['v1', 'v5']);
  });
  it('parses frequency formats', () => {
    expect(parseFrequency(12, 'x')).toEqual({ value: 12, display: '12' });
    expect(parseFrequency('1234/5', 'x')?.value).toBe(12345);
    expect(parseFrequency({ reading: 'よむ', frequency: 5 }, 'とく')).toBeNull();
  });
});

describe('Anki markers', () => {
  it('produces Yomitan-compatible values', async () => {
    const [r] = await findTerms(chars('読まなかった'), 0, { yomitan: ylookup, meta: mlookup, dictOrder: ['Jitendex', 'Other'] });
    const v = buildMarkerValues(r, { sentence: '昨日は本を読まなかった。', offset: 5, source: 'Book', ruby: [{ start: 0, end: 2, text: 'きのう' }] });
    expect(v.furigana).toBe('<ruby>読<rt>よ</rt></ruby>む');
    expect(v['furigana-plain']).toBe('読[よ]む');
    expect(v.sentence).toBe('昨日は本を読まなかった。');
    expect(fillTemplate('{cloze-prefix}<b>{cloze-body}</b>{cloze-suffix}', v)).toBe('昨日は本を<b>読まなかった</b>。');
    expect(v['cloze-body-kana']).toBe('よまなかった');
    expect(v['sentence-furigana-plain']).toBe('昨日[きのう]は本を読まなかった。');
    expect(v['sentence-furigana']).toBe('<ruby>昨日<rt>きのう</rt></ruby>は本を読まなかった。');
    expect(v.glossary).toContain('class="yomitan-glossary"');
    expect(v.glossary).toContain('<ol>');
    expect(v['glossary-first']).toContain('Jitendex');
    expect(v['glossary-first']).not.toContain('Other');
    expect(v['single-glossary-other']).toContain('to recite');
    expect(v['pitch-accent-positions']).toBe('1');
    expect(v['pitch-accent-categories']).toBe('atamadaka');
    expect(v['frequency-harmonic-rank']).toBe('830');
    expect(v.conjugation).toBe('negative « past');
    expect(fillTemplate('{unknown-marker}x', v)).toBe('x');
  });
  it('guesses markers for common note types (Lapis/Kiku)', () => {
    expect(guessMarker('Expression')).toBe('{expression}');
    expect(guessMarker('ExpressionFurigana')).toBe('{furigana-plain}');
    expect(guessMarker('MainDefinition')).toBe('{glossary}');
    expect(guessMarker('Sentence')).toBe('{cloze-prefix}<b>{cloze-body}</b>{cloze-suffix}');
    expect(guessMarker('Picture')).toBe('{image}');
    expect(guessMarker('FreqSort')).toBe('{frequency-harmonic-rank}');
  });
});

describe('pitch accent', () => {
  it('splits morae and computes patterns', () => {
    expect(morae('きょうと')).toEqual(['きょ', 'う', 'と']);
    expect(pitchPattern(0, 3)).toEqual([false, true, true, true]);
    expect(pitchPattern(1, 3)).toEqual([true, false, false, false]);
    expect(pitchPattern(2, 3)).toEqual([false, true, false, false]);
    expect(pitchCategory('はし', 2)).toBe('odaka');
    expect(pitchHtml('はし', { position: 1 })).toContain('border-right');
  });
});

describe('Yomitan settings import', () => {
  const backup = {
    version: 24,
    profileCurrent: 0,
    global: {},
    profiles: [{
      name: 'Default',
      options: {
        anki: {
          enable: true, server: 'http://127.0.0.1:8765', apiKey: 'k', tags: ['yomitan', 'book'], duplicateBehavior: 'overwrite', duplicateScope: 'deck', checkForDuplicates: true, fieldTemplates: null,
          cardFormats: [{ name: 'Expression', type: 'term', deck: 'Mining', model: 'Lapis', fields: { Expression: { value: '{expression}', overwriteMode: 'coalesce' }, Sentence: { value: '{cloze-prefix}<b>{cloze-body}</b>{cloze-suffix}' }, Weird: { value: '{some-custom}' } } }],
        },
        dictionaries: [{ name: 'Jitendex', enabled: true }, { name: 'Missing Dict', enabled: true }, { name: 'JPDB', enabled: false }],
      },
    }],
  };
  it('imports anki and dictionary settings', () => {
    const s = structuredClone(DEFAULT_SETTINGS);
    s.dictionaries = [{ name: 'JMdict (built-in)', enabled: true }, { name: 'KANJIDIC2 (built-in)', enabled: true }, { name: 'JPDB', enabled: true }, { name: 'Jitendex', enabled: true }];
    const f = parseYomitanSettings(backup);
    const sum = applyYomitanProfile(s, f.profiles[0], ['Jitendex', 'JPDB']);
    // The sending method is kept; the note type applies to AnkiConnect, AnkiMobile and the export.
    expect(s.anki).toMatchObject({ method: 'local', key: 'k', tags: 'yomitan book', deck: 'Mining', model: 'Lapis', duplicateBehavior: 'overwrite', duplicateScope: 'deck' });
    const fields = { Expression: '{expression}', Sentence: '{cloze-prefix}<b>{cloze-body}</b>{cloze-suffix}', Weird: '{some-custom}' };
    expect(s.anki.fields).toEqual(fields);
    expect(s.anki.mobile).toMatchObject({ deck: 'Mining', model: 'Lapis', fields, profile: 'User 1' });
    expect(s.anki.export).toEqual({ deck: 'Mining', model: 'Lapis', fields });
    expect(s.dictionaries.map((d) => [d.name, d.enabled])).toEqual([['Jitendex', true], ['JPDB', false], ['JMdict (built-in)', true], ['KANJIDIC2 (built-in)', true]]);
    expect(sum.warnings.join(' ')).toContain('{some-custom}');
    expect(sum.warnings.join(' ')).toContain('Missing Dict');
  });
  it('exports TSV with the export note type', () => {
    const s = structuredClone(DEFAULT_SETTINGS);
    s.anki.tags = 'mm';
    const note = { created: 1, status: 'pending' as const, fields: { expression: '読む', reading: 'よむ', 'cloze-prefix': '本を', 'cloze-body': '読んだ', 'cloze-suffix': '。', glossary: '<div class="g">to read</div>' } };
    // No export note type: the fixed columns
    expect(notesToTsv([note], s).split('\n')[2]).toMatch(/^#columns:expression\treading/);
    s.anki.export = { deck: 'Mining', model: 'Lapis', fields: { Expression: '{expression}', Sentence: '{cloze-prefix}<b>{cloze-body}</b>{cloze-suffix}', Meaning: '{glossary}', Picture: '{image}' } };
    const lines = notesToTsv([note], s).trim().split('\n');
    expect(lines.slice(0, 6)).toEqual(['#separator:tab', '#html:true', '#notetype:Lapis', '#deck:Mining', '#columns:Expression\tSentence\tMeaning\tPicture\ttags', '#tags column:5']);
    expect(lines[6].split('\t')).toEqual(['読む', '本を<b>読んだ</b>。', '"<div class=""g"">to read</div>"', '', 'mm']);
  });
  it('supports the older anki.terms format and rejects other files', () => {
    const s = structuredClone(DEFAULT_SETTINGS);
    applyYomitanProfile(s, { options: { anki: { terms: { deck: 'D', model: 'M', fields: { Front: '{expression}' } } } } }, []);
    expect(s.anki.fields).toEqual({ Front: '{expression}' });
    expect(() => parseYomitanSettings({ foo: 1 })).toThrow();
  });
});

// Synthetic OCR lines: a horizontal base line with furigana above it.
function hline(text: string, x: number, y: number, charW: number, h: number, us?: number[]): OcrLine {
  const cs = Array.from(text);
  const w = charW * cs.length;
  return {
    text, vertical: false, score: 1,
    chars: cs.map((c, i) => ({ c, p: 1, u: us?.[i] ?? (i + 0.5) / cs.length })),
    quad: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }],
    box: { x, y, w, h },
  };
}

describe('furigana detection', () => {
  // 昨日は本を読む: base chars are 40px wide; ruby (20px chars) over 昨日 (きのう) and 読 (よ)
  const base = hline('昨日は本を読む', 100, 100, 40, 40);
  const ruby1 = hline('きのう', 110, 76, 20, 20);
  const ruby2 = hline('よ', 310, 76, 20, 20);
  const next = hline('次の行です', 100, 170, 40, 40);
  it('attaches ruby to the kanji below', () => {
    expect(attachRuby(base, ruby1)).toEqual([{ from: 0, to: 2, text: 'きのう' }]);
    expect(attachRuby(base, ruby2)).toEqual([{ from: 5, to: 6, text: 'よ' }]);
  });
  it('removes furigana lines from the text and keeps real lines', () => {
    const out = processFurigana([ruby1, ruby2, base, next], 'ruby');
    expect(out.map((l) => l.text)).toEqual(['昨日は本を読む', '次の行です']);
    expect(out[0].ruby).toEqual([{ from: 0, to: 2, text: 'きのう' }, { from: 5, to: 6, text: 'よ' }]);
    expect(processFurigana([ruby1, base, next], 'remove').map((l) => l.text)).toEqual(['昨日は本を読む', '次の行です']);
    expect(processFurigana([ruby1, base], 'keep')).toHaveLength(2);
  });
  it('does not treat normal kana lines as furigana', () => {
    const kanaLine = hline('ひらがなだけ', 100, 50, 40, 40);
    expect(processFurigana([kanaLine, base], 'ruby')).toHaveLength(2);
  });
});

import { candidateReadings, snapReading, looseKana, checkFurigana } from '../../src/lib/rubyCheck';
import { cleanRubyText } from '../../src/lib/ocr/ruby';
describe('furigana dictionary check', () => {
  const entries = [
    { id: 1, k: [{ t: '一寸' }], r: [{ t: 'ちょっと' }, { t: 'いっすん' }], s: [] },
    { id: 2, k: [{ t: '這入る' }], r: [{ t: 'はいる' }], s: [] },
    { id: 3, k: [{ t: '罰する' }], r: [{ t: 'ばっする' }], s: [] },
    { id: 4, k: [{ t: '罰' }], r: [{ t: 'ばつ' }], s: [] },
    { id: 5, k: [{ t: '天明' }], r: [{ t: 'てんめい' }], s: [] },
  ] as never[];
  it('derives readings for the annotated characters', () => {
    expect(candidateReadings('這入', entries)).toEqual(['はい']);
    expect(candidateReadings('罰', entries).sort()).toEqual(['ばっ', 'ばつ']);
  });
  it('snaps OCR readings to dictionary readings', () => {
    expect(snapReading('ちよつと', candidateReadings('一寸', entries))).toBe('ちょっと');
    expect(snapReading('ぼっ', candidateReadings('罰', entries))).toBeNull(); // too short to guess
    expect(snapReading('てんめ', candidateReadings('天明', entries))).toBe('てんめい');
    expect(snapReading('かたおか', candidateReadings('天明', entries))).toBeNull();
    expect(looseKana('ずいぶん')).toBe('すいふん');
  });
  it('splits furigana that covers two words', async () => {
    const lookup = async (p: string) => (entries as { k: { t: string }[] }[]).filter((e) => e.k.some((k) => k.t.startsWith(p))) as never[];
    expect(await checkFurigana('一寸這入', 'ちよつとはい', lookup)).toEqual({ parts: [{ from: 0, to: 2, text: 'ちょっと' }, { from: 2, to: 4, text: 'はい' }] });
    expect(await checkFurigana('天明', 'てんめ', lookup)).toEqual({ parts: [{ from: 0, to: 2, text: 'てんめい' }] });
  });
  it('fixes a misread kanji using the furigana', async () => {
    const all = [...(entries as never[]), { id: 9, k: [{ t: '説諭' }], r: [{ t: 'せつゆ' }], s: [] }];
    const lookup = async (p: string) => (all as { k: { t: string }[] }[]).filter((e) => e.k.some((k) => k.t.startsWith(p))) as never[];
    expect(await checkFurigana('説論', 'せつゆ', lookup, [[], ['諭', '輪']])).toEqual({ parts: [{ from: 0, to: 2, text: 'せつゆ' }], fix: { i: 1, c: '諭' } });
  });
  it('cleans furigana text', () => {
    expect(cleanRubyText('ぶーてい')).toBe('ぶてい');
    expect(cleanRubyText('ヴァイオリーン')).toBe('ヴァイオリーン');
  });
});

import { areasIntersect } from '../../src/lib/areas';
describe('section boxes', () => {
  const box = (cx: number, cy: number, w: number, h: number, angle = 0) => ({ id: 'x', cx, cy, w, h, angle });
  it('detects any overlap between rotated boxes', () => {
    expect(areasIntersect(box(0, 0, 10, 10), box(9, 0, 10, 10))).toBe(true); // small overlap
    expect(areasIntersect(box(0, 0, 10, 10), box(11, 0, 10, 10))).toBe(false);
    expect(areasIntersect(box(0, 0, 10, 10), box(0, 0, 100, 100))).toBe(true); // contained
    expect(areasIntersect(box(0, 0, 10, 10, Math.PI / 4), box(9.5, 9.5, 10, 10, Math.PI / 4))).toBe(false); // diagonal gap
  });
});
