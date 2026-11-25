# MobileMining

Sentence mining from **physical Japanese text**: books, signs, menus, manga. Take a photo, tap any word for a
Yomitan-style pop-up dictionary, and send the word plus its sentence (and a photo of the page) to Anki.

It's an installable web app (PWA). OCR, dictionary lookups and card creation all run **on the phone**: nothing is
uploaded unless you turn on the optional cloud OCR engine. After the first load it works offline.

## Features

- **On-device OCR** for horizontal (横書き) and vertical (縦書き) text, using PaddleOCR **PP-OCRv6** run with ONNX Runtime Web.
  - The recognizer knows 18,708 symbols, including **15,908 kanji**. That covers all jōyō and jinmeiyō kanji and many rare
    ones, including CJK Extension B characters such as 𠮷.
  - Text direction is auto-detected per line. Tilted photos are straightened per line.
  - Vertical-text quirks are handled: 。、 and small kana in the top-right of their cell, vertical ー, and 「」.
  - Every character keeps the model's runner-up guesses. Tap a misread character and pick the right one, or edit the text directly.
  - Drag a box to OCR a specific area (best for small text). Rotate, zoom, and force horizontal or vertical.
  - Optional **Google Cloud Vision** engine (your own API key) for even wider character coverage.
- **Read on the photo itself**: scroll and pinch-zoom the photo (Ctrl/trackpad pinch on desktop) and tap any word
  where it's printed. The word is highlighted in place. A text view (Aa) is still there for copying and editing.
- **Mixed text directions** on one page work: a vertical body with a horizontal heading or captions, speech bubbles,
  signs. Lines are grouped into blocks, each read in its own direction, and blocks are put in reading order. Sentences
  never run across blocks, but words split across lines or columns within a block are still found.
- **Furigana in photos** is recognized as furigana. It never gets spliced between lines of text. You can show it as ruby
  over the right kanji, remove it, or keep it. It's also available on cards as `{sentence-furigana}`.
- **Pop-up dictionary** like Yomitan:
  - Longest-match scanning from the tapped character.
  - A deinflector for verbs and adjectives (食べさせられなかった → 食べる, with the chain shown).
  - Built-in JMdict (~220k entries) and KANJIDIC2 (~13k kanji) kanji cards, plus audio.
  - **Import your own Yomitan dictionaries** (`.zip`): term dictionaries such as Jitendex, frequency lists (JPDB, …),
    pitch-accent and kanji dictionaries.
    - Structured content, images and `styles.css` render as they do in Yomitan, and dictionary links open nested lookups.
    - Results from all enabled dictionaries are merged per word in your priority order, and sorted by frequency.
- **Anki**, modelled on Yomitan + AnkiConnect:
  - **AnkiConnect**: desktop Anki, or AnkiDroid with the *AnkiConnect Android* app.
    - Connects automatically and shows its status.
    - One tap on ＋ adds the card; ✎ opens an editor first; 📖 opens the note in Anki.
    - Duplicate check with Yomitan's *prevent / add new / overwrite* behaviors and scopes.
    - **Same field markers as Yomitan**, including `{single-glossary-<dict>}`. Typical Lapis, Kiku and JPMN fields are
      mapped automatically.
    - "Set up note type & deck for me" creates a ready-made `MobileMining` note type.
  - **Import from Yomitan**: load a Yomitan settings backup (*Settings → Backup → Export Settings*) to bring over your
    AnkiConnect server and key, deck, note type, field markers, tags, duplicate options, and dictionary order. Custom
    Handlebars templates are not supported; standard markers are.
  - **AnkiMobile (iOS)**: fills AnkiMobile's Add screen through its `anki://x-callback-url/addnote` link.
  - **Save & export**: every mined card is kept on the device and can be exported as TSV (Anki: File → Import).

## Running it

```bash
npm install
npm run setup        # downloads OCR models (Hugging Face) and builds the dictionaries (EDRDG) into public/
npm run dev          # http://localhost:5173
npm run build        # static site in dist/
```

The camera and service worker need HTTPS (or localhost). To try it on a phone, deploy to GitHub Pages. The included
workflow `.github/workflows/deploy.yml` builds everything on each push to `main`. Enable it under
*Settings → Pages → Source: GitHub Actions*. Then open the site on your phone and use *Add to Home Screen*.

First launch: tap **Install dictionary** (about a 10 MB download, imported into IndexedDB in roughly 15 s). The OCR
models (31 MB) download on first scan, or tap *Download* on the Capture screen. Both are cached for offline use.

### AnkiConnect setup

1. Install AnkiConnect: the desktop add-on `2055492159`, or the *AnkiConnect Android* app with AnkiDroid.
2. Add the site's origin (e.g. `https://<you>.github.io`) to `webCorsOriginList` in AnkiConnect's config, or approve
   the permission prompt when you press *Connect* in Settings.
3. In MobileMining → Settings → Anki choose *AnkiConnect*, press *Connect & load decks*, then pick a deck and note type.

Browsers block requests from an HTTPS page to plain-HTTP addresses on other machines. So a phone can't talk directly
to AnkiConnect on your PC over the LAN. Use AnkiConnect Android on the phone, AnkiMobile on iOS, or save cards and
send or export them later.

## Tests

```bash
npm test                       # unit tests: deinflection, furigana, lookup ranking, sentence extraction
npm run build && npm run e2e   # headless Chromium: dictionary install, OCR of horizontal/vertical/rotated pages and
                               # pages with furigana, Yomitan dictionary + settings import, lookup, and mining
                               # against a mocked AnkiConnect
```

## Project layout

| Path | What |
| --- | --- |
| `src/lib/ocr/pipeline.ts` | PP-OCR detection post-processing, line rectification, CTC decoding, vertical-text fixes |
| `src/lib/ocr/worker.ts` | Web Worker running the ONNX models |
| `src/lib/deinflect.ts` | Japanese deinflection rules |
| `src/lib/lookup.ts` | Yomitan-style scanning and ranking; sentence extraction |
| `src/lib/db.ts` | IndexedDB: dictionary install, lookups, mined cards |
| `src/lib/anki.ts` | AnkiConnect / AnkiMobile / TSV, Yomitan-compatible field markers, duplicates |
| `src/lib/yomitan/` | Yomitan dictionary import, structured-content rendering, settings import |
| `src/lib/ocr/ruby.ts` | Furigana detection and attachment (works in each line's rotated frame, so tilted photos are fine) |
| `src/lib/ocr/layout.ts` | Blocks and reading order for pages that mix horizontal and vertical text |
| `scripts/` | Model download and dictionary build |

## Licenses and data

- JMdict and KANJIDIC2 © the Electronic Dictionary Research and Development Group, [CC BY-SA 4.0](https://www.edrdg.org/edrdg/licence.html).
- PaddleOCR PP-OCRv6 models: Apache-2.0.
- Pronunciation audio is streamed from JapanesePod101.
