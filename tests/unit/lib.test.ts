import { describe, expect, it } from 'vitest';
import { deinflect } from '../../src/lib/deinflect';
import { ankiFurigana, furiganaSegments, normalizeText, toHiragana, isKanji, chars } from '../../src/lib/kana';
import { extractSentence, findTerms } from '../../src/lib/lookup';
import type { Entry } from '../../src/lib/db';
import { entryKeys } from '../../src/lib/db';

const has = (src: string, term: string) => deinflect(src).some((d) => d.term === term);
const reasonsFor = (src: string, term: string) => deinflect(src).find((d) => d.term === term)?.reasons;

describe('deinflect', () => {
  it.each([
    ['食べなかった', '食べる'],
    ['食べています', '食べる'],
    ['食べてた', '食べる'],
    ['食べさせられた', '食べる'],
    ['読んでいる', '読む'],
    ['読まない', '読む'],
    ['読める', '読む'],
    ['書いて', '書く'],
    ['泳いだ', '泳ぐ'],
    ['話した', '話す'],
    ['待って', '待つ'],
    ['死んだ', '死ぬ'],
    ['遊ばれた', '遊ぶ'],
    ['行った', '行く'],
    ['買いたくない', '買う'],
    ['来なかった', '来る'],
    ['こない', 'くる'],
    ['しました', 'する'],
    ['勉強する', '勉強'],
    ['高くなかった', '高い'],
    ['美しさ', '美しい'],
    ['やってしまった', 'やる'],
    ['忘れちゃった', '忘れる'],
    ['見られませんでした', '見る'],
    ['分からなければ', '分かる'],
    ['いらっしゃい', 'いらっしゃる'],
  ])('%s -> %s', (src, term) => {
    expect(has(src, term)).toBe(true);
  });

  it('records the inflection chain innermost-first', () => {
    expect(reasonsFor('食べなかった', '食べる')).toEqual(['negative', 'past']);
  });

  it('does not chain end-only rules after constrained ones', () => {
    // "stem" must not be applied on top of another rule
    expect(deinflect('食べた').filter((d) => d.term === '食べたる' && d.reasons.length > 1)).toHaveLength(0);
  });
});

describe('kana / furigana', () => {
  it('converts kana', () => {
    expect(toHiragana('カタカナ')).toBe('かたかな');
  });
  it('treats supplementary-plane kanji as single kanji', () => {
    expect(chars('𠮷野家')).toHaveLength(3);
    expect(isKanji('𠮷')).toBe(true);
  });
  it('normalizes compatibility ideographs and half-width kana', () => {
    expect(normalizeText('欄')).toBe('欄');
    expect(normalizeText('ｶﾞｲﾄﾞ')).toBe('ガイド');
    expect(normalizeText('ＡＢＣ')).toBe('ABC');
  });
  it('aligns furigana', () => {
    expect(furiganaSegments('食べ物', 'たべもの')).toEqual([{ t: '食', r: 'た' }, { t: 'べ' }, { t: '物', r: 'もの' }]);
    expect(ankiFurigana('食べ物', 'たべもの')).toBe('食[た]べ 物[もの]');
    expect(ankiFurigana('お茶', 'おちゃ')).toBe('お 茶[ちゃ]');
    expect(ankiFurigana('ひらがな', 'ひらがな')).toBe('ひらがな');
  });
});

const fake: Entry[] = [
  { id: 1, k: [{ t: '食べる', c: 1, p: 10 }], r: [{ t: 'たべる', c: 1 }], s: [{ p: ['v1', 'vt'], g: ['to eat'] }] },
  { id: 2, k: [{ t: '食べ物', c: 1, p: 12 }], r: [{ t: 'たべもの' }], s: [{ p: ['n'], g: ['food'] }] },
  { id: 3, k: [{ t: '食' }], r: [{ t: 'しょく' }], s: [{ p: ['n'], g: ['meal'] }] },
  { id: 4, k: [{ t: '勉強', c: 1 }], r: [{ t: 'べんきょう' }], s: [{ p: ['n', 'vs', 'vt'], g: ['study'] }] },
  { id: 5, k: [{ t: '凄い' }], r: [{ t: 'すごい', c: 1 }], s: [{ p: ['adj-i'], g: ['amazing'], m: ['uk'] }] },
  { id: 6, k: [], r: [{ t: 'テレビ', c: 1 }], s: [{ p: ['n'], g: ['television'] }] },
];
const index = new Map<string, Entry[]>();
for (const e of fake) for (const k of entryKeys(e)) index.set(k, [...(index.get(k) ?? []), e]);
const lookup = async (keys: string[]) => new Map(keys.filter((k) => index.has(k)).map((k) => [k, index.get(k)!]));

describe('findTerms', () => {
  it('finds the longest deinflected match first', async () => {
    const r = await findTerms(chars('食べなかったよ'), 0, lookup);
    expect(r[0].expression).toBe('食べる');
    expect(r[0].length).toBe(6);
    expect(r[0].reasons).toEqual(['negative', 'past']);
    // Each dictionary entry's definitions appear once (they used to be doubled on cards)
    expect(r[0].definitions.length).toBe(1);
  });
  it('prefers longer compounds', async () => {
    const r = await findTerms(chars('食べ物が好き'), 0, lookup);
    expect(r[0].expression).toBe('食べ物');
    expect(r.map((x) => x.expression)).toContain('食');
  });
  it('handles suru-nouns', async () => {
    const r = await findTerms(chars('勉強しました'), 0, lookup);
    expect(r[0].expression).toBe('勉強');
  });
  it('keeps usually-kana words in kana and matches katakana via hiragana', async () => {
    expect((await findTerms(chars('すごかった'), 0, lookup))[0].expression).toBe('すごい');
    expect((await findTerms(chars('テレビを'), 0, lookup))[0].expression).toBe('テレビ');
  });
  it('stops at punctuation', async () => {
    const r = await findTerms(chars('食。べる'), 0, lookup);
    expect(r[0].expression).toBe('食');
  });
});

describe('extractSentence', () => {
  it('finds the sentence around a position, joining soft line breaks', () => {
    const t = chars('吾輩は猫である。名前は\nまだ無い。どこで');
    expect(extractSentence(t, 10).sentence).toBe('名前はまだ無い。');
  });
  it('respects quotes', () => {
    const t = chars('彼は「もう帰る。」と言った。');
    expect(extractSentence(t, 4).sentence).toBe('もう帰る。');
    expect(extractSentence(t, 12).sentence).toBe('彼は「もう帰る。」と言った。');
  });
});
