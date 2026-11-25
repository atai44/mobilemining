// Anki packages (.apkg) built in the browser: the closest a web page can get to AnkiConnect on a
// phone. Cards use the user's own note type (read once from a package they export from Anki), so
// importing files them under that note type instead of creating a copy. Images and dictionary
// images travel inside the package.
//
// Written in the legacy collection format (collection.anki2 + JSON media map), which every Anki
// and AnkiDroid version imports. Read: legacy packages and current ones (zstd-compressed
// collection.anki21b, note types stored as protobuf).
import { unzipSync, zipSync, strToU8, type Zippable } from 'fflate';
import type { Database, SqlJsStatic } from 'sql.js';
import type { MinedNote } from './db';
import type { Settings } from './settings';
import { fillTemplate, hash, MEDIA_MARKERS, MM_BACK, MM_CSS, MM_FIELDS, MM_MODEL, MM_FRONT } from './anki';
import { getMedia } from './yomitan/query';

/** A note type as stored in settings. Ids stay decimal strings: they exceed JS number precision. */
export interface AnkiNotetype {
  id: string;
  name: string;
  /** 0 standard, 1 cloze */
  kind: 0 | 1;
  sortf: number;
  css: string;
  latexPre: string;
  latexPost: string;
  mtime: number;
  fields: { name: string; ord: number; id?: string; font?: string; size?: number }[];
  templates: { name: string; ord: number; qfmt: string; afmt: string; bqfmt?: string; bafmt?: string; id?: string }[];
}

// --- sql.js ------------------------------------------------------------------------------------

let SQL: Promise<SqlJsStatic> | null = null;
/** Tests (Node) supply their own sql.js instance. */
export function setSqlJs(p: Promise<SqlJsStatic>) { SQL = p; }
function sqljs(): Promise<SqlJsStatic> {
  SQL ??= (async () => {
    const [{ default: init }, { default: wasmUrl }] = await Promise.all([import('sql.js'), import('sql.js/dist/sql-wasm.wasm?url')]);
    return init({ locateFile: () => wasmUrl });
  })();
  return SQL;
}

// --- Reading note types from a package -------------------------------------------------------

/** Minimal protobuf reader: field number → values (varints as bigint, bytes as Uint8Array). */
function protobuf(buf: Uint8Array): Map<number, (bigint | Uint8Array)[]> {
  const out = new Map<number, (bigint | Uint8Array)[]>();
  let i = 0;
  const varint = () => {
    let v = 0n, shift = 0n;
    for (;;) {
      const b = buf[i++];
      v |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return v;
      shift += 7n;
    }
  };
  while (i < buf.length) {
    const key = Number(varint());
    const field = key >> 3, wire = key & 7;
    let val: bigint | Uint8Array;
    if (wire === 0) val = varint();
    else if (wire === 2) { const n = Number(varint()); val = buf.subarray(i, i + n); i += n; }
    else if (wire === 1) { val = buf.subarray(i, i + 8); i += 8; }
    else if (wire === 5) { val = buf.subarray(i, i + 4); i += 4; }
    else break;
    out.set(field, [...(out.get(field) ?? []), val]);
  }
  return out;
}
const pbStr = (m: Map<number, (bigint | Uint8Array)[]>, f: number) => { const v = m.get(f)?.[0]; return v instanceof Uint8Array ? new TextDecoder().decode(v) : ''; };
const pbInt = (m: Map<number, (bigint | Uint8Array)[]>, f: number) => { const v = m.get(f)?.[0]; return typeof v === 'bigint' ? BigInt.asIntN(64, v) : undefined; };

function rows(db: Database, sql: string): Record<string, unknown>[] {
  const res = db.exec(sql)[0];
  if (!res) return [];
  return res.values.map((v) => Object.fromEntries(res.columns.map((c, i) => [c, v[i]])));
}

/** JSON with integers too large for a JS number kept as strings. */
function parseBigJson(text: string): any {
  return JSON.parse(text.replace(/([:[,]\s*)(-?\d{16,})(?=\s*[,}\]])/g, '$1"$2"'));
}

