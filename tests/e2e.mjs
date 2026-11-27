// End-to-end test: builds nothing, expects `npm run build` output in dist/ (with models + dict).
// Serves dist/, installs the dictionary, OCRs fixture images, looks up a word and mines it
// against a mocked AnkiConnect.  Usage: node tests/e2e.mjs [--screenshots dir]
import { createServer } from 'node:http';
import { readFile, stat, mkdir } from 'node:fs/promises';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';

// Use the project's playwright if installed, else a globally installed one.
const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch { pw = require(join(execSync('npm root -g').toString().trim(), 'playwright')); }
const { chromium, devices } = pw;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const shotsIdx = process.argv.indexOf('--screenshots');
const shots = shotsIdx > 0 ? process.argv[shotsIdx + 1] : null;
if (shots) await mkdir(shots, { recursive: true });

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const server = createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = join(dist, p);
  try {
    const s = await stat(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Content-Length': s.size });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch();
const context = await browser.newContext({ ...devices['Pixel 7'] });
const page = await context.newPage();
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
page.on('console', (m) => m.type() === 'error' && console.error('[console]', m.text()));

// Mock AnkiConnect (stateful: remembers added notes for duplicate checks)
const ankiCalls = [];
const added = new Map(); // first-field value -> note id
const deleted = new Set(); // notes deleted in (mock) Anki
let nextId = 1700000000000;
// Pronunciation audio: 読む has a recording; every other word gets a clip as long as
// JapanesePod101's "audio not available" one (5.651 s).
const silentWav = (seconds) => {
  const rate = 8000, n = Math.round(seconds * rate), b = Buffer.alloc(44 + n);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write('data', 36); b.writeUInt32LE(n, 40); b.fill(128, 44);
  return b;
};
await page.route('https://assets.languagepod101.com/**', (route) => {
  const u = new URL(route.request().url());
  route.fulfill({ status: 200, contentType: 'audio/wav', body: silentWav(u.searchParams.get('kanji') === '読む' ? 0.5 : 5.651) });
});
await page.route('http://127.0.0.1:8765/**', async (route) => {
  const body = JSON.parse(route.request().postData() ?? '{}');
  ankiCalls.push(body);
  const p = body.params ?? {};
  let result = null;
  switch (body.action) {
    case 'version': result = 6; break;
    case 'requestPermission': result = { permission: 'granted' }; break;
    case 'deckNames': result = ['Default', 'Mining']; break;
    case 'modelNames': result = ['Basic', 'Japanese Sentence', 'Lapis', 'JP Mining Note']; break;
    case 'modelFieldNames':
      result = p.modelName === 'JP Mining Note'
        ? ['Key', 'Word', 'WordReading', 'PAOverride', 'PrimaryDefinition', 'PrimaryDefinitionPicture', 'Sentence', 'SentenceReading', 'IsSentenceCard', 'IsTargetedSentenceCard', 'PASeparateSentenceCard', 'Picture', 'WordAudio', 'PAGraphs', 'PAPositions', 'PASilence', 'FrequenciesStylized', 'ExtraDefinitions']
        : p.modelName === 'Lapis'
        ? ['Expression', 'ExpressionFurigana', 'MainDefinition', 'Sentence', 'SentenceFurigana', 'PitchPosition', 'FreqSort', 'Picture']
        : p.modelName === 'MobileMining'
          ? ['Word', 'Reading', 'Furigana', 'Meaning', 'Sentence', 'SentenceFurigana', 'Picture', 'Audio', 'PitchAccent', 'Frequency', 'Source']
          : ['Word', 'Reading', 'Sentence', 'Meaning', 'Picture', 'Audio'];
      break;
    case 'findNotes': {
      // "nid:1,2": which of these notes still exist
      if (p.query.startsWith('nid:')) { result = p.query.slice(4).split(',').map(Number).filter((id) => [...added.values()].includes(id) && !deleted.has(id)); break; }
      const m = /:(.+?)"$/.exec(p.query.split('" "')[1] ?? '');
      const id = m && added.get(m[1]);
      result = id ? [id] : [];
      break;
    }
    case 'storeMediaFile': result = p.filename; break;
    case 'addNote': {
      result = nextId++;
      const first = Object.values(p.note.fields)[0];
      added.set(first, result);
      break;
    }
    case 'createModel': result = {}; break;
    case 'createDeck': result = 1; break;
    case 'guiBrowse': result = []; break;
    case 'updateNoteFields': result = null; break;
  }
  await route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ result, error: null }) });
});

let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? '✔' : '✘'} ${msg}`);
  if (!cond) failures++;
};
const shot = async (name) => shots && page.screenshot({ path: join(shots, `${name}.png`) });
const tab = (name) => page.click(`.tabs >> text=${name}`);
const lastCall = (action) => [...ankiCalls].reverse().find((c) => c.action === action);

await page.goto(base);
await shot('01-capture');

// 1. Install the built-in dictionary
const t0 = Date.now();
await page.click('[data-testid=install-dict]');
await page.waitForFunction(() => !document.querySelector('.card.notice'), null, { timeout: 240_000 });
console.log(`  dictionary installed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// 2. AnkiConnect: auto-connects when selected
await tab('Settings');
await page.click('.segmented >> text=AnkiConnect');
await page.waitForSelector('.conn-ok');
check(true, 'AnkiConnect status shows connected');
await page.selectOption('[data-testid=anki-deck]', 'Mining');
await page.selectOption('[data-testid=anki-model]', 'Japanese Sentence');
await page.waitForSelector('.field-map');
const mapping = await page.$$eval('[data-testid=anki-settings] .field-map', (els) => els.map((e) => [e.querySelector('.field-name').textContent, e.querySelector('input').value]));
check(JSON.stringify(mapping) === JSON.stringify([['Word', '{expression}'], ['Reading', '{reading}'], ['Sentence', '{cloze-prefix}<b>{cloze-body}</b>{cloze-suffix}'], ['Meaning', '{glossary}'], ['Picture', '{image}'], ['Audio', '{audio}']]), `fields auto-mapped: ${JSON.stringify(mapping)}`);
await shot('02-settings');
// Known note types get their own mapping (switch fields stay empty), and each note type keeps its mapping
{
  const val = (f) => page.$eval(`[data-testid=anki-settings] [data-field="${f}"]`, (e) => e.value);
  await page.selectOption('[data-testid=anki-model]', 'JP Mining Note');
  await page.waitForSelector('[data-field="PrimaryDefinition"]');
  const jp = [await val('PrimaryDefinition'), await val('IsSentenceCard'), await val('PASeparateSentenceCard'), await val('PrimaryDefinitionPicture'), await val('PAGraphs'), await val('Picture')];
  check(jp.join('|') === '{jpmn-primary-definition}||||{jpmn-pitch-accent-graphs}|{image}', `JP Mining Note gets its recommended fields (${jp.join(' | ')})`);
  await page.fill('[data-testid=anki-settings] [data-field="SentenceReading"]', '{sentence-furigana-plain}');
  await page.selectOption('[data-testid=anki-model]', 'Japanese Sentence');
  await page.waitForSelector('[data-field="Meaning"]');
  await page.selectOption('[data-testid=anki-model]', 'JP Mining Note');
  await page.waitForSelector('[data-field="SentenceReading"]');
  const kept = await val('SentenceReading');
  await page.click('[data-testid=fields-reset]');
  await page.waitForFunction(() => document.querySelector('[data-testid=anki-settings] [data-field="SentenceReading"]')?.value === '');
  check(kept === '{sentence-furigana-plain}', `each note type keeps its mapping; reset restores the recommended one (${kept})`);
  await page.selectOption('[data-testid=anki-model]', 'Japanese Sentence');
  await page.waitForSelector('[data-field="Meaning"]');
  // Appearance
  await page.click('[data-testid=theme] >> text=Dark');
  await page.$eval('[data-testid=highlight-color]', (e) => { e.value = '#00aaff'; e.dispatchEvent(new Event('input', { bubbles: true })); });
  const look = await page.evaluate(() => [document.documentElement.dataset.theme, getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(), document.documentElement.style.getPropertyValue('--hl')]);
  await page.click('[data-testid=theme] >> text=Light');
  const light = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());
  check(look[0] === 'dark' && look[1] === '#1a1a1b' && look[2] === 'rgba(0, 170, 255, 0.45)' && light === '#f0f0f0', `theme and highlight colour settings (${look.join(' ')}; light ${light})`);
  await page.click('[data-testid=theme] >> text=Auto');
  check(!(await page.$eval('.settings', (e) => e.innerText)).includes('wasm'), 'no engine jargon in Settings');
}

