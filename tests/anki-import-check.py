#!/usr/bin/env python3
"""Imports packages written by src/lib/apkg.ts with Anki's own importer (pip install anki).

    MM_APKG_OUT=/tmp/apkg npx vitest run tests/unit/apkg.test.ts
    python tests/anki-import-check.py /tmp/apkg
"""
import os, sys, tempfile
from anki.collection import Collection, ImportAnkiPackageRequest, ImportAnkiPackageOptions

out = sys.argv[1]
fixtures = os.path.join(os.path.dirname(__file__), 'fixtures')
failures = 0
def check(cond, msg):
    global failures
    print(('✔ ' if cond else '✘ ') + msg)
    failures += not cond

def imp(col, path):
    return col.import_anki_package(ImportAnkiPackageRequest(package_path=path, options=ImportAnkiPackageOptions(with_scheduling=False)))

with tempfile.TemporaryDirectory() as d:
    # A collection that already has the user's Lapis note type (as in their AnkiDroid)
    col = Collection(os.path.join(d, 'user.anki2'))
    imp(col, os.path.join(fixtures, 'anki-lapis-modern.apkg'))
    lapis_id = col.models.by_name('Lapis')['id']
    for round in (1, 2):
        imp(col, os.path.join(out, 'mm-lapis.apkg'))
        names = [m.name for m in col.models.all_names_and_ids()]
        check(names.count('Lapis') == 1 and not any(n.startswith('Lapis') and n != 'Lapis' for n in names), f'round {round}: cards use the existing Lapis note type ({names})')
        mined = [col.get_note(n) for n in col.find_notes('"deck:Mining::Phone"')]
        check(len(mined) == 2 and all(n.mid == lapis_id for n in mined), f'round {round}: 2 notes in Mining::Phone (no duplicates on re-import): {len(mined)}')
    n = next(n for n in mined if n['Expression'] == '読む')
    check(n['Sentence'] == '本を<b>読んだ</b>。' and n['ExpressionReading'] == 'よむ' and 'to read' in n['MainDefinition'], f'fields filled: {dict(n.items())}')
    check(n.tags == ['mobilemining', 'phone'], f'tags {n.tags}')
    pic = os.path.join(col.media.dir(), 'mobilemining_1764000000000.jpg')
    check(n['Picture'] == '<img src="mobilemining_1764000000000.jpg">' and os.path.exists(pic), 'image imported into the media folder')
    cards = col.find_cards('"deck:Mining::Phone"')
    check(len(cards) == 2 and all(col.get_card(c).type == 0 for c in cards), f'2 new cards: {len(cards)}')
    col.close()

    # No note type yet: the built-in MobileMining type is created once
    col = Collection(os.path.join(d, 'fresh.anki2'))
    for round in (1, 2):
        imp(col, os.path.join(out, 'mm-builtin.apkg'))
    names = [m.name for m in col.models.all_names_and_ids()]
    check(names.count('MobileMining') == 1 and len(col.find_notes('"note:MobileMining"')) == 1, f'built-in note type created once: {names}')
    col.close()

sys.exit(1 if failures else 0)