/** The note types in an Anki package (.apkg / .colpkg), with how many notes use each. */
export async function readNotetypes(file: ArrayBuffer): Promise<{ notetype: AnkiNotetype; notes: number }[]> {
  const files = unzipSync(new Uint8Array(file));
  let bytes: Uint8Array | undefined;
  let modern = false;
  if (files['collection.anki21b']) {
    const { decompress } = await import('fzstd');
    bytes = decompress(files['collection.anki21b']);
    modern = true;
  } else bytes = files['collection.anki21'] ?? files['collection.anki2'];
  if (!bytes) throw new Error('Not an Anki package');
  const SQLs = await sqljs();
  let db = new SQLs.Database(bytes);
  try {
    const counts = new Map<string, number>();
    for (const r of rows(db, 'SELECT CAST(mid AS TEXT) AS mid, COUNT(*) AS n FROM notes GROUP BY mid')) counts.set(String(r.mid), Number(r.n));
    const out: AnkiNotetype[] = [];
    if (modern) {
      // The schema uses Anki's own "unicase" collation, which sql.js doesn't have: drop it.
      db.exec("PRAGMA writable_schema=ON; UPDATE sqlite_master SET sql=replace(sql,' COLLATE unicase','') WHERE sql LIKE '%unicase%'; PRAGMA writable_schema=OFF;");
      const data = db.export();
      db.close();
      db = new SQLs.Database(data);
      const fields = rows(db, 'SELECT CAST(ntid AS TEXT) AS ntid, ord, name, config FROM fields ORDER BY ntid, ord');
      const templates = rows(db, 'SELECT CAST(ntid AS TEXT) AS ntid, ord, name, config FROM templates ORDER BY ntid, ord');
      for (const n of rows(db, 'SELECT CAST(id AS TEXT) AS id, name, mtime_secs, config FROM notetypes')) {
        const c = protobuf(n.config as Uint8Array);
        out.push({
          id: String(n.id), name: String(n.name), mtime: Number(n.mtime_secs),
          kind: pbInt(c, 1) === 1n ? 1 : 0, sortf: Number(pbInt(c, 2) ?? 0n), css: pbStr(c, 3), latexPre: pbStr(c, 5), latexPost: pbStr(c, 6),
          fields: fields.filter((f) => f.ntid === n.id).map((f) => {
            const fc = protobuf(f.config as Uint8Array);
            return { name: String(f.name), ord: Number(f.ord), font: pbStr(fc, 3) || 'Arial', size: Number(pbInt(fc, 4) ?? 20n), id: pbInt(fc, 9)?.toString() };
          }),
          templates: templates.filter((t) => t.ntid === n.id).map((t) => {
            const tc = protobuf(t.config as Uint8Array);
            return { name: String(t.name), ord: Number(t.ord), qfmt: pbStr(tc, 1), afmt: pbStr(tc, 2), bqfmt: pbStr(tc, 3), bafmt: pbStr(tc, 4), id: pbInt(tc, 8)?.toString() };
          }),
        });
      }
    } else {
      const models = parseBigJson(String(rows(db, 'SELECT models FROM col')[0]?.models ?? '{}'));
      for (const m of Object.values(models) as any[]) {
        out.push({
          id: String(m.id), name: m.name, kind: m.type === 1 ? 1 : 0, sortf: m.sortf ?? 0, css: m.css ?? '', latexPre: m.latexPre ?? '', latexPost: m.latexPost ?? '', mtime: m.mod ?? 0,
          fields: (m.flds ?? []).map((f: any) => ({ name: f.name, ord: f.ord, font: f.font, size: f.size, id: f.id != null ? String(f.id) : undefined })),
          templates: (m.tmpls ?? []).map((t: any) => ({ name: t.name, ord: t.ord, qfmt: t.qfmt, afmt: t.afmt, bqfmt: t.bqfmt ?? '', bafmt: t.bafmt ?? '', id: t.id != null ? String(t.id) : undefined })),
        });
      }
    }
    return out.map((notetype) => ({ notetype, notes: counts.get(notetype.id) ?? 0 })).sort((a, b) => b.notes - a.notes);
  } finally {
    db.close();
  }
}