const toText = async () => { if (await page.$('[data-testid=show-text]')) await page.click('[data-testid=show-text]'); await page.waitForSelector('[data-testid=reader]'); };
const toImage = async () => { if (await page.$('[data-testid=show-image]')) await page.click('[data-testid=show-image]'); await page.waitForSelector('[data-testid=image-reader]'); };
const readerText = () => page.$eval('[data-testid=reader]', (el) => [...el.querySelectorAll('.line')].map((l) => [...l.querySelectorAll('span[data-i]')].map((s) => s.textContent).join('')).join('\n'));

async function ocr(fixture) {
  await tab('Capture');
  const t = Date.now();
  await page.setInputFiles('[data-testid=file-input]', fixture.startsWith('/') ? fixture : join(root, 'tests/fixtures', fixture));
  await page.waitForSelector('[data-testid=image-reader]');
  await page.waitForFunction(() => !document.querySelector('[data-testid=ocr-progress]') && document.querySelector('[data-testid=image-reader] .ch'), null, { timeout: 180_000 });
  await toText();
  const text = await readerText();
  console.log(`  ${fixture} OCR in ${((Date.now() - t) / 1000).toFixed(1)}s:\n    ${text.replace(/\n/g, '\n    ')}`);
  return text;
}
/** Taps the nth occurrence of `ch` directly on the photo. */
const tapChar = async (ch, nth = 0) => {
  await toText();
  const idx = await page.$$eval('[data-testid=reader] span[data-i]', (els, [c, n]) => els.filter((e) => e.textContent === c)[n]?.dataset.i, [ch, nth]);
  await toImage();
  await page.locator(`[data-testid=image-reader] polygon[data-i="${idx}"]`).click({ force: true });
  await page.waitForSelector('[data-testid=popup] .entry, [data-testid=popup] .empty');
  return Number(idx);
};

const expected = ['吾輩は猫である。名前はまだ無い。', 'どこで生れたかとんと見当がつかぬ。', '昨日は本を読まなかった。'];
const similarity = (a, b) => {
  const A = [...a], B = [...b];
  const dp = Array.from({ length: A.length + 1 }, (_, i) => [i, ...Array(B.length).fill(0)]);
  for (let j = 1; j <= B.length; j++) dp[0][j] = j;
  for (let i = 1; i <= A.length; i++) for (let j = 1; j <= B.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (A[i - 1] === B[j - 1] ? 0 : 1));
  return 1 - dp[A.length][B.length] / Math.max(A.length, B.length);
};

const expected2 = ['「ちょっと待って」と、彼女は言った。', 'コーヒーを飲みながら、鬱蒼とした森を眺める。', '薔薇の棘に気を付けてください。'];
for (const fx of ['horizontal.png', 'vertical.png', 'rotated.png', 'vertical2.png']) {
  const text = await ocr(fx);
  const sim = similarity(text.replace(/\n/g, ''), (fx === 'vertical2.png' ? expected2 : expected).join(''));
  check(sim > 0.95, `${fx}: text matches (${(sim * 100).toFixed(1)}%)`);
  await shot(`03-${fx.replace('.png', '')}`);
}

// 3. One-tap add from the popup, then "view note"
await ocr('horizontal.png');
check(await page.$$eval('[data-testid=reader] span.low', (els) => els.every((e) => /[\p{L}\p{N}]/u.test(e.textContent))), 'punctuation is never marked as unsure');
check(!(await page.$('.image-reader .toolbar [title="Re-read"]')), 'no separate re-read button in the photo toolbar');
await tapChar('読');
const head = await page.$eval('[data-testid=popup] .entry .headword', (e) => e.textContent);
const reasons = await page.$eval('[data-testid=popup] .entry .reasons', (e) => e.textContent).catch(() => '');
check(head.includes('読む') || head.includes('読よむ'), `popup headword: ${head} ${reasons}`);
check(reasons.includes('negative') && reasons.includes('past'), 'deinflection reasons shown');
const audioOf = async () => {
  await page.waitForFunction(() => document.querySelector('[data-testid=popup] [data-testid=audio-button]:not(.checking)'), null, { timeout: 15_000 }).catch(() => {});
  return page.$eval('[data-testid=popup] .entry', (e) => [e.querySelector('.headword')?.textContent, e.querySelector('[data-testid=audio-button]')?.className.split(' ').pop()]);
};
const yomuAudio = await audioOf();
await page.click('[data-testid=close-panel]');
await tapChar('本');
const honAudio = await audioOf();
check(yomuAudio[1] === 'ok' && honAudio[1] === 'missing' && await page.$eval('[data-testid=audio-button]', (b) => b.disabled), `audio button greyed out when there's no recording (${yomuAudio.join(': ')}, ${honAudio.join(': ')})`);
await page.click('[data-testid=close-panel]');
await tapChar('読');
await shot('04-popup');
await page.click('[data-testid=popup] [data-testid=mine-button] >> nth=0');
await page.waitForSelector('.toast-ok', { timeout: 20_000 });
let add = lastCall('addNote');
check(!!add, 'one-tap add sent addNote');
if (add) {
  const f = add.params.note.fields;
  console.log('  note:', JSON.stringify({ ...f, Meaning: f.Meaning.slice(0, 70) + '…' }));
  check(f.Word === '読む' && f.Reading === 'よむ', 'word/reading fields');
  check(f.Sentence === '昨日は本を<b>読まなかった</b>。', 'sentence bolds the inflected word');
  check(f.Meaning.includes('yomitan-glossary') && f.Meaning.includes('to read'), 'glossary in Yomitan format');
  check(/^<img src="mobilemining_\d+\.jpg">$/.test(f.Picture), 'picture stored via storeMediaFile');
  check(add.params.note.audio?.[0]?.fields?.[0] === 'Audio', 'audio requested for Audio field');
}
await page.waitForSelector('[data-testid=popup] [data-testid=view-note]');
await page.click('[data-testid=popup] [data-testid=view-note] >> nth=0');
await page.waitForTimeout(300);
check(lastCall('guiBrowse')?.params.query === `nid:${add?.params ? 1700000000000 : ''}`, `view note opens Anki browser (${JSON.stringify(lastCall('guiBrowse')?.params)})`);

// Duplicate state when looking the word up again
await page.keyboard.press('Escape');
await tapChar('読');
await page.waitForFunction(() => document.querySelector('[data-testid=popup] [data-testid=mine-button]')?.classList.contains('dupe'), null, { timeout: 10_000 }).catch(() => {});
check(await page.$eval('[data-testid=popup] [data-testid=mine-button]', (e) => e.classList.contains('dupe')), 'popup marks the word as already in Anki');

