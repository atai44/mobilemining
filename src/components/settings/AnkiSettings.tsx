import { useEffect, useRef, useState } from 'preact/hooks';
import { settings, showToast, updateSettings } from '../../store';
import { client, createMobileMiningModel, dictSlug, guessMarker, MARKERS, MM_FIELDS, MM_MODEL } from '../../lib/anki';
import type { AnkiMethod, DuplicateBehavior, ImageMode, Settings } from '../../lib/settings';
import { applyYomitanProfile, parseYomitanSettings, type ImportSummary, type YomitanSettingsFile } from '../../lib/yomitan/settingsImport';
import { installedDictionaries, refreshDictionaries } from '../../dictionaries';
import { Toggle } from '../ui';

type Conn = { state: 'idle' | 'checking' | 'ok' | 'error'; message?: string };

export function AnkiSettings() {
  const st = settings.value;
  const a = st.anki;
  const [decks, setDecks] = useState<string[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [conn, setConn] = useState<Conn>({ state: 'idle' });
  const [busy, setBusy] = useState(false);

  const connect = async (interactive: boolean) => {
    setConn({ state: 'checking' });
    try {
      const c = client(settings.value);
      if (interactive) {
        const perm = await c.requestPermission().catch(() => null);
        if (perm?.permission === 'denied') throw new Error('AnkiConnect denied access for this site.');
      }
      const v = await c.version();
      const [d, m] = await Promise.all([c.deckNames(), c.modelNames()]);
      setDecks(d);
      setModels(m);
      setConn({ state: 'ok', message: `Connected · v${v}` });
      const cur = settings.value.anki;
      if (cur.model && m.includes(cur.model) && !Object.keys(cur.fields).length) await loadFields(cur.model);
    } catch (e) {
      setConn({ state: 'error', message: String((e as Error).message ?? e) });
    }
  };

  // Check the connection whenever AnkiConnect is selected (like Yomitan's status indicator).
  useEffect(() => { if (a.method === 'ankiconnect') connect(false); }, [a.method, a.url, a.key]);

  const loadFields = async (model: string, preset?: Record<string, string>) => {
    const names = await client(settings.value).modelFieldNames(model);
    updateSettings((s) => {
      const prev = s.anki.model === model ? s.anki.fields : {};
      s.anki.model = model;
      s.anki.fields = Object.fromEntries(names.map((n) => [n, preset?.[n] ?? prev[n] ?? guessMarker(n)]));
    });
  };

  const setupForMe = async () => {
    setBusy(true);
    try {
      const c = client(settings.value);
      const model = await createMobileMiningModel(settings.value);
      const deck = settings.value.anki.deck || 'Mining';
      if (!(await c.deckNames()).includes(deck)) await c.createDeck(deck);
      updateSettings((s) => (s.anki.deck = deck));
      await loadFields(model, MM_FIELDS);
      await connect(false);
      showToast(`Ready: deck “${deck}”, note type “${MM_MODEL}”`, 'ok');
    } catch (e) {
      showToast(String((e as Error).message ?? e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const newDeck = async () => {
    const name = prompt('New deck name', 'Mining')?.trim();
    if (!name) return;
    try {
      await client(settings.value).createDeck(name);
      updateSettings((s) => (s.anki.deck = name));
      await connect(false);
    } catch (e) {
      showToast(String((e as Error).message ?? e), 'error');
    }
  };

  const dynamicMarkers = installedDictionaries.value
    .filter((d) => d.kinds.includes('terms'))
    .map((d) => ({ name: `single-glossary-${dictSlug(d.title)}`, description: `Definitions from ${d.title} only` }));

  return (
    <section class="card" data-testid="anki-settings">
      <h2>Anki</h2>
      <YomitanImport />
      <div class="field">
        <span>Send via</span>
        <div class="segmented">
          {([
            ['ankiconnect', 'AnkiConnect'],
            ['ankimobile', 'AnkiMobile'],
            ['local', 'Export'],
          ] as [AnkiMethod, string][]).map(([m, label]) => (
            <button key={m} class={a.method === m ? 'active' : ''} onClick={() => updateSettings((s) => (s.anki.method = m))}>{label}</button>
          ))}
        </div>
      </div>

      {a.method === 'ankiconnect' && (
        <>
          <div class={`conn conn-${conn.state}`} data-testid="anki-status">
            <span class="dot" />
            <span>{conn.state === 'checking' ? 'Connecting…' : conn.state === 'idle' ? '—' : conn.message}</span>
            <button class="button small" onClick={() => connect(true)} disabled={conn.state === 'checking'} data-testid="anki-connect">
              {conn.state === 'ok' ? 'Refresh' : 'Connect'}
            </button>
          </div>
          {conn.state === 'error' && (
            <details class="small help" open>
              <summary>Help</summary>
              <ol>
                <li>Desktop: AnkiConnect add-on <code>2055492159</code>, Anki open. Android: AnkiConnect Android.</li>
                <li>Add <code>{location.origin}</code> to <code>webCorsOriginList</code>, or Connect and approve in Anki.</li>
                <li>Phone → desktop Anki is blocked by browsers.</li>
              </ol>
            </details>
          )}
          <details class="field">
            <summary>Connection</summary>
            <label class="field">
              <span>AnkiConnect URL</span>
              <input value={a.url} onChange={(e) => updateSettings((s) => (s.anki.url = (e.target as HTMLInputElement).value))} />
            </label>
            <label class="field">
              <span>API key (optional)</span>
              <input type="password" value={a.key} onChange={(e) => updateSettings((s) => (s.anki.key = (e.target as HTMLInputElement).value))} />
            </label>
          </details>

          {conn.state === 'ok' && (
            <div class="setup-box">
              <button class="button" onClick={setupForMe} disabled={busy} title="Sentence card: word, audio, pitch, meaning, photo" data-testid="anki-setup">{busy ? '…' : `Create “${MM_MODEL}” note type`}</button>
            </div>
          )}

          <label class="field">
            <span>Deck</span>
            <div class="row">
              {decks.length ? (
                <select class="grow" value={a.deck} onChange={(e) => updateSettings((s) => (s.anki.deck = (e.target as HTMLSelectElement).value))} data-testid="anki-deck">
                  <option value="">— choose —</option>
                  {[...new Set([a.deck, ...decks])].filter(Boolean).map((d) => <option key={d}>{d}</option>)}
                </select>
              ) : (
                <input class="grow" value={a.deck} placeholder="Deck" onChange={(e) => updateSettings((s) => (s.anki.deck = (e.target as HTMLInputElement).value))} />
              )}
              {conn.state === 'ok' && <button class="button small" onClick={newDeck}>New…</button>}
            </div>
          </label>
          <label class="field">
            <span>Note type</span>
            {models.length ? (
              <select value={a.model} onChange={(e) => loadFields((e.target as HTMLSelectElement).value).catch((err) => showToast(String(err.message), 'error'))} data-testid="anki-model">
                <option value="">— choose —</option>
                {[...new Set([a.model, ...models])].filter(Boolean).map((m) => <option key={m}>{m}</option>)}
              </select>
            ) : (
              <input value={a.model} placeholder="Note type" onChange={(e) => updateSettings((s) => (s.anki.model = (e.target as HTMLInputElement).value))} />
            )}
          </label>
          <FieldMapping fields={a.fields} extraMarkers={dynamicMarkers} onChange={(f, v) => updateSettings((s) => (s.anki.fields[f] = v))} />

          <div class="field">
            <span>Duplicates</span>
            <Toggle label="Check" checked={a.checkForDuplicates} onChange={(v) => updateSettings((s) => (s.anki.checkForDuplicates = v))} />
            {a.checkForDuplicates && (
              <div class="row wrap">
                <select value={a.duplicateBehavior} onChange={(e) => updateSettings((s) => (s.anki.duplicateBehavior = (e.target as HTMLSelectElement).value as DuplicateBehavior))} data-testid="dupe-behavior">
                  <option value="new">Add anyway</option>
                  <option value="prevent">Don't add</option>
                  <option value="overwrite">Overwrite</option>
                </select>
                <select value={a.duplicateScope} onChange={(e) => updateSettings((s) => (s.anki.duplicateScope = (e.target as HTMLSelectElement).value as typeof a.duplicateScope))}>
                  <option value="collection">Collection</option>
                  <option value="deck">Deck</option>
                  <option value="deck-root">Root deck</option>
                </select>
              </div>
            )}
          </div>
          <Toggle label="One-tap add" checked={a.quickAdd} onChange={(v) => updateSettings((s) => (s.anki.quickAdd = v))} />
          <label class="field">
            <span>View note in</span>
            <select value={a.noteGuiMode} onChange={(e) => updateSettings((s) => (s.anki.noteGuiMode = (e.target as HTMLSelectElement).value as 'browse' | 'edit'))}>
              <option value="browse">Browser</option>
              <option value="edit">Editor</option>
            </select>
          </label>
          <Toggle label="Audio" checked={a.audio} onChange={(v) => updateSettings((s) => (s.anki.audio = v))} />
        </>
      )}

      {a.method === 'ankimobile' && (
        <>
          <p class="muted small">No images or audio</p>
          <label class="field">
            <span>Profile</span>
            <input value={a.mobile.profile} onInput={(e) => updateSettings((s) => (s.anki.mobile.profile = (e.target as HTMLInputElement).value))} />
          </label>
          <NoteTypeEditor pick={(s) => s.anki.mobile} markers={dynamicMarkers} testid="mobile" />
        </>
      )}

      {a.method === 'local' && (
        <>
          <p class="muted small">Mined → TSV ↓ → Anki: File → Import (AnkiDroid: Import). No images or audio.</p>
          <NoteTypeEditor pick={(s) => s.anki.export} markers={dynamicMarkers} testid="export" optional />
        </>
      )}

      <label class="field">
        <span>Tags</span>
        <input value={a.tags} onInput={(e) => updateSettings((s) => (s.anki.tags = (e.target as HTMLInputElement).value))} />
      </label>
      <label class="field">
        <span>Image</span>
        <select value={a.image} onChange={(e) => updateSettings((s) => (s.anki.image = (e.target as HTMLSelectElement).value as ImageMode))}>
          <option value="page">Page</option>
          <option value="line">Line</option>
          <option value="none">None</option>
        </select>
      </label>
    </section>
  );
}

type ManualNoteType = { deck: string; model: string; fields: Record<string, string> };

/** Deck, note type and field markers typed by hand (AnkiMobile and the TSV export can't list them). */
function NoteTypeEditor({ pick, markers, testid, optional }: {
  pick: (s: Settings) => ManualNoteType;
  markers: { name: string; description: string }[];
  testid: string;
  /** Empty fields are allowed (the export then uses a fixed set of columns). */
  optional?: boolean;
}) {
  const v = pick(settings.value);
  const set = (fn: (t: ManualNoteType) => void) => updateSettings((s) => fn(pick(s)));
  return (
    <div data-testid={`${testid}-note-type`}>
      <label class="field">
        <span>Deck</span>
        <input value={v.deck} placeholder={optional ? '—' : undefined} onInput={(e) => set((t) => (t.deck = (e.target as HTMLInputElement).value))} data-testid={`${testid}-deck`} />
      </label>
      <label class="field">
        <span>Note type</span>
        <input value={v.model} placeholder={optional ? '—' : undefined} onInput={(e) => set((t) => (t.model = (e.target as HTMLInputElement).value))} data-testid={`${testid}-model`} />
      </label>
      <FieldMapping
        fields={v.fields}
        editableNames
        extraMarkers={markers}
        onChange={(f, val) => set((t) => (t.fields[f] = val))}
        onRename={(from, to) => set((t) => {
          t.fields = Object.fromEntries(Object.entries(t.fields).map(([k, x]) => [k === from ? to : k, x]).filter(([k]) => k));
        })}
        onAdd={() => set((t) => (t.fields[`Field${Object.keys(t.fields).length + 1}`] = ''))}
      />
    </div>
  );
}

function YomitanImport() {
  const ref = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<YomitanSettingsFile | null>(null);
  const [profile, setProfile] = useState(0);
  const [summary, setSummary] = useState<ImportSummary | null>(null);

  const onFile = async (f: File) => {
    setSummary(null);
    try {
      const parsed = parseYomitanSettings(JSON.parse(await f.text()));
      setFile(parsed);
      setProfile(parsed.profileCurrent);
      if (parsed.profiles.length === 1) apply(parsed, parsed.profileCurrent);
    } catch (e) {
      showToast(`Couldn't read Yomitan settings: ${(e as Error).message}`, 'error');
    }
  };

  const apply = async (f: YomitanSettingsFile, idx: number) => {
    await refreshDictionaries();
    let result: ImportSummary = { notes: [], warnings: [] };
    updateSettings((s) => { result = applyYomitanProfile(s, f.profiles[idx], installedDictionaries.value.map((d) => d.title)); });
    setSummary(result);
    setFile(null);
    showToast('Imported Yomitan settings', 'ok');
  };

  return (
    <div class="yomitan-import">
      <button class="button small" onClick={() => ref.current?.click()} title="Yomitan → Settings → Backup → Export Settings" data-testid="import-yomitan">Import Yomitan settings…</button>
      <input ref={ref} type="file" accept=".json,application/json" hidden data-testid="yomitan-file" onChange={(e) => {
        const input = e.currentTarget as HTMLInputElement;
        const f = input.files?.[0];
        input.value = '';
        if (f) onFile(f);
      }} />
      {file && file.profiles.length > 1 && (
        <div class="row wrap">
          <select value={profile} onChange={(e) => setProfile(Number((e.target as HTMLSelectElement).value))}>
            {file.profiles.map((p, i) => <option key={i} value={i}>{p.name ?? `Profile ${i + 1}`}</option>)}
          </select>
          <button class="button small primary" onClick={() => apply(file, profile)}>Import</button>
        </div>
      )}
      {summary && (
        <div class="import-summary small" data-testid="yomitan-summary">
          {summary.notes.map((n) => <div key={n}>✓ {n}</div>)}
          {summary.warnings.map((w) => <div key={w} class="warn">⚠ {w}</div>)}
        </div>
      )}
    </div>
  );
}

function FieldMapping({ fields, onChange, editableNames, onRename, onAdd, extraMarkers = [] }: {
  fields: Record<string, string>;
  onChange: (field: string, value: string) => void;
  editableNames?: boolean;
  onRename?: (from: string, to: string) => void;
  onAdd?: () => void;
  extraMarkers?: { name: string; description: string }[];
}) {
  const entries = Object.entries(fields);
  const all = [...MARKERS, ...extraMarkers];
  return (
    <div class="field">
      <span>Fields</span>
      <datalist id="markers">
        {all.map((m) => <option key={m.name} value={`{${m.name}}`}>{m.description}</option>)}
        <option value="{cloze-prefix}<b>{cloze-body}</b>{cloze-suffix}">Sentence with the word in bold</option>
      </datalist>
      {entries.map(([f, v]) => (
        <div class="field-map" key={f}>
          {editableNames ? (
            <input class="field-name" value={f} onChange={(e) => onRename?.(f, (e.target as HTMLInputElement).value)} />
          ) : (
            <span class="field-name">{f}</span>
          )}
          <input list="markers" value={v} placeholder="(empty)" onInput={(e) => onChange(f, (e.target as HTMLInputElement).value)} data-field={f} />
        </div>
      ))}
      {editableNames && <button class="button small" onClick={onAdd}>+ Field</button>}
      <details class="small">
        <summary>Markers</summary>
        <ul class="marker-list">
          {all.map((m) => <li key={m.name}><code>{`{${m.name}}`}</code> — {m.description}</li>)}
        </ul>
      </details>
    </div>
  );
}