/** The built-in MobileMining note type (fixed ids, so repeated imports reuse it). */
export function builtinNotetype(): AnkiNotetype {
  return {
    id: '1735689600001', name: MM_MODEL, kind: 0, sortf: 0, css: MM_CSS, latexPre: '', latexPost: '', mtime: 1735689600,
    fields: Object.keys(MM_FIELDS).map((name, ord) => ({ name, ord })),
    templates: [{ name: 'Sentence → Word', ord: 0, qfmt: MM_FRONT, afmt: MM_BACK }],
  };
}

// --- Writing a package -----------------------------------------------------------------------

const SCHEMA = `
CREATE TABLE col (id integer PRIMARY KEY, crt integer NOT NULL, mod integer NOT NULL, scm integer NOT NULL, ver integer NOT NULL, dty integer NOT NULL, usn integer NOT NULL, ls integer NOT NULL, conf text NOT NULL, models text NOT NULL, decks text NOT NULL, dconf text NOT NULL, tags text NOT NULL);
CREATE TABLE notes (id integer PRIMARY KEY, guid text NOT NULL, mid integer NOT NULL, mod integer NOT NULL, usn integer NOT NULL, tags text NOT NULL, flds text NOT NULL, sfld integer NOT NULL, csum integer NOT NULL, flags integer NOT NULL, data text NOT NULL);
CREATE TABLE cards (id integer PRIMARY KEY, nid integer NOT NULL, did integer NOT NULL, ord integer NOT NULL, mod integer NOT NULL, usn integer NOT NULL, type integer NOT NULL, queue integer NOT NULL, due integer NOT NULL, ivl integer NOT NULL, factor integer NOT NULL, reps integer NOT NULL, lapses integer NOT NULL, left integer NOT NULL, odue integer NOT NULL, odid integer NOT NULL, flags integer NOT NULL, data text NOT NULL);
CREATE TABLE revlog (id integer PRIMARY KEY, cid integer NOT NULL, usn integer NOT NULL, ease integer NOT NULL, ivl integer NOT NULL, lastIvl integer NOT NULL, factor integer NOT NULL, time integer NOT NULL, type integer NOT NULL);
CREATE TABLE graves (usn integer NOT NULL, oid integer NOT NULL, type integer NOT NULL);
CREATE INDEX ix_notes_usn ON notes (usn); CREATE INDEX ix_cards_usn ON cards (usn); CREATE INDEX ix_revlog_usn ON revlog (usn);
CREATE INDEX ix_cards_nid ON cards (nid); CREATE INDEX ix_cards_sched ON cards (did, queue, due); CREATE INDEX ix_revlog_cid ON revlog (cid); CREATE INDEX ix_notes_csum ON notes (csum);`;

const DECK_CONF = { id: 1, mod: 0, name: 'Default', usn: 0, maxTaken: 60, autoplay: true, timer: 0, replayq: true, new: { bury: false, delays: [1, 10], initialFactor: 2500, ints: [1, 4, 0], order: 1, perDay: 20 }, rev: { bury: false, ease4: 1.3, ivlFct: 1, maxIvl: 36500, perDay: 200, hardFactor: 1.2 }, lapse: { delays: [10], leechAction: 1, leechFails: 8, minInt: 1, mult: 0 }, dyn: false, newMix: 0, newPerDayMinimum: 0, interdayLearningMix: 0, reviewOrder: 0, newSortOrder: 0, newGatherPriority: 0, buryInterdayLearning: false };

const deckJson = (id: string, name: string, mod: number) => ({ id: `§${id}§`, mod, name, usn: -1, lrnToday: [0, 0], revToday: [0, 0], newToday: [0, 0], timeToday: [0, 0], collapsed: false, browserCollapsed: false, desc: '', dyn: 0, conf: 1, extendNew: 0, extendRev: 0 });

