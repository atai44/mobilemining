import { settings, updateSettings, ocrState } from '../store';
import type { FuriganaMode } from '../lib/settings';
import { Toggle } from './ui';
import { AnkiSettings } from './settings/AnkiSettings';
import { DictionarySettings } from './settings/DictionarySettings';
import { BackupSettings } from './settings/BackupSettings';

export function SettingsView() {
  const st = settings.value;
  return (
    <div class="page settings">
      <header class="page-header"><h1>Settings</h1></header>
      <AnkiSettings />

      <section class="card">
        <h2>OCR</h2>
        <label class="field">
          <span>Engine</span>
          <select value={st.ocr.engine} onChange={(e) => updateSettings((s) => (s.ocr.engine = (e.target as HTMLSelectElement).value as 'local' | 'cloud'))}>
            <option value="local">On-device (PP-OCRv6, offline)</option>
            <option value="cloud">Google Cloud Vision (online, widest kanji coverage)</option>
          </select>
        </label>
        {st.ocr.engine === 'cloud' && (
          <label class="field">
            <span>Cloud Vision API key</span>
            <input type="password" value={st.ocr.cloudApiKey} onInput={(e) => updateSettings((s) => (s.ocr.cloudApiKey = (e.target as HTMLInputElement).value))} />
            <small class="muted">Images are sent to Google for recognition. Use a key restricted to the Vision API and this site.</small>
          </label>
        )}
        <label class="field">
          <span>Default text direction</span>
          <select value={st.ocr.orientation} onChange={(e) => updateSettings((s) => (s.ocr.orientation = (e.target as HTMLSelectElement).value as never))}>
            <option value="auto">Auto-detect</option>
            <option value="horizontal">Horizontal (横書き)</option>
            <option value="vertical">Vertical (縦書き)</option>
          </select>
        </label>
        <Toggle label="Turn sideways / upside-down photos upright automatically" checked={st.ocr.autoRotate} onChange={(v) => updateSettings((s) => (s.ocr.autoRotate = v))} />
        <label class="field">
          <span>Detection resolution: {st.ocr.detMaxSide}px</span>
          <input type="range" min={960} max={2560} step={64} value={st.ocr.detMaxSide} onInput={(e) => updateSettings((s) => (s.ocr.detMaxSide = Number((e.target as HTMLInputElement).value)))} />
          <small class="muted">Higher finds smaller text but is slower. For small text, "Select area" works better.</small>
        </label>
        <p class="muted small">Engine status: {ocrState.value.state}{ocrState.value.message ? ` (${ocrState.value.message})` : ''}</p>
      </section>

      <section class="card">
        <h2>Reading</h2>
        <label class="field">
          <span>Text size: {st.display.fontSize}px</span>
          <input type="range" min={14} max={40} value={st.display.fontSize} onInput={(e) => updateSettings((s) => (s.display.fontSize = Number((e.target as HTMLInputElement).value)))} />
        </label>
        <Toggle label="Show text vertically (縦書き)" checked={st.display.vertical} onChange={(v) => updateSettings((s) => (s.display.vertical = v))} />
        <Toggle label="Underline low-confidence OCR characters" checked={st.display.highlightLowConfidence} onChange={(v) => updateSettings((s) => (s.display.highlightLowConfidence = v))} />
        <Toggle label="Line breaks end sentences (signs, menus)" checked={st.display.hardLineBreaks} onChange={(v) => updateSettings((s) => (s.display.hardLineBreaks = v))} />
        <label class="field">
          <span>Furigana in photos</span>
          <select value={st.display.furigana} onChange={(e) => updateSettings((s) => (s.display.furigana = (e.target as HTMLSelectElement).value as FuriganaMode))} data-testid="furigana-mode">
            <option value="ruby">Show as furigana over the kanji</option>
            <option value="remove">Remove</option>
            <option value="keep">Keep as separate lines (old behavior)</option>
          </select>
          <small class="muted">Applies to the next photo you read. Furigana is never mixed into sentences; with “Show” it is also available as {'{sentence-furigana}'} for Anki.</small>
        </label>
      </section>

      <DictionarySettings />

      <BackupSettings />

      <section class="card about">
        <h2>About</h2>
        <p class="small">
          Dictionary data: <a href="https://www.edrdg.org/wiki/index.php/JMdict-EDICT_Dictionary_Project" target="_blank" rel="noreferrer">JMdict</a> and{' '}
          <a href="https://www.edrdg.org/wiki/index.php/KANJIDIC_Project" target="_blank" rel="noreferrer">KANJIDIC2</a> © the Electronic Dictionary Research and
          Development Group, used under <a href="https://www.edrdg.org/edrdg/licence.html" target="_blank" rel="noreferrer">CC BY-SA 4.0</a>.
        </p>
        <p class="small">
          OCR: <a href="https://github.com/PaddlePaddle/PaddleOCR" target="_blank" rel="noreferrer">PaddleOCR PP-OCRv6</a> (Apache-2.0), run with ONNX Runtime Web.
          Audio: JapanesePod101.
        </p>
      </section>
    </div>
  );
}

