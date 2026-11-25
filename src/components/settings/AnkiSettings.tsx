import { useEffect, useRef, useState } from 'preact/hooks';
import { settings, showToast, updateSettings } from '../../store';
import { client, createMobileMiningModel, dictSlug, guessMarker, MARKERS, MM_FIELDS, MM_MODEL } from '../../lib/anki';
import type { AnkiMethod, DuplicateBehavior, ImageMode } from '../../lib/settings';
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
      setConn({ state: 'ok', message: `Connected to Anki (AnkiConnect v${v})` });
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
          <div class={`conn conn-${conn.state}`} data-testid="anki-status">
            <span class="dot" />
            <span>{conn.state === 'checking' ? 'Connecting…' : conn.state === 'idle' ? 'Not checked' : conn.message}</span>
            <button class="button small" onClick={() => connect(true)} disabled={conn.state === 'checking'} data-testid="anki-connect">
              {conn.state === 'ok' ? 'Refresh' : 'Connect'}
            </button>
          </div>
          {conn.state === 'error' && (
            <details class="small help" open>
              <summary>How to connect</summary>
              <ol>
                <li>Desktop: install the AnkiConnect add-on (code <code>2055492159</code>) and keep Anki open. Android: install AnkiDroid and the “AnkiConnect Android” app.</li>
                <li>In AnkiConnect's config, add <code>{location.origin}</code> to <code>webCorsOriginList</code>, or press Connect and approve the prompt in Anki.</li>
                <li>A phone can't reach desktop Anki over Wi-Fi from this site (browsers block it); use AnkiConnect Android, AnkiMobile, or save &amp; export.</li>
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
              <p class="small">New to mining? Create a ready-made <b>{MM_MODEL}</b> note type (sentence on front; word, audio, pitch, meaning and photo on back) and a deck in one step.</p>
              <button class="button" onClick={setupForMe} disabled={busy} data-testid="anki-setup">{busy ? 'Setting up…' : 'Set up note type & deck for me'}</button>
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
                <input class="grow" value={a.deck} placeholder="Connect to list decks" onChange={(e) => updateSettings((s) => (s.anki.deck = (e.target as HTMLInputElement).value))} />
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
              <input value={a.model} placeholder="Connect to list note types" onChange={(e) => updateSettings((s) => (s.anki.model = (e.target as HTMLInputElement).value))} />
            )}
          </label>
          <FieldMapping fields={a.fields} extraMarkers={dynamicMarkers} onChange={(f, v) => updateSettings((s) => (s.anki.fields[f] = v))} />

          <div class="field">
            <span>Duplicates</span>
            <Toggle label="Check for duplicates (first field)" checked={a.checkForDuplicates} onChange={(v) => updateSettings((s) => (s.anki.checkForDuplicates = v))} />
            {a.checkForDuplicates && (
              <div class="row wrap">
                <select value={a.duplicateBehavior} onChange={(e) => updateSettings((s) => (s.anki.duplicateBehavior = (e.target as HTMLSelectElement).value as DuplicateBehavior))} data-testid="dupe-behavior">
                  <option value="new">Add a new note anyway</option>
                  <option value="prevent">Don't add</option>
                  <option value="overwrite">Overwrite the existing note</option>
                </select>
                <select value={a.duplicateScope} onChange={(e) => updateSettings((s) => (s.anki.duplicateScope = (e.target as HTMLSelectElement).value as typeof a.duplicateScope))}>
                  <option value="collection">in whole collection</option>
                  <option value="deck">in this deck</option>
                  <option value="deck-root">in this deck's root deck</option>
                </select>
              </div>
            )}
          </div>
          <Toggle label="One-tap add from the popup (✎ edits first)" checked={a.quickAdd} onChange={(v) => updateSettings((s) => (s.anki.quickAdd = v))} />
          <label class="field">
            <span>“View note” opens</span>
            <select value={a.noteGuiMode} onChange={(e) => updateSettings((s) => (s.anki.noteGuiMode = (e.target as HTMLSelectElement).value as 'browse' | 'edit'))}>
              <option value="browse">Card browser</option>
              <option value="edit">Note editor</option>
            </select>
          </label>
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
            extraMarkers={dynamicMarkers}
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
    </section>
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
      <button class="button small" onClick={() => ref.current?.click()} data-testid="import-yomitan">Import from Yomitan…</button>
      <span class="muted small"> Yomitan → Settings → Backup → Export Settings</span>
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
          <button class="button small primary" onClick={() => apply(file, profile)}>Import profile</button>
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
      {!entries.length && !editableNames && <p class="muted small">Choose a note type to map its fields.</p>}
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
        <summary>Available markers (same names as Yomitan)</summary>
        <ul class="marker-list">
          {all.map((m) => <li key={m.name}><code>{`{${m.name}}`}</code> — {m.description}</li>)}
        </ul>
      </details>
    </div>
  );
}