// Editor sheet
await page.click('[data-testid=popup] [data-testid=edit-button] >> nth=0');
await page.waitForSelector('[data-testid=mine-sheet]');
const sentence = await page.$eval('[data-testid=sentence]', (e) => e.value);
check(sentence === '昨日は本を読まなかった。', `sentence extracted: ${sentence}`);
check(!!(await page.waitForSelector('[data-testid=mine-overwrite]', { timeout: 10_000 }).catch(() => null)), 'editor offers overwrite / add new for duplicates');
await shot('05-mine');
await page.click('[data-testid=mine-overwrite]');
await page.waitForSelector('[data-testid=mine-sheet]', { state: 'detached', timeout: 20_000 });
check(lastCall('updateNoteFields')?.params.note.id === 1700000000000, 'overwrite updates the existing note');

// 4. Import Yomitan dictionaries
await tab('Settings');
await page.setInputFiles('[data-testid=dict-file]', [join(root, 'tests/fixtures/test-dict.zip'), join(root, 'tests/fixtures/test-freq.zip')]);
await page.waitForFunction(() => [...document.querySelectorAll('.dict-title')].map((e) => e.textContent).includes('Test Freq'), null, { timeout: 30_000 });
const dictRows = await page.$$eval('.dict-row', (els) => els.map((e) => e.querySelector('.dict-title').textContent + ' | ' + e.querySelector('.muted').textContent));
console.log('  dictionaries:\n    ' + dictRows.join('\n    '));
check(dictRows.some((r) => r.startsWith('Test Dict') && r.includes('3 terms') && r.includes('1 images')), 'term dictionary imported with media');
check(dictRows.some((r) => r.startsWith('Test Freq') && r.includes('frequency') && r.includes('pitch accent') && r.includes('kanji')), 'frequency/pitch/kanji dictionary imported');

// 5. Import Yomitan settings
await page.setInputFiles('[data-testid=yomitan-file]', join(root, 'tests/fixtures/yomitan-settings.json'));
await page.waitForSelector('[data-testid=yomitan-summary]');
const summary = await page.$eval('[data-testid=yomitan-summary]', (e) => e.innerText);
console.log('  ' + summary.replace(/\n/g, '\n  '));
check(summary.includes('note type “Lapis”') && summary.includes('Jitendex'), 'Yomitan settings imported with warnings for missing dictionaries');
check(await page.$eval('[data-field="MainDefinition"]', (e) => e.value) === '{single-glossary-test-dict}', 'Yomitan field markers imported');
const order = await page.$$eval('.dict-title', (els) => els.map((e) => e.textContent));
check(order[0] === 'Test Dict' && order[1] === 'Test Freq', `dictionary order from Yomitan: ${order.join(', ')}`);
await shot('06-settings-yomitan');
// The imported note type also applies to AnkiMobile and the TSV export
await page.click('.segmented >> text=AnkiMobile');
const mob = [await page.$eval('[data-testid=mobile-model]', (e) => e.value), await page.$eval('[data-testid=mobile-note-type] [data-field="MainDefinition"]', (e) => e.value)];
await page.click('.segmented >> text=Export');
const lapisHint = await page.$eval('[data-testid=anki-settings]', (e) => e.innerText.includes('Export a “Lapis” card'));
await page.click('[data-testid=export-format] >> text=TSV');
const exp = [await page.$eval('[data-testid=export-model]', (e) => e.value), await page.$eval('[data-testid=export-deck]', (e) => e.value)];
check(mob[0] === 'Lapis' && mob[1] === '{single-glossary-test-dict}' && exp[0] === 'Lapis' && exp[1] === 'Mining' && lapisHint, `Yomitan note type used for AnkiMobile and export (${mob.join(', ')}; ${exp.join(', ')})`);
{
  await tab('Mined');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('text=TSV ↓')]);
  const tsv = await readFile(await dl.path(), 'utf8');
  const rows = tsv.trim().split('\n');
  const cols = rows.find((r) => r.startsWith('#columns:')).slice(9).split('\t');
  const row = rows.at(-1).split('\t');
  const val = (f) => row[cols.indexOf(f)];
  check(rows.includes('#notetype:Lapis') && rows.includes('#deck:Mining') && val('Expression') === '読む' && val('Sentence').includes('<b>読まなかった</b>'), `TSV export fills the Lapis fields (${cols.slice(0, 4).join(', ')}…: ${val('Expression')} / ${val('Sentence')})`);
  await tab('Settings');
}
await page.click('.segmented >> text=AnkiConnect');
await page.waitForSelector('.conn-ok');

// 6. Furigana: removed from the text, shown as ruby, available for cards
const rubyExpected = ['昨日は図書館で本を読んだ。', '薔薇の花が咲いている。', '明日も学校に行きます。'];
const denseText = '吾輩は猫である。名前はまだ無い。どこで生れたかとんと見当がつかぬ。何でも薄暗いじめじめした所でニャーニャー泣いていた事だけは記憶している。吾輩はここで始めて人間というものを見た。しかもあとで聞くとそれは書生という人間中で一番獰悪な種族であったそうだ。';
const denseRuby = ['吾輩[わがはい]', '猫[ねこ]', '名前[なまえ]', '見当[けんとう]', '薄暗[うすぐら]', '所[ところ]', '記憶[きおく]', '始[はじ]', '人間[にんげん]', '書生[しょせい]', '人間中[にんげんじゅう]', '種族[しゅぞく]'];
for (const fx of ['dense-vertical.png', 'dense-vertical-tilt.png', 'dense-horizontal-tilt.png']) {
  const text = await ocr(fx);
  const sim = similarity(text.replace(/\s/g, ''), denseText);
  check(sim > 0.97, `${fx}: dense furigana kept out of the text (${(sim * 100).toFixed(1)}%)`);
  const rts = await page.$$eval('[data-testid=reader] ruby', (els) => els.map((r) => [...r.querySelectorAll('span[data-i]')].map((s) => s.textContent).join('') + '[' + r.querySelector('rt').textContent + ']'));
  // 人間中 may also come out as 人間[にんげん] + 中[じゅう] (both correct)
  if (rts.includes('人間[にんげん]') && rts.includes('中[じゅう]')) rts.push('人間中[にんげんじゅう]');
  const got = denseRuby.filter((w) => rts.includes(w));
  check(got.length === denseRuby.length, `${fx}: dense furigana on the right line (${got.length}/${denseRuby.length}) ${denseRuby.filter((w) => !rts.includes(w)).join(' ')}`);
}

// Progressive reading: the photo shows immediately, and tapping an unread line reads it first
{
  await tab('Capture');
  const t0 = Date.now();
  await page.evaluate(() => { window.__sawOpening = false; new MutationObserver(() => { if (document.querySelector('[data-testid=opening]')) window.__sawOpening = true; }).observe(document.body, { childList: true, subtree: true }); });
  await page.setInputFiles('[data-testid=file-input]', join(root, 'tests/fixtures/dense-vertical.png'));
  await page.waitForSelector('[data-testid=image-reader] img');
  const shownMs = Date.now() - t0;
  await page.waitForSelector('polygon.pending');
  const pt = await page.$$eval('polygon.pending', (els) => {
    const r = els.map((e) => e.getBoundingClientRect()).filter((r) => r.height > r.width * 5).sort((a, b) => a.left - b.left)[0];
    return { x: r.left + r.width / 2, y: r.top + r.height * 0.3 };
  });
  const t1 = Date.now();
  await page.mouse.click(pt.x, pt.y);
  await page.waitForSelector('[data-testid=popup] .entry', { timeout: 60_000 });
  const stillReading = await page.$eval('[data-testid=ocr-progress]', (e) => e.innerText).catch(() => '');
  console.log(`  photo shown after ${shownMs}ms; popup ${Date.now() - t1}ms after tapping an unread line (${stillReading.split('—')[0].trim() || 'finished'})`);
  check(shownMs < 1500, 'photo is shown before OCR');
  check(await page.evaluate(() => window.__sawOpening), 'an "Opening…" screen shows at once while the photo is decoded');
  check(/Reading \d+\/\d+/.test(stillReading), 'tapped line was read before the rest of the page');
  await shot('06b-progressive');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('[data-testid=ocr-progress]'), null, { timeout: 120_000 });
}

