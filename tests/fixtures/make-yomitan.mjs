// Generates a small Yomitan-format dictionary (terms with structured content, an image,
// styles.css, tags, frequency + pitch metadata, kanji) and a Yomitan settings backup.
import { zipSync, strToU8 } from 'fflate';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const out = process.argv[2] ?? '.';
const j = (v) => strToU8(JSON.stringify(v));
// 2x2 red PNG
const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP4z8DAwMDAxMDAAAAeDwIBTp2W/QAAAABJRU5ErkJggg==', 'base64'));

const terms = [
  ['読む', 'よむ', 'v5 vt', 'v5', 100, [{ type: 'structured-content', content: [
    { tag: 'div', data: { content: 'glossary' }, content: { tag: 'ul', content: [
      { tag: 'li', content: 'to read (a book)' },
      { tag: 'li', content: ['to guess; see ', { tag: 'a', href: '?query=%E6%8E%A8%E6%B8%AC&wildcards=off', content: '推測' }] },
    ] } },
    { tag: 'img', path: 'img/read.png', width: 2, height: 2, alt: 'icon' },
  ] }], 1, '★'],
  ['推測', 'すいそく', 'n vs', 'vs', 50, ['guess; conjecture'], 2, ''],
  ['図書館', 'としょかん', 'n', '', 80, ['library'], 3, '★'],
];
const dict = zipSync({
  'index.json': j({ title: 'Test Dict', revision: '2026.11', format: 3, sequenced: true, author: 'test', description: 'e2e fixture' }),
  'term_bank_1.json': j(terms),
  'tag_bank_1.json': j([['v5', 'partOfSpeech', 0, 'Godan verb', 0], ['★', 'popular', 0, 'common word', 10]]),
  'styles.css': strToU8('[data-sc-content="glossary"] { color: rgb(1, 2, 3); }'),
  'img/read.png': png,
});
writeFileSync(join(out, 'test-dict.zip'), dict);

const meta = zipSync({
  'index.json': j({ title: 'Test Freq', revision: '1', format: 3, frequencyMode: 'rank-based' }),
  'term_meta_bank_1.json': j([
    ['読む', 'freq', { reading: 'よむ', frequency: { value: 830, displayValue: '830' } }],
    ['読む', 'pitch', { reading: 'よむ', pitches: [{ position: 1 }] }],
    ['図書館', 'freq', 2400],
  ]),
  'kanji_bank_1.json': j([['読', 'ドク トク', 'よ.む', 'jouyou', ['read'], { strokes: '14' }]]),
});
writeFileSync(join(out, 'test-freq.zip'), meta);

writeFileSync(join(out, 'yomitan-settings.json'), JSON.stringify({
  version: 24,
  profileCurrent: 0,
  global: {},
  profiles: [{
    name: 'Default',
    conditionGroups: [],
    options: {
      anki: {
        enable: true, server: 'http://127.0.0.1:8765', apiKey: '', tags: ['yomitan'], duplicateBehavior: 'new', duplicateScope: 'collection', checkForDuplicates: true, fieldTemplates: null,
        cardFormats: [{ name: 'Expression', icon: 'big-circle', type: 'term', deck: 'Mining', model: 'Lapis', fields: {
          Expression: { value: '{expression}', overwriteMode: 'coalesce' },
          ExpressionFurigana: { value: '{furigana-plain}', overwriteMode: 'coalesce' },
          MainDefinition: { value: '{single-glossary-test-dict}', overwriteMode: 'coalesce' },
          Sentence: { value: '{cloze-prefix}<b>{cloze-body}</b>{cloze-suffix}', overwriteMode: 'coalesce' },
          SentenceFurigana: { value: '{sentence-furigana-plain}', overwriteMode: 'coalesce' },
          PitchPosition: { value: '{pitch-accent-positions}', overwriteMode: 'coalesce' },
          FreqSort: { value: '{frequency-harmonic-rank}', overwriteMode: 'coalesce' },
          Picture: { value: '{screenshot}', overwriteMode: 'coalesce' },
        } }],
      },
      dictionaries: [{ name: 'Test Dict', enabled: true }, { name: 'Test Freq', enabled: true }, { name: 'Jitendex', enabled: true }],
    },
  }],
}, null, 1));
console.log('wrote test-dict.zip, test-freq.zip, yomitan-settings.json');