/** JSON in which "§123§" strings become bare (big) integers. */
const bigJson = (v: unknown) => JSON.stringify(v).replace(/"§(-?\d+)§"/g, '$1');

function modelJson(nt: AnkiNotetype, did: string) {
  return {
    id: `§${nt.id}§`, name: nt.name, type: nt.kind, mod: nt.mtime, usn: -1, sortf: nt.sortf, did: `§${did}§`,
    tmpls: nt.templates.map((t) => ({ name: t.name, ord: t.ord, qfmt: t.qfmt, afmt: t.afmt, bqfmt: t.bqfmt ?? '', bafmt: t.bafmt ?? '', did: null, bfont: '', bsize: 0, ...(t.id ? { id: `§${t.id}§` } : {}) })),
    flds: nt.fields.map((f) => ({ name: f.name, ord: f.ord, sticky: false, rtl: false, font: f.font ?? 'Arial', size: f.size ?? 20, description: '', plainText: false, collapsed: false, excludeFromSearch: false, ...(f.id ? { id: `§${f.id}§` } : {}) })),
    css: nt.css, latexPre: nt.latexPre, latexPost: nt.latexPost, latexsvg: false, req: [[0, 'any', [0]]],
  };
}

const stripHtml = (s: string) => s.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim();

async function checksum(field: string): Promise<number> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(stripHtml(field))));
  return ((digest[0] << 24) | (digest[1] << 16) | (digest[2] << 8) | digest[3]) >>> 0;
}

const SPECIAL = new Set(['FrontSide', 'Tags', 'Type', 'Deck', 'Subdeck', 'Card', 'CardFlag', 'CardID']);

