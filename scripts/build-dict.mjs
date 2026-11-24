#!/usr/bin/env node
// Builds the compact dictionary files the app imports into IndexedDB on first run.
//
//   JMdict_e.gz      -> public/dict/jmdict.json.gz   (terms)
//   kanjidic2.xml.gz -> public/dict/kanjidic.json.gz (kanji)
//                    -> public/dict/tags.json        (JMdict entity descriptions)
//
// Sources are the official EDRDG files (CC BY-SA 4.0). They are cached in .cache/.
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { gunzipSync, gzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cacheDir = join(root, '.cache');
const outDir = join(root, 'public', 'dict');

const SOURCES = {
  jmdict: { url: 'https://www.edrdg.org/pub/Nihongo/JMdict_e.gz', file: 'JMdict_e.gz' },
  kanjidic: { url: 'https://www.edrdg.org/kanjidic/kanjidic2.xml.gz', file: 'kanjidic2.xml.gz' },
};

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

async function download({ url, file }) {
  const dest = join(cacheDir, file);
  if (await exists(dest)) return dest;
  console.log(`Downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
  return dest;
}

const XML_ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
function unescapeXml(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return XML_ENTITIES[e] ?? m;
  });
}

/** All inner texts of <tag>...</tag> inside block. JMdict entity references (&v5r;) are returned as the bare code. */
function all(block, tag) {
  const out = [];
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
  let m;
  while ((m = re.exec(block))) {
    const v = m[1];
    const ent = /^&([\w\-.]+);$/.exec(v);
    out.push(ent && !(ent[1] in XML_ENTITIES) ? ent[1] : unescapeXml(v));
  }
  return out;
}
const one = (block, tag) => all(block, tag)[0];
const has = (block, tag) => new RegExp(`<${tag}\\s*/>`).test(block);

const COMMON_PRI = new Set(['news1', 'ichi1', 'spec1', 'spec2', 'gai1']);

/** Lower is more frequent/important. 0..~100 */
function priorityScore(pris) {
  let best = 1000;
  for (const p of pris) {
    const nf = /^nf(\d+)$/.exec(p);
    if (nf) best = Math.min(best, Number(nf[1]));
    else if (p === 'news1' || p === 'ichi1' || p === 'spec1') best = Math.min(best, 24);
    else if (p === 'spec2' || p === 'gai1') best = Math.min(best, 36);
    else if (p === 'news2' || p === 'ichi2' || p === 'gai2') best = Math.min(best, 60);
  }
  return best;
}

async function buildJmdict() {
  const xml = gunzipSync(await readFile(await download(SOURCES.jmdict))).toString('utf8');

  // Entity descriptions (part of speech, misc, field, dialect tags).
  const tags = {};
  for (const m of xml.matchAll(/<!ENTITY ([\w\-.]+) "([^"]*)">/g)) tags[m[1]] = m[2];

  const entries = [];
  const body = xml.slice(xml.indexOf('<JMdict>'));
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = entryRe.exec(body))) {
    const e = m[1];
    const seq = Number(one(e, 'ent_seq'));
    const k = [];
    for (const kb of all(e, 'k_ele')) {
      const kpri = all(kb, 'ke_pri');
      const item = { t: one(kb, 'keb') };
      const inf = all(kb, 'ke_inf');
      if (inf.length) item.i = inf;
      if (kpri.length) item.p = priorityScore(kpri);
      if (kpri.some((p) => COMMON_PRI.has(p))) item.c = 1;
      k.push(item);
    }
    const r = [];
    for (const rb of all(e, 'r_ele')) {
      const rpri = all(rb, 're_pri');
      const item = { t: one(rb, 'reb') };
      if (has(rb, 're_nokanji')) item.n = 1;
      const restr = all(rb, 're_restr');
      if (restr.length) item.r = restr;
      const inf = all(rb, 're_inf');
      if (inf.length) item.i = inf;
      if (rpri.length) item.p = priorityScore(rpri);
      if (rpri.some((p) => COMMON_PRI.has(p))) item.c = 1;
      r.push(item);
    }
    const s = [];
    let lastPos = [];
    for (const sb of all(e, 'sense')) {
      let pos = all(sb, 'pos');
      if (pos.length) lastPos = pos; else pos = lastPos;
      const sense = { p: pos, g: all(sb, 'gloss') };
      const misc = all(sb, 'misc');
      if (misc.length) sense.m = misc;
      const field = all(sb, 'field');
      if (field.length) sense.f = field;
      const dial = all(sb, 'dial');
      if (dial.length) sense.d = dial;
      const info = all(sb, 's_inf');
      if (info.length) sense.n = info.join('; ');
      const stagk = all(sb, 'stagk');
      if (stagk.length) sense.sk = stagk;
      const stagr = all(sb, 'stagr');
      if (stagr.length) sense.sr = stagr;
      const xref = all(sb, 'xref');
      if (xref.length) sense.x = xref.map((x) => x.split('・')[0]);
      if (sense.g.length) s.push(sense);
    }
    if (!s.length) continue;
    entries.push({ id: seq, k, r, s });
  }
  console.log(`JMdict: ${entries.length} entries, ${Object.keys(tags).length} tags`);
  return { entries, tags };
}

async function buildKanjidic() {
  const xml = gunzipSync(await readFile(await download(SOURCES.kanjidic))).toString('utf8');
  const out = [];
  const re = /<character>([\s\S]*?)<\/character>/g;
  let m;
  while ((m = re.exec(xml))) {
    const c = m[1];
    const k = { c: one(c, 'literal') };
    const readings = [...c.matchAll(/<reading r_type="(ja_on|ja_kun)"[^>]*>([^<]*)<\/reading>/g)];
    k.on = readings.filter((x) => x[1] === 'ja_on').map((x) => x[2]);
    k.kun = readings.filter((x) => x[1] === 'ja_kun').map((x) => x[2]);
    k.m = [...c.matchAll(/<meaning>([^<]*)<\/meaning>/g)].map((x) => unescapeXml(x[1]));
    const nanori = all(c, 'nanori');
    if (nanori.length) k.na = nanori;
    const sc = one(c, 'stroke_count');
    if (sc) k.sc = Number(sc);
    const g = one(c, 'grade');
    if (g) k.g = Number(g);
    const f = one(c, 'freq');
    if (f) k.f = Number(f);
    const j = one(c, 'jlpt');
    if (j) k.j = Number(j);
    const rad = /<rad_value rad_type="classical">(\d+)<\/rad_value>/.exec(c);
    if (rad) k.rad = Number(rad[1]);
    out.push(k);
  }
  console.log(`KANJIDIC2: ${out.length} kanji`);
  return out;
}

await mkdir(cacheDir, { recursive: true });
await mkdir(outDir, { recursive: true });

const { entries, tags } = await buildJmdict();
const kanji = await buildKanjidic();
const version = new Date().toISOString().slice(0, 10);

const jm = gzipSync(JSON.stringify({ format: 1, title: 'JMdict (English)', version, entries }), { level: 9 });
await writeFile(join(outDir, 'jmdict.json.gz'), jm);
const kd = gzipSync(JSON.stringify({ format: 1, title: 'KANJIDIC2', version, kanji }), { level: 9 });
await writeFile(join(outDir, 'kanjidic.json.gz'), kd);
await writeFile(join(outDir, 'tags.json'), JSON.stringify(tags));
await writeFile(
  join(outDir, 'manifest.json'),
  JSON.stringify({ version, files: { jmdict: { file: 'jmdict.json.gz', size: jm.length, count: entries.length }, kanjidic: { file: 'kanjidic.json.gz', size: kd.length, count: kanji.length } } }, null, 1),
);
console.log(`Wrote jmdict.json.gz (${(jm.length / 1e6).toFixed(1)} MB), kanjidic.json.gz (${(kd.length / 1e6).toFixed(1)} MB)`);
