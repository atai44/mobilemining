import { useState } from 'preact/hooks';
import { dicts, settings, showToast, updateSettings, refreshDicts, ocrState } from '../store';
import { AnkiConnect, guessMarker, MARKERS } from '../lib/anki';
import type { AnkiMethod, ImageMode } from '../lib/settings';
import { installDictionaries } from '../lib/db';

const BASE = new URL(import.meta.env.BASE_URL, location.href).href;

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
      </section>

      <DictionarySettings />

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

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label class="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange((e.target as HTMLInputElement).checked)} />
      <span>{label}</span>
    </label>
  );
}

function AnkiSettings() {
  const st = settings.value;
  const a = st.anki;
  const [decks, setDecks] = useState<string[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const client = () => new AnkiConnect(a.url, a.key);

  const connect = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const perm = await client().requestPermission().catch(() => null);
      if (perm && perm.permission === 'denied') throw new Error('AnkiConnect denied access for this site.');
      const v = await client().version();
      const [d, m] = await Promise.all([client().deckNames(), client().modelNames()]);
      setDecks(d);
      setModels(m);
      setStatus(`Connected (AnkiConnect v${v})`);
      if (a.model && !Object.keys(a.fields).length) await loadFields(a.model);
    } catch (e) {
      setStatus(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const loadFields = async (model: string) => {
    const names = await client().modelFieldNames(model);
    updateSettings((s) => {
      s.anki.model = model;
      const prev = s.anki.fields;
      s.anki.fields = Object.fromEntries(names.map((n) => [n, prev[n] ?? guessMarker(n)]));
    });
  };

  return (
    <section class="card">
      <h2>Anki</h2>
      <div class="field">
        <span>Send cards with</span>
        <div class="segmented">
          {([
            ['ankiconnect', 'AnkiConnect'],
            ['ankimobile', 'AnkiMobile (iOS)'],
            ['local', 'Save & export'],
          ] as [AnkiMethod, string][]).map(([m, label]) => (
            <button key={m} class={a.method === m ? 'active' : ''} onClick={() => updateSettings((s) => (s.anki.method = m))}>{label}</button>
          ))}
        </div>
      </div>

      {a.method === 'ankiconnect' && (
        <>
          <p class="muted small">
            Works with desktop Anki + the AnkiConnect add-on, or on Android with AnkiDroid + the “AnkiConnect Android” app. Add <code>{location.origin}</code> to
            AnkiConnect's <code>webCorsOriginList</code> (or approve the permission prompt).
          </p>
          <label class="field">
            <span>AnkiConnect URL</span>
            <input value={a.url} onInput={(e) => updateSettings((s) => (s.anki.url = (e.target as HTMLInputElement).value))} />
          </label>
          <label class="field">
            <span>API key (optional)</span>
            <input type="password" value={a.key} onInput={(e) => updateSettings((s) => (s.anki.key = (e.target as HTMLInputElement).value))} />
          </label>
          <button class="button" onClick={connect} disabled={busy} data-testid="anki-connect">{busy ? 'Connecting…' : 'Connect & load decks'}</button>
          {status && <p class="small">{status}</p>}
          <label class="field">
            <span>Deck</span>
            {decks.length ? (
              <select value={a.deck} onChange={(e) => updateSettings((s) => (s.anki.deck = (e.target as HTMLSelectElement).value))}>
                <option value="">— choose —</option>
                {decks.map((d) => <option key={d}>{d}</option>)}
              </select>
            ) : (
              <input value={a.deck} placeholder="Connect to list decks" onInput={(e) => updateSettings((s) => (s.anki.deck = (e.target as HTMLInputElement).value))} />
            )}
          </label>
          <label class="field">
            <span>Note type</span>
            {models.length ? (
              <select value={a.model} onChange={(e) => loadFields((e.target as HTMLSelectElement).value).catch((err) => showToast(String(err.message), 'error'))}>
                <option value="">— choose —</option>
                {models.map((m) => <option key={m}>{m}</option>)}
              </select>
            ) : (
              <input value={a.model} placeholder="Connect to list note types" onInput={(e) => updateSettings((s) => (s.anki.model = (e.target as HTMLInputElement).value))} />
            )}
          </label>
          <FieldMapping fields={a.fields} onChange={(f, v) => updateSettings((s) => (s.anki.fields[f] = v))} />
          <Toggle label="Add pronunciation audio to {audio} fields" checked={a.audio} onChange={(v) => updateSettings((s) => (s.anki.audio = v))} />
        </>
      )}

      {a.method === 'ankimobile' && (
        <>
          <p class="muted small">Opens AnkiMobile's “Add” screen with the card filled in. Field names must match your note type exactly. Images and audio aren't supported by AnkiMobile's link API.</p>
          <label class="field">
            <span>Profile</span>
            <input value={a.mobile.profile} onInput={(e) => updateSettings((s) => (s.anki.mobile.profile = (e.target as HTMLInputElement).value))} />
          </label>
          <label class="field">
            <span>Deck</span>
            <input value={a.mobile.deck} onInput={(e) => updateSettings((s) => (s.anki.mobile.deck = (e.target as HTMLInputElement).value))} />
          </label>
          <label class="field">
            <span>Note type</span>
            <input value={a.mobile.model} onInput={(e) => updateSettings((s) => (s.anki.mobile.model = (e.target as HTMLInputElement).value))} />
          </label>
          <FieldMapping
            fields={a.mobile.fields}
            editableNames
            onChange={(f, v) => updateSettings((s) => (s.anki.mobile.fields[f] = v))}
            onRename={(from, to) => updateSettings((s) => {
              s.anki.mobile.fields = Object.fromEntries(Object.entries(s.anki.mobile.fields).map(([k, v]) => [k === from ? to : k, v]).filter(([k]) => k));
            })}
            onAdd={() => updateSettings((s) => (s.anki.mobile.fields[`Field${Object.keys(s.anki.mobile.fields).length + 1}`] = ''))}
          />
        </>
      )}

      {a.method === 'local' && <p class="muted small">Cards are saved on this device. Export them as a TSV file from the Mined tab and import into Anki (File → Import).</p>}

      <label class="field">
        <span>Tags</span>
        <input value={a.tags} onInput={(e) => updateSettings((s) => (s.anki.tags = (e.target as HTMLInputElement).value))} />
      </label>
      <label class="field">
        <span>Default card image</span>
        <select value={a.image} onChange={(e) => updateSettings((s) => (s.anki.image = (e.target as HTMLSelectElement).value as ImageMode))}>
          <option value="page">Whole photo</option>
          <option value="line">Just the line</option>
          <option value="none">No image</option>
        </select>
      </label>
      <Toggle label="Allow duplicates" checked={a.allowDuplicates} onChange={(v) => updateSettings((s) => (s.anki.allowDuplicates = v))} />
    </section>
  );
}

function FieldMapping({ fields, onChange, editableNames, onRename, onAdd }: {
  fields: Record<string, string>;
  onChange: (field: string, value: string) => void;
  editableNames?: boolean;
  onRename?: (from: string, to: string) => void;
  onAdd?: () => void;
}) {
  const entries = Object.entries(fields);
  return (
    <div class="field">
      <span>Fields</span>
      {!entries.length && !editableNames && <p class="muted small">Choose a note type to map its fields.</p>}
      <datalist id="markers">
        {MARKERS.map((m) => <option key={m.name} value={`{${m.name}}`}>{m.description}</option>)}
      </datalist>
      {entries.map(([f, v]) => (
        <div class="field-map" key={f}>
          {editableNames ? (
            <input class="field-name" value={f} onChange={(e) => onRename?.(f, (e.target as HTMLInputElement).value)} />
          ) : (
            <span class="field-name">{f}</span>
          )}
          <input list="markers" value={v} placeholder="(empty)" onInput={(e) => onChange(f, (e.target as HTMLInputElement).value)} />
        </div>
      ))}
      {editableNames && <button class="button small" onClick={onAdd}>+ Field</button>}
      <details class="small">
        <summary>Available markers</summary>
        <ul class="marker-list">
          {MARKERS.map((m) => <li key={m.name}><code>{`{${m.name}}`}</code> — {m.description}</li>)}
        </ul>
      </details>
    </div>
  );
}

function DictionarySettings() {
  const d = dicts.value ?? {};
  const [progress, setProgress] = useState<string | null>(null);
  const reinstall = async () => {
    try {
      await installDictionaries(BASE, (stage, done, total) => setProgress(`${stage} ${total ? Math.round((done / total) * 100) + '%' : ''}`));
      await refreshDicts();
      showToast('Dictionary updated', 'ok');
    } catch (e) {
      showToast(String((e as Error).message ?? e), 'error');
    } finally {
      setProgress(null);
    }
  };
  return (
    <section class="card">
      <h2>Dictionaries</h2>
      <p class="small">
        JMdict: {d.jmdict ? `${d.jmdict.count.toLocaleString()} entries (${d.jmdict.version})` : 'not installed'}
        <br />
        KANJIDIC2: {d.kanjidic ? `${d.kanjidic.count.toLocaleString()} kanji` : 'not installed'}
      </p>
      <button class="button" onClick={reinstall} disabled={!!progress}>{progress ?? (d.jmdict ? 'Reinstall / update' : 'Install')}</button>
    </section>
  );
}
