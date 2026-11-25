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
let nextId = 1700000000000;
await page.route('http://127.0.0.1:8765/**', async (route) => {
  const body = JSON.parse(route.request().postData() ?? '{}');
  ankiCalls.push(body);
  const p = body.params ?? {};
  let result = null;
  switch (body.action) {
    case 'version': result = 6; break;
    case 'requestPermission': result = { permission: 'granted' }; break;
    case 'deckNames': result = ['Default', 'Mining']; break;
    case 'modelNames': result = ['Basic', 'Japanese Sentence', 'Lapis']; break;
    case 'modelFieldNames':
      result = p.modelName === 'Lapis'
        ? ['Expression', 'ExpressionFurigana', 'MainDefinition', 'Sentence', 'SentenceFurigana', 'PitchPosition', 'FreqSort', 'Picture']
        : p.modelName === 'MobileMining'
          ? ['Word', 'Reading', 'Furigana', 'Meaning', 'Sentence', 'SentenceFurigana', 'Picture', 'Audio', 'PitchAccent', 'Frequency', 'Source']
          : ['Word', 'Reading', 'Sentence', 'Meaning', 'Picture', 'Audio'];
      break;
    case 'findNotes': {
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
  check((await page.$$('[data-area]')).length === 1, `a new box replaces an older box it only partly covers (${(await page.$$('[data-area]')).length} box)`);
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
    check(!!smallId && after.length === 1 && after[0] !== smallId, `drawing over a small selected box replaces it (${smallId} → ${after.join(', ')})`);
  }
  await page.click('[data-testid=area-delete]');
  await cdp.detach();
}

await browser.close();
server.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
