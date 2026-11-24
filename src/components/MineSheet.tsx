import { useEffect, useMemo, useState } from 'preact/hooks';
import type { TermResult } from '../lib/lookup';
import { extractSentence } from '../lib/lookup';
import { ankiMobileUrl, buildMarkerValues, fillTemplate, sendToAnkiConnect } from '../lib/anki';
import { saveNote, tagDescriptions, type MinedNote } from '../lib/db';
import type { ImageMode } from '../lib/settings';
import { scan, settings, showToast } from '../store';
import { cropImage } from '../scanActions';

export interface MineRequest {
  result: TermResult;
  index: number;
}

export function MineSheet({ req, onClose }: { req: MineRequest; onClose: () => void }) {
  const s = scan.value!;
  const st = settings.value;
  const initial = useMemo(() => extractSentence(s.text, req.index, st.display.hardLineBreaks), []);
  const [sentence, setSentence] = useState(initial.sentence);
  const [source, setSource] = useState(s.source);
  const [imageMode, setImageMode] = useState<ImageMode>(s.canvas ? st.anki.image : 'none');
  const [image, setImage] = useState<Blob | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tags, setTags] = useState<Record<string, string>>({});
  useEffect(() => { tagDescriptions().then(setTags); }, []);

  const lineIndex = s.lineOf[req.index] ?? -1;
  useEffect(() => {
    let url: string | null = null;
    if (!s.canvas || imageMode === 'none') { setImage(null); setImageUrl(null); return; }
    const line = imageMode === 'line' && lineIndex >= 0 ? s.lines[lineIndex] : null;
    cropImage(s.canvas, line).then((b) => {
      setImage(b);
      url = b ? URL.createObjectURL(b) : null;
      setImageUrl(url);
    });
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [imageMode]);

  // Offset of the scanned word inside the (possibly edited) sentence.
  const offset = useMemo(() => {
    const raw = s.text.slice(initial.start, initial.end).join('').replace(/\n/g, '');
    const lead = raw.length - raw.trimStart().length;
    const before = s.text.slice(initial.start, req.index).join('').replace(/\n/g, '').length - lead;
    return sentence === initial.sentence ? before : null;
  }, [sentence]);

  const values = buildMarkerValues(req.result, sentence, offset, source, tags);
  const r = req.result;

  const method = st.anki.method;
  const actionLabel = method === 'ankiconnect' ? 'Add to Anki' : method === 'ankimobile' ? 'Send to AnkiMobile' : 'Save card';

  const submit = async () => {
    setBusy(true);
    const note: MinedNote = { created: Date.now(), fields: values, image: image ?? undefined, status: 'pending' };
    try {
      note.id = await saveNote(note);
      if (method === 'ankiconnect') {
        try {
          note.ankiNoteId = await sendToAnkiConnect(st, note);
          note.status = 'added';
          showToast(`Added 「${r.expression}」 to ${st.anki.deck}`, 'ok');
        } catch (e) {
          note.status = 'error';
          note.error = String((e as Error).message ?? e);
          showToast(`Saved locally; Anki failed: ${note.error}`, 'error');
        }
        await saveNote(note);
      } else if (method === 'ankimobile') {
        note.status = 'added';
        await saveNote(note);
        location.href = ankiMobileUrl(st, values);
      } else {
        showToast(`Saved 「${r.expression}」 — export from the Mined tab`, 'ok');
      }
      onClose();
    } catch (e) {
      showToast(String((e as Error).message ?? e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const fieldPreview = method === 'ankiconnect' ? st.anki.fields : method === 'ankimobile' ? st.anki.mobile.fields : null;

  return (
    <div class="sheet-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="sheet" role="dialog" aria-label="Create card" data-testid="mine-sheet">
        <header class="sheet-head">
          <h2 lang="ja">
            {r.expression}
            {r.expression !== r.reading && <span class="muted"> 【{r.reading}】</span>}
          </h2>
          <button class="icon-button" onClick={onClose} aria-label="Close">✕</button>
        </header>
        <label class="field">
          <span>Sentence</span>
          <textarea lang="ja" rows={3} value={sentence} onInput={(e) => setSentence((e.target as HTMLTextAreaElement).value)} data-testid="sentence" />
        </label>
        <div class="sentence-preview" lang="ja" dangerouslySetInnerHTML={{ __html: values.sentence }} />
        <label class="field">
          <span>Source</span>
          <input value={source} placeholder="Book title, place…" onInput={(e) => setSource((e.target as HTMLInputElement).value)} />
        </label>
        {s.canvas && (
          <div class="field">
            <span>Image</span>
            <div class="segmented">
              {(['page', 'line', 'none'] as ImageMode[]).map((m) => (
                <button key={m} class={imageMode === m ? 'active' : ''} onClick={() => setImageMode(m)} disabled={m === 'line' && lineIndex < 0}>
                  {m === 'page' ? 'Page' : m === 'line' ? 'Line' : 'None'}
                </button>
              ))}
            </div>
            {imageUrl && <img class="mine-thumb" src={imageUrl} alt="Card image" />}
          </div>
        )}
        <details class="field">
          <summary>Definition</summary>
          <div class="glossary-preview" dangerouslySetInnerHTML={{ __html: values.glossary }} />
        </details>
        {fieldPreview && (
          <details class="field">
            <summary>Card fields</summary>
            <table class="fields-table">
              <tbody>
                {Object.entries(fieldPreview).map(([f, tpl]) => (
                  <tr key={f}>
                    <th>{f}</th>
                    <td dangerouslySetInnerHTML={{ __html: tpl.includes('{image}') ? '🖼 image' : tpl.includes('{audio}') ? '🔊 audio' : fillTemplate(tpl, values) }} />
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        )}
        {method === 'ankimobile' && image && <p class="muted small">AnkiMobile's add-note link can't carry images; the image is kept in the Mined tab.</p>}
        <div class="row sheet-actions">
          <button class="button primary grow" onClick={submit} disabled={busy || !sentence.trim()} data-testid="mine-submit">
            {busy ? 'Adding…' : actionLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
