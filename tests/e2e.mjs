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

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
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

// Mock AnkiConnect
const ankiCalls = [];
await page.route('http://127.0.0.1:8765/**', async (route) => {
  const body = JSON.parse(route.request().postData() ?? '{}');
  ankiCalls.push(body);
  const results = {
    version: 6,
    requestPermission: { permission: 'granted' },
    deckNames: ['Default', 'Mining'],
    modelNames: ['Basic', 'Japanese Sentence'],
    modelFieldNames: ['Word', 'Reading', 'Sentence', 'Meaning', 'Picture', 'Audio'],
    canAddNotes: [true],
    storeMediaFile: body.params?.filename,
    addNote: 1700000000000,
  };
  await route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ result: results[body.action] ?? null, error: null }) });
});

let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? '✔' : '✘'} ${msg}`);
  if (!cond) failures++;
};
const shot = async (name) => shots && page.screenshot({ path: join(shots, `${name}.png`) });

await page.goto(base);
await shot('01-capture');

// 1. Install dictionary
const t0 = Date.now();
await page.click('[data-testid=install-dict]');
await page.waitForSelector('[data-testid=install-dict]', { state: 'detached', timeout: 240_000 });
await page.waitForFunction(() => !document.querySelector('.card.notice'), null, { timeout: 240_000 });
console.log(`  dictionary installed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// 2. Configure AnkiConnect through the settings UI
await page.click('text=Settings');
await page.click('text=AnkiConnect');
await page.click('[data-testid=anki-connect]');
await page.waitForSelector('text=Connected (AnkiConnect v6)');
await page.selectOption('.settings select >> nth=0', 'Mining');
await page.selectOption('.settings select >> nth=1', 'Japanese Sentence');
await page.waitForSelector('.field-map');
const mapping = await page.$$eval('.field-map', (els) => els.map((e) => [e.querySelector('.field-name').textContent, e.querySelector('input').value]));
check(JSON.stringify(mapping) === JSON.stringify([['Word', '{expression}'], ['Reading', '{reading}'], ['Sentence', '{sentence}'], ['Meaning', '{glossary}'], ['Picture', '{image}'], ['Audio', '{audio}']]), `fields auto-mapped: ${JSON.stringify(mapping)}`);
await shot('02-settings');
await page.click('text=Capture');

async function ocr(fixture) {
  const t = Date.now();
  await page.setInputFiles('[data-testid=file-input]', join(root, 'tests/fixtures', fixture));
  await page.waitForSelector('[data-testid=reader] .line span', { timeout: 180_000 });
  await page.waitForFunction(() => !document.querySelector('.busy-overlay'), null, { timeout: 180_000 });
  const text = await page.$eval('[data-testid=reader]', (el) => [...el.querySelectorAll('.line')].map((l) => l.textContent).join('\n'));
  console.log(`  ${fixture} OCR in ${((Date.now() - t) / 1000).toFixed(1)}s:\n    ${text.replace(/\n/g, '\n    ')}`);
  return text;
}

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
  await page.click('text=Capture');
}

// 3. Look up 読まなかった in the last (horizontal) page and mine it
await ocr('horizontal.png');
const idx = await page.$$eval('[data-testid=reader] span[data-i]', (els) => els.find((e) => e.textContent === '読')?.dataset.i);
await page.click(`[data-i="${idx}"]`);
await page.waitForSelector('[data-testid=popup] .entry');
const head = await page.$eval('[data-testid=popup] .entry .headword', (e) => e.textContent);
const reasons = await page.$eval('[data-testid=popup] .entry .reasons', (e) => e.textContent).catch(() => '');
check(head.includes('読む') || head.includes('読よむ'), `popup headword: ${head} ${reasons}`);
check(reasons.includes('negative') && reasons.includes('past'), 'deinflection reasons shown');
await shot('04-popup');

await page.click('[data-testid=popup] [data-testid=mine-button] >> nth=0');
await page.waitForSelector('[data-testid=mine-sheet]');
const sentence = await page.$eval('[data-testid=sentence]', (e) => e.value);
check(sentence === '昨日は本を読まなかった。', `sentence extracted: ${sentence}`);
await shot('05-mine');
await page.click('[data-testid=mine-submit]');
await page.waitForSelector('.toast-ok', { timeout: 20_000 });
const add = ankiCalls.find((c) => c.action === 'addNote');
check(!!add, 'addNote sent to AnkiConnect');
if (add) {
  const f = add.params.note.fields;
  console.log('  note:', JSON.stringify({ deck: add.params.note.deckName, model: add.params.note.modelName, ...f, Meaning: f.Meaning.slice(0, 60) + '…' }));
  check(f.Word === '読む' && f.Reading === 'よむ', 'word/reading fields');
  check(f.Sentence === '昨日は本を<b>読まなかった</b>。', 'sentence bolds the inflected word');
  check(/^<img src="mobilemining_\d+\.jpg">$/.test(f.Picture), 'picture stored via storeMediaFile');
  check(add.params.note.audio?.[0]?.fields?.[0] === 'Audio', 'audio requested for Audio field');
  check(ankiCalls.some((c) => c.action === 'storeMediaFile' && c.params.data.length > 1000), 'image data uploaded');
}

// 4. Mined list
await page.click('text=Mined');
await page.waitForSelector('.note');
check((await page.$$('.note')).length === 1, 'mined card listed');
await shot('06-mined');

await browser.close();
server.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
