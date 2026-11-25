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
            <option value="local">On-device</option>
            <option value="cloud">Google Cloud Vision</option>
          </select>
        </label>
        {st.ocr.engine === 'cloud' && (
          <label class="field">
            <span>API key</span>
            <input type="password" value={st.ocr.cloudApiKey} onInput={(e) => updateSettings((s) => (s.ocr.cloudApiKey = (e.target as HTMLInputElement).value))} />
            <small class="muted">Images are sent to Google</small>
          </label>
        )}
        <label class="field">
          <span>Direction</span>
          <select value={st.ocr.orientation} onChange={(e) => updateSettings((s) => (s.ocr.orientation = (e.target as HTMLSelectElement).value as never))}>
            <option value="auto">Auto</option>
            <option value="horizontal">横書き</option>
            <option value="vertical">縦書き</option>
          </select>
        </label>
        <Toggle label="Auto-rotate" checked={st.ocr.autoRotate} onChange={(v) => updateSettings((s) => (s.ocr.autoRotate = v))} />
        <label class="field">
          <span>Resolution: {st.ocr.detMaxSide}px</span>
          <input type="range" min={960} max={2560} step={64} value={st.ocr.detMaxSide} onInput={(e) => updateSettings((s) => (s.ocr.detMaxSide = Number((e.target as HTMLInputElement).value)))} />
        </label>
        {ocrState.value.message && <p class="error small">{ocrState.value.message}</p>}
      </section>

      <section class="card">
        <h2>Reading</h2>
        <label class="field">
          <span>Text size: {st.display.fontSize}px</span>
          <input type="range" min={14} max={40} value={st.display.fontSize} onInput={(e) => updateSettings((s) => (s.display.fontSize = Number((e.target as HTMLInputElement).value)))} />
        </label>
        <Toggle label="縦書き text" checked={st.display.vertical} onChange={(v) => updateSettings((s) => (s.display.vertical = v))} />
        <Toggle label="Underline unsure characters" checked={st.display.highlightLowConfidence} onChange={(v) => updateSettings((s) => (s.display.highlightLowConfidence = v))} />
        <Toggle label="Line break ends sentence" checked={st.display.hardLineBreaks} onChange={(v) => updateSettings((s) => (s.display.hardLineBreaks = v))} />
        <label class="field">
          <span>Furigana</span>
          <select value={st.display.furigana} onChange={(e) => updateSettings((s) => (s.display.furigana = (e.target as HTMLSelectElement).value as FuriganaMode))} data-testid="furigana-mode">
            <option value="ruby">Ruby</option>
            <option value="remove">Remove</option>
            <option value="keep">Separate lines</option>
          </select>
        </label>
      </section>

      <DictionarySettings />

      <BackupSettings />

      <section class="card about">
        <p class="small muted">
          <a href="https://www.edrdg.org/wiki/index.php/JMdict-EDICT_Dictionary_Project" target="_blank" rel="noreferrer">JMdict</a>,{' '}
          <a href="https://www.edrdg.org/wiki/index.php/KANJIDIC_Project" target="_blank" rel="noreferrer">KANJIDIC2</a> © EDRDG,{' '}
          <a href="https://www.edrdg.org/edrdg/licence.html" target="_blank" rel="noreferrer">CC BY-SA 4.0</a> ·{' '}
          <a href="https://github.com/PaddlePaddle/PaddleOCR" target="_blank" rel="noreferrer">PaddleOCR</a> (Apache-2.0) · Audio: JapanesePod101
        </p>
      </section>
    </div>
  );
}

