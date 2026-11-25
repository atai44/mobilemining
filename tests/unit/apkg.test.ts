import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import initSqlJs from 'sql.js';
import { unzipSync, strFromU8 } from 'fflate';
import type { MinedNote } from '../../src/lib/db';
import { buildApkg, builtinNotetype, readNotetypes, setSqlJs, templateNonEmpty } from '../../src/lib/apkg';

setSqlJs(initSqlJs());
const fx = (f: string) => readFileSync(new URL(`../fixtures/${f}`, import.meta.url)).buffer as ArrayBuffer;
// Packages written here can be checked against Anki's own importer: tests/anki-import-check.py
const OUT: string | undefined = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.MM_APKG_OUT;
if (OUT) mkdirSync(OUT, { recursive: true });

describe('Anki packages', () => {
  for (const kind of ['modern', 'legacy']) {
    it(`reads note types from a ${kind} package`, async () => {
      const nts = await readNotetypes(fx(`anki-lapis-${kind}.apkg`));
      const lapis = nts.find((n) => n.notetype.name === 'Lapis')!;
      expect(lapis.notes).toBe(1);
      expect(lapis.notetype.id).toBe('1795597140674');
      expect(lapis.notetype.fields.map((f) => f.name)).toEqual(['Expression', 'ExpressionFurigana', 'ExpressionReading', 'MainDefinition', 'Sentence', 'Picture', 'SentenceAudio']);
      expect(lapis.notetype.fields[0].id).toMatch(/^-?\d{15,}$/);
      expect(lapis.notetype.templates[0]).toMatchObject({ name: 'Mining Card', qfmt: '<div class="expr">{{Expression}}</div>' });
      expect(lapis.notetype.css).toContain('.expr { font-size: 40px; }');
      expect(nts[0].notetype.name).toBe('Lapis'); // most used first
    });
  }

  it('decides which cards a note gets like Anki', () => {
    expect(templateNonEmpty('{{Front}}', { Front: 'x' })).toBe(true);
    expect(templateNonEmpty('{{Front}}', { Front: '' })).toBe(false);
    expect(templateNonEmpty('{{#IsWord}}{{Word}}{{/IsWord}}', { IsWord: '', Word: 'w' })).toBe(false);
    expect(templateNonEmpty('{{#IsWord}}{{Word}}{{/IsWord}}', { IsWord: 'y', Word: 'w' })).toBe(true);
    expect(templateNonEmpty('{{^IsWord}}{{furigana:Sentence}}{{/IsWord}}', { IsWord: '', Sentence: 's' })).toBe(true);
    expect(templateNonEmpty('<div>static</div>{{FrontSide}}', {})).toBe(false);
  });

  it('writes a package with the user\'s note type, media and stable note ids', async () => {
    const { notetype } = (await readNotetypes(fx('anki-lapis-modern.apkg')))[0];
    const jpg = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' });
    const notes: MinedNote[] = [
      { created: 1764000000000, status: 'pending', image: jpg, fields: { expression: '読む', reading: 'よむ', glossary: '<ul><li>to read</li></ul>', 'cloze-prefix': '本を', 'cloze-body': '読んだ', 'cloze-suffix': '。' } },
      { created: 1764000000500, status: 'pending', fields: { expression: '猫', reading: 'ねこ', glossary: 'cat' } },
    ];
    const fields = { Expression: '{expression}', ExpressionReading: '{reading}', MainDefinition: '{glossary}', Sentence: '{cloze-prefix}<b>{cloze-body}</b>{cloze-suffix}', Picture: '{image}', SentenceAudio: '{audio}' };
    const res = await buildApkg(notes, { notetype, fields, deck: 'Mining::Phone', tags: 'mobilemining phone' });
    expect(res).toMatchObject({ notes: 2, cards: 2 });
    const bytes = new Uint8Array(await res.blob.arrayBuffer());
    const zip = unzipSync(bytes);
    expect(JSON.parse(strFromU8(zip.media))).toEqual({ 0: 'mobilemining_1764000000000.jpg' });
    expect([...zip['0']]).toEqual([0xff, 0xd8, 0xff, 0xd9]);
    const SQL = await initSqlJs();
    const db = new SQL.Database(zip['collection.anki2']);
    const models = db.exec('SELECT models FROM col')[0].values[0][0] as string;
    expect(models).toContain(`"id":1795597140674`); // exact, unquoted
    expect(models).toContain(`"id":${notetype.fields[0].id}`);
    const rows = db.exec('SELECT guid, CAST(mid AS TEXT), flds, sfld, tags FROM notes ORDER BY id')[0].values;
    expect(rows[0]).toEqual([`mm${(1764000000000).toString(36)}`, '1795597140674', ['読む', '', 'よむ', '<ul><li>to read</li></ul>', '本を<b>読んだ</b>。', '<img src="mobilemining_1764000000000.jpg">', ''].join('\x1f'), '読む', ' mobilemining phone ']);
    expect(db.exec('SELECT COUNT(*) FROM cards')[0].values[0][0]).toBe(2);
    db.close();
    if (OUT) writeFileSync(`${OUT}/mm-lapis.apkg`, bytes);
  });

  it('writes the built-in note type', async () => {
    const res = await buildApkg([{ created: 1764000001000, status: 'pending', fields: { expression: '本', reading: 'ほん', 'cloze-body': '本' } }], { notetype: builtinNotetype(), fields: { Word: '{expression}', Sentence: '{cloze-prefix}<b>{cloze-body}</b>{cloze-suffix}' }, deck: '', tags: '' });
    expect(res.cards).toBe(1);
    if (OUT) writeFileSync(`${OUT}/mm-builtin.apkg`, new Uint8Array(await res.blob.arrayBuffer()));
  });
});