/** Does a card template's front show any field content (Anki's rule for creating a card)? */
export function templateNonEmpty(qfmt: string, fields: Record<string, string>): boolean {
  const has = (name: string) => !!stripHtml(fields[name] ?? '') || /<img|\[sound:/i.test(fields[name] ?? '');
  // Evaluate {{#F}}…{{/F}} and {{^F}}…{{/F}} sections, innermost first.
  let t = qfmt, prev = '';
  while (t !== prev) {
    prev = t;
    t = t.replace(/\{\{([#^])\s*([^}]+?)\s*\}\}((?:(?!\{\{[#^])[\s\S])*?)\{\{\/\s*\2\s*\}\}/g, (_m, kind: string, name: string, body: string) => ((kind === '#') === has(name) ? body : ''));
  }
  for (const m of t.matchAll(/\{\{([^#^/}][^}]*)\}\}/g)) {
    const name = m[1].trim().split(':').pop()!.trim();
    if (!SPECIAL.has(name) && has(name)) return true;
  }
  return false;
}

export interface PackageOptions {
  notetype: AnkiNotetype;
  /** Field name → marker template */
  fields: Record<string, string>;
  deck: string;
  tags: string;
}

export interface PackageResult { blob: Blob; notes: number; cards: number }

/** Builds an .apkg holding `notes` (each mined card becomes one note; re-importing updates it). */
export async function buildApkg(notes: MinedNote[], opt: PackageOptions): Promise<PackageResult> {
  const SQLs = await sqljs();
  const db = new SQLs.Database();
  const nt = opt.notetype;
  const now = Date.now(), nowS = Math.floor(now / 1000);
  const deckName = opt.deck.trim() || 'Default';
  const did = deckName === 'Default' ? '1' : String(1_600_000_000_000 + (parseInt(hash('deck:' + deckName), 36) % 100_000_000_000));
  const media: { name: string; data: Uint8Array }[] = [];
  const mediaNames = new Set<string>();
  const addMedia = async (name: string, blob: Blob) => {
    if (mediaNames.has(name)) return;
    mediaNames.add(name);
    media.push({ name, data: new Uint8Array(await blob.arrayBuffer()) });
  };
  try {
    db.exec(SCHEMA);
    const decks: Record<string, unknown> = { 1: deckJson('1', 'Default', 0) };
    decks[did] = deckJson(did, deckName, nowS);
    const conf = { activeDecks: [1], curDeck: 1, newSpread: 0, collapseTime: 1200, timeLim: 0, estTimes: true, dueCounts: true, curModel: `§${nt.id}§`, nextPos: 1, sortType: 'noteFld', sortBackwards: false, addToCur: true, schedVer: 2 };
    db.run('INSERT INTO col VALUES (1,?,?,?,11,0,0,0,?,?,?,?,?)', [
      Math.floor(new Date().setHours(0, 0, 0, 0) / 1000), now, now, bigJson(conf), bigJson({ [nt.id]: modelJson(nt, did) }), bigJson(decks), JSON.stringify({ 1: DECK_CONF }), '{}',
    ]);
    const tags = opt.tags.split(/\s+/).filter(Boolean);
    const ordered = [...nt.fields].sort((a, b) => a.ord - b.ord);
    let cardCount = 0, pos = 1, lastId = 0;
    for (const n of notes) {
      // Values: the marker values saved when the card was mined, plus media.
      const values: Record<string, string> = { ...n.fields };
      for (const m of MEDIA_MARKERS) values[m] = '';
      if (n.image) {
        const name = `mobilemining_${n.created}.jpg`;
        await addMedia(name, n.image);
        values.image = values.screenshot = `<img src="${name}">`;
      }
      const flds: Record<string, string> = {};
      for (const f of ordered) {
        let v = fillTemplate(opt.fields[f.name] ?? '', values).trim();
        // Images from dictionaries: into the package, referenced by file name.
        for (const m of [...v.matchAll(/<img [^>]*data-media-dict="([^"]*)" data-media-path="([^"]*)"[^>]*>/g)]) {
          const dict = m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'), path = m[2].replace(/&quot;/g, '"').replace(/&amp;/g, '&');
          const blob = await getMedia(dict, path).catch(() => undefined);
          if (!blob) { v = v.replace(m[0], ''); continue; }
          const name = `mobilemining_dict_${hash(dict + '/' + path)}.${path.split('.').pop() ?? 'png'}`;
          await addMedia(name, blob);
          v = v.replace(m[0], `<img src="${name}" style="${/style="([^"]*)"/.exec(m[0])?.[1] ?? ''}">`);
        }
        flds[f.name] = v;
      }
      const id = Math.max(n.created, lastId + 1);
      lastId = id;
      const values0 = ordered.map((f) => flds[f.name]);
      db.run('INSERT INTO notes VALUES (?,?,?,?,-1,?,?,?,?,0,\'\')', [
        id, `mm${n.created.toString(36)}`, nt.id, nowS, tags.length ? ` ${tags.join(' ')} ` : '', values0.join('\x1f'),
        stripHtml(values0[nt.sortf] ?? ''), await checksum(values0[0] ?? ''),
      ]);
      // Cards: one per template whose front has content (cloze: one per cloze number).
      const ords = nt.kind === 1
        ? [...new Set([...values0.join(' ').matchAll(/\{\{c(\d+)::/g)].map((m) => Number(m[1]) - 1))].sort((a, b) => a - b)
        : nt.templates.filter((t) => templateNonEmpty(t.qfmt, flds)).map((t) => t.ord);
      for (const ord of ords.length ? ords : [0]) {
        lastId += 1;
        db.run('INSERT INTO cards VALUES (?,?,?,?,?,-1,0,0,?,0,0,0,0,0,0,0,0,\'\')', [lastId, id, did, ord, nowS, pos++]);
        cardCount++;
      }
    }
    const zip: Zippable = { 'collection.anki2': db.export() };
    const map: Record<string, string> = {};
    media.forEach((m, i) => { zip[String(i)] = [m.data, { level: 0 }]; map[String(i)] = m.name; });
    zip.media = strToU8(JSON.stringify(map));
    const bytes = zipSync(zip, { level: 6 });
    return { blob: new Blob([bytes], { type: 'application/apkg' }), notes: notes.length, cards: cardCount };
  } finally {
    db.close();
  }
}