// Mixed text directions: horizontal heading/caption around a vertical body
{
  const text = await ocr('mixed.png');
  const flat = text.replace(/\s/g, '');
  const parts = ['第一章猫の話', '吾輩は猫である。', '記憶している。', '注：作者は夏目漱石。', '写真：東京駅の様子'];
  const pos = parts.map((p) => flat.indexOf(p));
  check(pos.every((p, i) => p >= 0 && (i === 0 || p > pos[i - 1])), `mixed directions read in order: ${pos.join(',')}`);
  check(/\n\n/.test(text), 'blocks separated by blank lines');
  await tapChar('話');
  await page.click('[data-testid=popup] [data-testid=edit-button] >> nth=0');
  await page.waitForSelector('[data-testid=mine-sheet]');
  const sent = await page.$eval('[data-testid=sentence]', (e) => e.value);
  check(sent.replace(/\s/g, '') === '第一章猫の話', `heading sentence stays within its block: ${sent}`);
  await page.click('.sheet-head [aria-label=Close]');
  await shot('07-mixed');

  // Section editing
  await toImage();
  await page.click('[data-testid=sections]');
  const count = () => page.$$eval('g[data-section]', (e) => e.length);
  const pickSection = (i, nth = 0) => page.locator(`g[data-section="${i}"] polygon[data-section-line]`).nth(nth).click({ force: true });
  const flatText = async () => { await toText(); const t = (await readerText()).replace(/\s/g, ''); await toImage(); await page.click('[data-testid=sections]'); return t; };
  const n0 = await count();
  check(n0 === 4, `sections shown with reading order (${n0})`);
  await shot('07b-sections');
  await pickSection(3); // caption
  for (let k = 0; k < 3; k++) await page.click('[data-testid=sec-earlier]');
  check((await flatText()).startsWith('写真'), 'moving a section changes the reading order');
  await pickSection(3); // the note box
  await page.click('[data-testid=sec-delete]');
  check((await count()) === 3 && !(await flatText()).includes('注：'), 'deleting a section removes its text');
  await pickSection(1); // heading
  await page.click('[data-testid=sec-merge]');
  await pickSection(2); // body
  check((await count()) === 2, 'merging two sections');
  await page.click('[data-testid=sec-reset]');
  const reset = await flatText();
  check((await count()) === 4 && reset.startsWith('第一章') && reset.includes('注：'), 'reset restores automatic sections');
  await pickSection(3);
  await page.click('[data-testid=sec-vertical]');
  await page.waitForFunction(() => !document.querySelector('[data-testid=ocr-progress]'), null, { timeout: 60_000 });
  check((await count()) >= 4, 're-reading a section with a forced direction');
  await page.click('[data-testid=sec-reset]');

  // ⬚ Area: a box drawn around text becomes its own section, read on its own
  await page.click('.section-bar >> text=Done');
  const capBox = await page.$$eval('[data-testid=image-reader] polygon.line-box', (els) => {
    const rs = els.map((e) => e.getBoundingClientRect()).filter((r) => r.width > r.height * 3);
    const r = rs.sort((a, b) => b.bottom - a.bottom)[0]; // the caption row
    return { x0: r.x + r.width * 0.55, y0: r.y - 4, x1: r.right + 4, y1: r.bottom + 4, left: r.x };
  });
  const drawBox = async (x0, y0, x1, y1) => {
    await page.click('[data-testid=select-area]');
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    await page.mouse.move(x1, y1, { steps: 6 });
    await page.mouse.up();
  };
  const areaRead = async () => {
    await page.waitForFunction(() => { const t = document.querySelector('[data-testid=area-text]'); return t && !t.hasAttribute('data-reading'); }, null, { timeout: 60_000 });
    return page.$eval('[data-testid=area-text]', (e) => e.textContent);
  };
  const boxes = () => page.$eval('[data-testid=image-reader] svg.overlay', (e) => Number(e.dataset.areas));
  await drawBox(capBox.x0, capBox.y0, capBox.x1, capBox.y1);
  const t1 = await areaRead();
  check((await page.$$('[data-area]')).length === 1 && /二〇二四/.test(t1) && !/写真/.test(t1), `new section box is shown, selected and read (${t1})`);
  await page.click('[data-testid=show-text]');
  const partial = await readerText();
  await toImage();
  check(partial.split('二〇二四').length === 2 && partial.split('様').length === 2 && partial.split('子').length === 2 && partial.includes('写真：東京駅'), `a box over part of a line takes those characters out of it (${partial.split('\n').slice(-3).join('/')})`);
  // drawing a bigger box over it replaces it
  await drawBox(capBox.x0 - 30, capBox.y0 - 6, capBox.x1 + 6, capBox.y1 + 6);
  await areaRead();
  check((await boxes()) === 1, 'a box drawn over an existing box replaces it');
  const areaW = () => page.$eval('[data-area] polygon.area-box', (e) => e.getBoundingClientRect().width);
  const before = await areaW();
  // stretch: drag the left edge to the left end of the caption; the box is read again by itself
  const left = await page.$eval('[data-handle="edge-10"]', (e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  await page.mouse.move(left.x, left.y);
  await page.mouse.down();
  await page.mouse.move(capBox.left - 8, left.y, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(100);
  const t2 = await areaRead();
  const after = await areaW();
  check(after > before * 1.5 && /写真/.test(t2) && /二〇二四/.test(t2), `stretching a box re-reads it (${before.toFixed(0)} → ${after.toFixed(0)}px; ${t2})`);
  // rotate with the knob
  const knob = await page.$eval('[data-handle=rotate]', (e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  const mv = await page.$eval('[data-handle=move]', (e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  await page.mouse.move(knob.x, knob.y);
  await page.mouse.down();
  await page.mouse.move(mv.x + (mv.y - knob.y) * 0.3, knob.y, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const pts = await page.$eval('[data-area] polygon.area-box', (e) => e.getAttribute('points'));
  const ys = pts.split(' ').map((p) => Number(p.split(',')[1]));
  check(Math.abs(ys[0] - ys[1]) > 3, 'rotating a box with the knob');
  await areaRead();
  await page.click('[data-testid=area-delete]');
  await page.waitForTimeout(200);
  check((await boxes()) === 0 && !(await page.$('[data-testid=area-bar]')), 'removing a box');
  // a box over the whole caption; once put away it is a section like the others
  await drawBox(capBox.left - 8, capBox.y0 - 6, capBox.x1 + 6, capBox.y1 + 6);
  await areaRead();
  await page.click('[data-testid=show-text]');
  const shown = await readerText();
  await toImage();
  check((await boxes()) === 1 && (await page.$$('[data-area]')).length === 0 && !(await page.$('[data-testid=area-bar]')), 'box handles go away when using something else');
  check(shown.split('東京駅').length === 2, `text under a box isn't duplicated (${shown.replace(/\n/g, '/')})`);
  await page.click('[data-testid=sections]');
  check((await count()) === 4, `box over the caption is its section (${await count()} sections)`);
  await page.click('[data-testid=sec-reset]');
  await page.click('.section-bar >> text=Done');
  await page.click('[data-testid=sections]');
  await pickSection(3);
  await page.click('[data-testid=sec-reread]');
  await page.waitForFunction(() => !document.querySelector('[data-testid=ocr-progress]'), null, { timeout: 60_000 });
  check((await flatText()).includes('写真：東京駅'), 're-reading a section box');
  await page.click('[data-testid=sec-reset]');
  await page.click('.section-bar >> text=Done');
}

// Optional: real photos (not in the repo). MM_PHOTOS=dir with 1.jpg 2.jpg 3.jpg (sideways book pages)
if (process.env.MM_PHOTOS) {
  const want = {
    '1.jpg': ['片岡[かたおか]', '斜面[しゃめん]', '浚稽山[しゆんけいさん]', '敵塁[てきるい]', '帷[とばり]', '匈奴[きょうど]', '天子[てんし]', '天明[てんめい]', '有様[ありさま]', '震駭[しんがい]'],
    '2.jpg': ['我慢[がまん]', '猶更[なおさら]', '疳性[かんしょう]', '講釈[こうしゃく]', '説諭[せつゆ]', '一寸[ちょっと]', '這入[はい]', '豪傑[ごうけつ]', '随分[ずいぶん]', '田舎[いなか]'],
    '3.jpg': ['挨拶[あいさつ]', '壻[むこ]', '騙[だま]', '面目[めんぼく]', '一旦[いったん]', '纏[まと]', '傾[かし]', '独語[ひとりごと]'],
  };
  // Book covers at different angles (one upside down) on a desk
  {
    const text = (await ocr(join(process.env.MM_PHOTOS, 'covers.jpg'))).replace(/\s/g, '');
    const words = ['坊っちゃん', '夏目漱石', '新潮文庫', '李陵', '山月記', '中島敦'];
    const found = words.filter((w) => text.includes(w));
    check(found.length >= 5, `covers photo: mixed orientations read (${found.join(' ')}) missing: ${words.filter((w) => !text.includes(w)).join(' ')}`);
  }
  for (const [f, rubies] of Object.entries(want)) {
    await ocr(join(process.env.MM_PHOTOS, f));
    await page.waitForTimeout(1500); // dictionary check of furigana
    await toImage(); await toText();
    const dims = await page.evaluate(() => { const i = document.querySelector('[data-testid=reader]'); return i ? 1 : 0; });
    const rts = await page.$$eval('[data-testid=reader] ruby', (els) => els.map((r) => [...r.querySelectorAll('span[data-i]')].map((s) => s.textContent).join('') + '[' + r.querySelector('rt').textContent + ']'));
    const got = rubies.filter((w) => rts.includes(w));
    check(got.length >= rubies.length - 1, `photo ${f}: upright and furigana placed (${got.length}/${rubies.length}) ${rubies.filter((w) => !rts.includes(w)).join(' ')}`);
    void dims;
  }
}

for (const fx of ['ruby-vertical.png', 'ruby-horizontal.png']) {
  const text = await ocr(fx);
  const sim = similarity(text.replace(/\n/g, ''), rubyExpected.join(''));
  check(sim > 0.95, `${fx}: furigana kept out of the text (${(sim * 100).toFixed(1)}%)`);
  const rts = await page.$$eval('[data-testid=reader] ruby', (els) => els.map((r) => [...r.querySelectorAll('span[data-i]')].map((s) => s.textContent).join('') + '[' + r.querySelector('rt').textContent + ']'));
  console.log('  ruby: ' + rts.join(' '));
  const want = ['昨日[きのう]', '図書館[としょかん]', '本[ほん]', '読[よ]', '薔薇[ばら]', '花[はな]', '明日[あした]', '学校[がっこう]'];
  const got = want.filter((w) => rts.includes(w));
  check(got.length >= want.length - 1, `${fx}: furigana attached to the right kanji (${got.length}/${want.length})`);
  await shot(`07-${fx.replace('.png', '')}`);
}

// 7. Imported dictionary in the popup + mining with the imported Lapis setup
const yomuIdx = await tapChar('読');
await page.waitForSelector('[data-testid=popup] [data-dictionary="Test Dict"]');
const hlCount = await page.$$eval('[data-testid=image-reader] .ch.hl', (els) => els.map((e) => e.dataset.i));
await page.waitForTimeout(600); // panel opens, page scrolls the word into view
const overlap = await page.evaluate(() => {
  const panel = document.querySelector('[data-testid=dict-panel]').getBoundingClientRect();
  const reader = document.querySelector('[data-testid=image-reader]').getBoundingClientRect();
  return [...document.querySelectorAll('[data-testid=image-reader] .ch.hl')].map((e) => e.getBoundingClientRect()).map((r) => ({
    covered: r.bottom > panel.top && r.top < panel.bottom && r.right > panel.left && r.left < panel.right,
    visible: r.top >= reader.top && r.bottom <= reader.bottom,
  }));
});
check(overlap.length > 0 && overlap.every((o) => !o.covered && o.visible), `dictionary panel doesn't cover the word (${JSON.stringify(overlap)})`);
await page.click('[data-testid=image-reader] .image-wrap', { position: { x: 5, y: 5 } }).catch(() => {});
await page.waitForTimeout(300);
check(!(await page.$('[data-testid=dict-panel]')) && !(await page.$('[data-testid=ocr-progress]')), 'tapping empty photo closes the panel without re-reading');
await tapChar('読');
check(hlCount.length === 3 && hlCount[0] === String(yomuIdx), `looked-up word highlighted on the photo (${hlCount.join(',')})`);
const popupInfo = await page.$eval('[data-testid=popup]', (el) => ({
  text: el.innerText,
  img: el.querySelector('img.gloss-image')?.getAttribute('src') ?? '',
  color: getComputedStyle(el.querySelector('[data-sc-content="glossary"]')).color,
  freq: el.querySelector('.tag.freq')?.textContent,
  pitch: el.querySelector('.pitch-num')?.textContent,
}));
console.log('  popup:', JSON.stringify({ ...popupInfo, text: popupInfo.text.slice(0, 120) }));
check(popupInfo.text.includes('to read (a book)'), 'structured content rendered');
check(popupInfo.img.startsWith('blob:'), 'dictionary image loaded');
check(popupInfo.color === 'rgb(1, 2, 3)', 'dictionary styles.css applied');
check(popupInfo.freq?.includes('830') && popupInfo.pitch === '[1]', 'frequency and pitch accent shown');
await shot('08-popup-imported');
await page.click('[data-testid=popup] a.gloss-link');
await page.waitForSelector('.popup-nav >> text=← Back');
check((await page.$eval('[data-testid=popup]', (e) => e.innerText)).includes('guess; conjecture'), 'dictionary link opens nested lookup');
await page.click('.popup-nav >> text=← Back');
await page.click('[data-testid=popup] [data-testid=mine-button] >> nth=0');
await page.waitForSelector('.toast-ok', { timeout: 20_000 });
add = lastCall('addNote');
if (add) {
  const f = add.params.note.fields;
  console.log('  lapis note:', JSON.stringify({ ...f, MainDefinition: f.MainDefinition.slice(0, 90) + '…' }));
  check(add.params.note.modelName === 'Lapis' && f.Expression === '読む' && f.ExpressionFurigana === '読[よ]む', 'Lapis note fields');
  check(f.MainDefinition.includes('to read (a book)') && /<img src="mobilemining_dict_\w+\.png"/.test(f.MainDefinition), 'single-glossary marker with dictionary image uploaded');
  check(f.SentenceFurigana.includes('図書館[としょかん]') && f.SentenceFurigana.includes('昨日[きのう]'), `sentence furigana from the photo: ${f.SentenceFurigana}`);
  check(f.Sentence === '昨日は図書館で本を<b>読んだ</b>。', 'sentence without furigana');
  check(f.PitchPosition === '<span style="display:inline;"><span>[</span><span>1</span><span>]</span></span>' && f.FreqSort === '830', `pitch and frequency markers in Yomitan's format (${f.PitchPosition.replace(/<[^>]+>/g, '')})`);
  check(/^<img src="mobilemining_\d+\.jpg">$/.test(f.Picture), '{screenshot} maps to the photo');
}

// Zoom (Ctrl+wheel / trackpad pinch)
await page.keyboard.press('Escape');
const w0 = await page.$eval('[data-testid=image-reader] .image-wrap', (e) => e.getBoundingClientRect().width);
const box = await page.$eval('[data-testid=image-reader]', (e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
await page.mouse.move(box.x, box.y);
await page.keyboard.down('Control');
await page.mouse.wheel(0, -150);
await page.keyboard.up('Control');
await page.waitForTimeout(200);
const w1 = await page.$eval('[data-testid=image-reader] .image-wrap', (e) => e.getBoundingClientRect().width);
check(w1 > w0 * 1.5, `photo zooms (${w0.toFixed(0)}px → ${w1.toFixed(0)}px)`);
await shot('08b-zoomed');

// One-finger touch on a section box handle drags it (doesn't scroll the photo)
{
  const cdp = await context.newCDPSession(page);
  await ocr('dense-vertical.png');
  await toImage();
  await page.evaluate(() => { document.querySelector('.image-wrap').style.width = '250%'; });
  const r = await page.$eval('.image-scroll', (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  await page.click('[data-testid=select-area]');
  await page.mouse.move(r.x + r.w * 0.3, r.y + r.h * 0.2); await page.mouse.down(); await page.mouse.move(r.x + r.w * 0.6, r.y + r.h * 0.5, { steps: 5 }); await page.mouse.up();
  await page.waitForSelector('[data-handle=move]');
  const sc = () => page.$eval('.image-scroll', (e) => [e.scrollLeft, e.scrollTop].join(','));
  const w = () => page.$eval('[data-area] polygon.area-box', (e) => e.getBoundingClientRect().width);
  const c = await page.$eval('[data-handle="edge10"]', (e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  const [s0, w0] = [await sc(), await w()];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [c] });
  for (let i = 1; i <= 8; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: c.x + i * 8, y: c.y }] }); await page.waitForTimeout(16); }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(250);
  const [s1, w1] = [await sc(), await w()];
  check(w1 > w0 + 40 && s0 === s1, `one-finger touch drags a box handle without scrolling (${w0.toFixed(0)} → ${w1.toFixed(0)}px, scroll ${s0} → ${s1})`);
  // A new box that only partly overlaps an existing one still replaces it, and its handles work
  const old = await page.$eval('[data-area] polygon.area-box', (e) => { const r = e.getBoundingClientRect(); return { x: r.right, y: r.bottom }; });
  await page.click('[data-testid=area-bar] >> text=Done');
  await page.click('[data-testid=select-area]');
  await page.mouse.move(old.x - 20, old.y - 20); await page.mouse.down(); await page.mouse.move(old.x + 120, old.y + 140, { steps: 5 }); await page.mouse.up();
  await page.waitForTimeout(400);
  const nBoxes = () => page.$eval('[data-testid=image-reader] svg.overlay', (e) => Number(e.dataset.areas));
  check((await nBoxes()) === 1, `a new box replaces an older box it only partly covers (${await nBoxes()} box)`);
  const h = await page.$eval('[data-handle="edge-10"]', (e) => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  const wa = await w();
  await page.mouse.move(h.x, h.y); await page.mouse.down(); await page.mouse.move(h.x - 50, h.y, { steps: 4 }); await page.mouse.up();
  await page.waitForTimeout(250);
  check((await w()) > wa + 30, 'the new box\'s handles respond');
  // A small box, still selected: drawing a bigger box that starts on it replaces it (its handles don't catch the drag)
  {
    await page.click('[data-testid=area-delete]');
    const ids = () => page.$$eval('[data-area]', (els) => els.map((e) => e.dataset.area));
    const z = { x: r.x + r.w * 0.15, y: r.y + r.h * 0.55 };
    await page.click('[data-testid=select-area]');
    await page.mouse.move(z.x, z.y); await page.mouse.down(); await page.mouse.move(z.x + 40, z.y + 40, { steps: 3 }); await page.mouse.up();
    await page.waitForTimeout(300);
    const [smallId] = await ids();
    await page.click('[data-testid=select-area]');
    await page.mouse.move(z.x + 20, z.y + 20); await page.mouse.down(); await page.mouse.move(z.x + 180, z.y + 160, { steps: 6 }); await page.mouse.up();
    await page.waitForTimeout(400);
    const after = await ids();
    check(!!smallId && after.length === 1 && after[0] !== smallId && (await nBoxes()) === 1, `drawing over a small selected box replaces it (${smallId} → ${after.join(', ')})`);
  }
  await page.click('[data-testid=area-delete]');
  await cdp.detach();
}

// Backup & restore into a fresh browser profile
{
  await tab('Settings');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-testid=export-backup]')]);
  const backupPath = join(shots ?? dirname(fileURLToPath(import.meta.url)), 'backup-test.zip');
  await dl.saveAs(backupPath);
  const ctx2 = await browser.newContext({ ...devices['Pixel 7'] });
  const p2 = await ctx2.newPage();
  await p2.goto(base);
  await p2.click('.tabs >> text=Settings');
  await p2.setInputFiles('[data-testid=backup-file]', backupPath);
  await p2.waitForSelector('[data-testid=restore-report]', { timeout: 120_000 });
  const rep = await p2.$eval('[data-testid=restore-report]', (e) => e.innerText);
  console.log('  ' + rep.replace(/\n/g, '\n  '));
  const dictTitles = await p2.$$eval('.dict-title', (els) => els.map((e) => e.textContent));
  const model = await p2.evaluate(() => JSON.parse(localStorage.getItem('mobilemining.settings') ?? '{}').anki?.model ?? '');
  check(rep.includes('Settings') && dictTitles.includes('Test Dict') && dictTitles.includes('Test Freq') && /✓ [1-9]\d* mined/.test(rep) && model === 'Lapis', `backup restored in a new browser (dicts: ${dictTitles.join(', ')}; note type ${model})`);
  await ctx2.close();
}

// 9. Mined list
await tab('Mined');
await page.waitForSelector('.note');
// A card deleted in Anki is noticed (status re-checked) and can be sent again
{
  const status = () => page.$$eval('.note .badge', (b) => b.map((x) => x.textContent).join(','));
  const before = await status();
  deleted.add([...added.values()].at(-1));
  await page.click('[data-testid=resync]');
  await page.waitForFunction((b) => [...document.querySelectorAll('.note .badge')].map((x) => x.textContent).join(',') !== b, before, { timeout: 10_000 }).catch(() => {});
  const after = await status();
  const sends = (await page.$$('[data-testid=note-send]')).length;
  check(before.split(',').filter((x) => x === 'in Anki').length - after.split(',').filter((x) => x === 'in Anki').length === 1 && sends >= 1, `card deleted in Anki is marked as not sent (${before} → ${after})`);
  // Send it again, then mark it as not in Anki by hand
  const adds = ankiCalls.filter((c) => c.action === 'addNote').length;
  await page.click('[data-testid=note-send] >> nth=0');
  await page.waitForSelector('[data-testid=note-unmark]', { timeout: 15_000 });
  const resent = ankiCalls.filter((c) => c.action === 'addNote').length - adds;
  await page.click('[data-testid=note-unmark] >> nth=0');
  await page.waitForFunction(() => !document.querySelector('[data-testid=note-unmark]'));
  check(resent === 1, `the card is sent again; it can also be marked as not in Anki by hand (${resent} add)`);
}
check((await page.$$('.note')).length === 3, 'mined cards listed');
await shot('09-mined');

// 10. Picking an OCR alternative marks the character as selected
{
  await ocr('vertical2.png');
  const target = await page.evaluate(() => {
    const lines = globalThis.__mmLastOcr.lines;
    const flat = lines.flatMap((l) => l.chars);
    const i = flat.findIndex((c) => c.alts?.length && /\p{Script=Han}/u.test(c.c));
    const j = i >= 0 ? i : flat.findIndex((c) => c.alts?.length);
    return j < 0 ? null : { c: flat[j].c, nth: flat.slice(0, j).filter((x) => x.c === flat[j].c).length };
  });
  if (target) {
    await tapChar(target.c, target.nth);
    const before = await page.$eval('[data-testid=ocr-status]', (e) => e.textContent);
    await page.click('[data-testid=popup] .ocr-alts .alt >> nth=0');
    await page.waitForFunction(() => document.querySelector('[data-testid=ocr-status]')?.textContent.includes('selected'), null, { timeout: 10_000 }).catch(() => {});
    const after = await page.$eval('[data-testid=ocr-status]', (e) => e.textContent).catch(() => '');
    check(/%/.test(before) && /selected/.test(after) && !/%/.test(after), `picked alternative shows "selected" (${before} → ${after})`);
  } else console.log('  (no OCR alternatives to test)');
}

// 11. PDFs: text layer (horizontal, vertical CID fonts, ruby) and scanned pages via OCR
{
  const pdfText = async (f) => {
    await tab('Capture');
    await page.setInputFiles('[data-testid=file-input]', join(root, 'tests/fixtures', f));
    await page.waitForSelector('[data-testid=image-reader]');
    await page.waitForFunction(() => !document.querySelector('[data-testid=ocr-progress]') && document.querySelector('[data-testid=image-reader] .ch'), null, { timeout: 180_000 });
    await toText();
    return readerText();
  };
  const t = Date.now();
  const v = await pdfText('text-vertical.pdf');
  check(v.replace(/\n/g, '') === expected.join('') && Date.now() - t < 15_000, `PDF text layer, vertical (${v.replace(/\n/g, '/')})`);
  await toImage();
  check((await page.$eval('[data-testid=pager]', (e) => e.innerText)).replace(/\s/g, '') === '‹1/2›', 'PDF pager');
  await page.click('[data-testid=next-page]');
  await page.waitForFunction(() => document.querySelector('[data-testid=pager]')?.innerText.includes('2/2'));
  await page.waitForFunction(() => document.querySelector('[data-testid=reader] .line, [data-testid=image-reader] .ch'));
  await toText();
  const h = await readerText();
  check(h.replace(/\n/g, '') === expected.join(''), `PDF page 2, horizontal (${h.replace(/\n/g, '/')})`);
  await pdfText('text-ruby.pdf');
  const rts = await page.$$eval('[data-testid=reader] rt', (e) => e.map((x) => x.textContent));
  await toImage();
  check(['きのう', 'としょかん', 'ばら'].every((r) => rts.includes(r)) && !(await page.$('[data-testid=pager]')), `PDF ruby kept as furigana (${rts.join(' ')})`);
  const s = await pdfText('scanned.pdf');
  check(similarity(s.replace(/\n/g, ''), expected.join('')) > 0.95, `scanned PDF read by OCR (${s.replace(/\n/g, '/')})`);
}

// 12. Android: AnkiMobile is flagged as iOS-only; AnkiDroid gets the card through the share sheet
{
  await page.evaluate(() => { navigator.share = async (d) => { window.__shared = d; }; });
  await tab('Settings');
  await page.click('.segmented >> text=AnkiMobile');
  const warned = !!(await page.$('[data-testid=ankimobile-android]'));
  await page.click('.segmented >> text=AnkiDroid');
  await ocr('horizontal.png');
  await tapChar('読');
  await page.click('[data-testid=popup] [data-testid=mine-button] >> nth=0');
  await page.waitForFunction(() => window.__shared, null, { timeout: 10_000 }).catch(() => {});
  const shared = await page.evaluate(() => window.__shared ?? null);
  check(warned && shared?.title === '昨日は本を読まなかった。' && shared.text.startsWith('読む【よむ】') && shared.text.includes('to read') && !shared.text.includes('<'),
    `AnkiDroid share: front/back as text (${JSON.stringify(shared)?.slice(0, 120)}); AnkiMobile flagged on Android: ${warned}`);
}

// 13. Anki package: the user's own note type (loaded from an Anki export), cards + image inside
{
  await tab('Settings');
  await page.click('.segmented >> text=Export');
  await page.click('[data-testid=export-format] >> text=Anki package');
  await page.setInputFiles('[data-testid=notetype-file]', join(root, 'tests/fixtures/anki-lapis-modern.apkg'));
  await page.waitForFunction(() => document.querySelector('[data-testid=export-notetype]')?.textContent === 'Lapis', null, { timeout: 20_000 });
  await page.fill('[data-testid=export-deck]', 'Mining::Phone');
  await ocr('horizontal.png');
  await tapChar('読');
  await page.click('[data-testid=popup] [data-testid=mine-button] >> nth=0');
  await page.waitForSelector('.toast-ok');
  await tab('Mined');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-testid=send-apkg]')]);
  const zipBytes = new Uint8Array(await readFile(await dl.path()));
  if (process.env.MM_APKG_OUT) await dl.saveAs(join(process.env.MM_APKG_OUT, 'browser.apkg'));
  const { unzipSync, strFromU8 } = require(join(root, 'node_modules/fflate'));
  const files = unzipSync(zipBytes);
  const SQL = await require(join(root, 'node_modules/sql.js'))();
  const db = new SQL.Database(files['collection.anki2']);
  const notes = db.exec("SELECT CAST(mid AS TEXT), flds FROM notes")[0].values;
  const decks = db.exec('SELECT decks FROM col')[0].values[0][0];
  const last = notes.at(-1)[1].split('\x1f');
  const media = Object.values(JSON.parse(strFromU8(files.media)));
  check(notes.every((n) => n[0] === '1795597140674') && last[0] === '読む' && last.some((f) => f.includes('<b>読まなかった</b>')) && decks.includes('"Mining::Phone"') && media.some((m) => /\.jpg$/.test(m)),
    `Anki package with the Lapis note type: ${notes.length} notes, media ${media.join(', ')}, fields ${last.slice(0, 2).join(' | ')}`);
  check(!(await page.$('[data-testid=send-apkg]:not([disabled])')), 'sent cards are marked as in Anki');
  db.close();
}

// 14. Android app (Capacitor): the web side against a mocked native bridge. "AnkiDroid" then means
// its API: connect, list decks / note types, add notes with image and audio, duplicates.
{
  await context.addInitScript(() => {
    window.androidBridge = { postMessage() {} };
    const calls = (window.__native = []);
    const state = { granted: false, notes: [] };
    const impl = {
      AnkiDroid: {
        status: () => ({ installed: true, granted: state.granted }),
        requestAccess: () => { state.granted = true; return { installed: true, granted: true }; },
        decks: () => ({ names: ['Default', 'Mining'] }),
        models: () => ({ names: ['Basic', 'Lapis'] }),
        fields: ({ model }) => ({ names: model === 'Lapis' ? ['Expression', 'ExpressionFurigana', 'ExpressionReading', 'MainDefinition', 'Sentence', 'Picture', 'ExpressionAudio'] : ['Front', 'Back'] }),
        addDeck: () => ({ id: '1' }),
        addModel: () => ({ id: '2' }),
        findDuplicates: ({ key }) => ({ ids: state.notes.filter((n) => n.fields.Expression === key).map((n) => n.id) }),
        addMedia: (o) => ({ tag: o.kind === 'audio' ? `[sound:${o.name}_1.${o.ext}]` : `<img src="${o.name}_1.${o.ext}" />`, name: `${o.name}_1.${o.ext}` }),
        addNote: (o) => { const id = String(1700000000000 + state.notes.length); state.notes.push({ id, ...o }); return { id }; },
        updateNote: () => ({}),
        open: () => ({}),
      },
      Clipboard: { read: async () => ({ type: 'text/plain', value: await navigator.clipboard.readText() }) },
      // 読む has a recording; everything else gets the "not available" clip (52,288 bytes)
      CapacitorHttp: {
        get: ({ url }) => ({ status: 200, headers: {}, data: btoa('x'.repeat(decodeURIComponent(url).includes('読む') ? 3000 : 52288)) }),
        // native HTTP stands in for fetch (here it reaches the mocked AnkiConnect)
        post: async ({ url, data }) => { const r = await fetch(url, { method: 'POST', body: JSON.stringify(data) }); return { status: r.status, headers: {}, data: await r.json() }; },
      },
    };
    window.Capacitor = {
      PluginHeaders: Object.entries(impl).map(([name, m]) => ({ name, methods: Object.keys(m).map((n) => ({ name: n, rtype: 'promise' })) })),
      nativePromise: async (plugin, method, options) => { calls.push([plugin, method, options]); return impl[plugin][method](options ?? {}); },
    };
  });
  await page.reload();
  await tab('Settings');
  const methods = await page.$$eval('[data-testid=anki-settings] .segmented >> nth=0 >> button', (b) => b.map((x) => x.textContent));
  await page.click('.segmented >> text=AnkiDroid');
  await page.waitForSelector('.conn-error');
  await page.click('[data-testid=anki-connect]');
  await page.waitForSelector('.conn-ok');
  await page.selectOption('[data-testid=anki-deck]', 'Mining');
  await page.selectOption('[data-testid=anki-model]', 'Lapis');
  await page.waitForSelector('[data-field="ExpressionAudio"]');
  const audioField = await page.$eval('[data-field="ExpressionAudio"]', (e) => e.value);
  check(methods.join(',') === 'AnkiDroid,AnkiConnect,Export' && audioField === '{audio}', `app: AnkiDroid connects and lists note types (${methods.join(', ')}; audio field ${audioField})`);
  await ocr('horizontal.png');
  await tapChar('読');
  await page.click('[data-testid=popup] [data-testid=mine-button] >> nth=0');
  await page.waitForSelector('.toast-ok', { timeout: 20_000 });
  const native = await page.evaluate(() => window.__native.map(([p, m, o]) => [p, m, o]));
  const note = native.find(([, m]) => m === 'addNote')?.[2];
  const media = native.filter(([, m]) => m === 'addMedia').map(([, , o]) => `${o.kind}:${o.ext}:${o.data.length > 100}`);
  check(note?.model === 'Lapis' && note.deck === 'Mining' && note.fields.Expression === '読む' && note.fields.Sentence.includes('<b>読まなかった</b>')
    && /^<img src="mobilemining_\d+_1\.jpg">$/.test(note.fields.Picture) && /^\[sound:mobilemining_よむ_読む_1\.mp3\]$/.test(note.fields.ExpressionAudio) && note.tags.length > 0,
    `app: note added through AnkiDroid's API with picture and audio (${media.join(', ')}; ${note?.fields.Picture} ${note?.fields.ExpressionAudio})`);
  await page.click('[data-testid=close-panel]');
  await tapChar('読');
  await page.waitForFunction(() => document.querySelector('[data-testid=popup] [data-testid=mine-button]')?.classList.contains('dupe'), null, { timeout: 10_000 }).catch(() => {});
  check(await page.$eval('[data-testid=popup] [data-testid=mine-button]', (e) => e.classList.contains('dupe')), 'app: duplicates found through AnkiDroid');
  // A word without a recording: no audio file is stored
  await page.click('[data-testid=close-panel]');
  await tapChar('本');
  const before = await page.evaluate(() => window.__native.filter(([, m, o]) => m === 'addMedia' && o.kind === 'audio').length);
  await page.click('[data-testid=popup] [data-testid=mine-button] >> nth=0');
  await page.waitForFunction(() => window.__native.filter(([, m]) => m === 'addNote').length === 2, null, { timeout: 20_000 });
  const after = await page.evaluate(() => [window.__native.filter(([, m, o]) => m === 'addMedia' && o.kind === 'audio').length, window.__native.filter(([, m]) => m === 'addNote').at(-1)[2].fields.ExpressionAudio]);
  check(after[0] === before && after[1] === '', `app: the "not available" clip is not added as audio (${JSON.stringify(after)})`);
  // AnkiConnect in the app goes through native HTTP
  await tab('Settings');
  await page.click('.segmented >> text=AnkiConnect');
  await page.waitForFunction(() => window.__native.some(([p, m, o]) => p === 'CapacitorHttp' && m === 'post' && o.data.action === 'modelNames'), null, { timeout: 15_000 }).catch(() => {});
  await page.waitForSelector('.conn-ok', { timeout: 15_000 }).catch(() => {});
  const posts = await page.evaluate(() => window.__native.filter(([p, m, o]) => p === 'CapacitorHttp' && m === 'post').map(([, , o]) => o.data.action));
  check(!!(await page.$('.conn-ok')) && posts.includes('version') && posts.includes('deckNames'), `app: AnkiConnect through native HTTP (${[...new Set(posts)].join(', ')})`);
}

// 15. Text from the clipboard is opened and its first word looked up without further taps
{
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await tab('Capture');
  await page.evaluate(() => navigator.clipboard.writeText('昨日は図書館で本を読んだ。'));
  await page.click('[data-testid=text-button]');
  await page.waitForSelector('[data-testid=popup] .entry', { timeout: 15_000 }).catch(() => {});
  const head = await page.$eval('[data-testid=popup] .entry .headword', (e) => e.textContent).catch(() => '');
  check(head.startsWith('昨日') && (await readerText()).includes('図書館'), `clipboard text opens with its first word looked up (${head})`);
  // With nothing on the clipboard, the box to type in is shown instead
  await tab('Capture');
  await page.evaluate(() => navigator.clipboard.writeText(''));
  await page.click('[data-testid=text-button]');
  check(!!(await page.waitForSelector('.paste-area', { timeout: 5000 }).catch(() => null)), 'with an empty clipboard, Paste text shows the text box');
  await page.click('[data-testid=text-button]');
}

// 16. Handwriting: draw the character when it isn't among the OCR's candidates
{
  await ocr('horizontal.png');
  await tapChar('猫');
  await page.click('[data-testid=handwrite-open]');
  const pad = await page.$eval('.handwrite-pad', (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  const strokes = [[[0.15, 0.35], [0.85, 0.35]], [[0.5, 0.1], [0.5, 0.9]], [[0.48, 0.38], [0.15, 0.8]], [[0.52, 0.38], [0.85, 0.8]]]; // 木
  for (const st of strokes) {
    await page.mouse.move(pad.x + st[0][0] * pad.w, pad.y + st[0][1] * pad.h);
    await page.mouse.down();
    for (const pt of st.slice(1)) await page.mouse.move(pad.x + pt[0] * pad.w, pad.y + pt[1] * pad.h, { steps: 6 });
    await page.mouse.up();
  }
  await page.waitForSelector('[data-testid=handwrite-cand]', { timeout: 30_000 }).catch(() => {});
  const cands = await page.$$eval('[data-testid=handwrite-cand]', (e) => e.map((x) => x.textContent));
  if (cands[0] === '木') await page.click('[data-testid=handwrite-cand] >> nth=0');
  await page.waitForFunction(() => document.querySelector('[data-testid=ocr-status]')?.textContent.includes('selected'), null, { timeout: 10_000 }).catch(() => {});
  await toText();
  const text = await readerText();
  check(cands[0] === '木' && text.includes('吾輩は木である'), `handwritten character recognized and put in the text (${cands.slice(0, 4).join(' ')}; ${text.split('\n')[0]})`);
}

await browser.close();
server.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
