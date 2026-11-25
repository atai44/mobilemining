import { useEffect, useMemo, useState } from 'preact/hooks';
import type { TermResult } from '../lib/lookup';
import { fillTemplate, findDuplicates, usesApi, viewNote } from '../lib/anki';
import type { ImageMode } from '../lib/settings';
import { scan, settings, showToast } from '../store';
import { defaultImage, markerValues, mineTerm, miningContext } from '../mining';

export interface MineRequest {
  result: TermResult;
  index: number;
}

export function MineSheet({ req, onClose }: { req: MineRequest; onClose: () => void }) {
  const s = scan.value!;
  const st = settings.value;
  const initial = useMemo(() => miningContext(s, req.index, st.display.hardLineBreaks), []);
  const [sentence, setSentence] = useState(initial.sentence);
  const [source, setSource] = useState(s.source);
  const [imageMode, setImageMode] = useState<ImageMode>(s.canvas ? st.anki.image : 'none');
  const [image, setImage] = useState<Blob | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [values, setValues] = useState<Record<string, string> | null>(null);
  const [dupes, setDupes] = useState<number[]>([]);

  const lineIndex = s.lineOf[req.index] ?? -1;
  useEffect(() => {
    let url: string | null = null;
    defaultImage(s, req.index, imageMode).then((b) => {
      setImage(b);
      url = b ? URL.createObjectURL(b) : null;
      setImageUrl(url);
    });
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [imageMode]);

  // Edited sentences lose the exact word position and photo furigana.
  const unchanged = sentence === initial.sentence;
  useEffect(() => {
    markerValues(req.result, { sentence, offset: unchanged ? initial.offset : null, ruby: unchanged ? initial.ruby : [], source }).then(setValues);
  }, [sentence, source]);

  useEffect(() => {
    if (!values || !usesApi(st)) return;
    findDuplicates(st, values).then(setDupes).catch(() => setDupes([]));
  }, [values?.expression]);

  const r = req.result;
  const method = st.anki.method;
  const api = usesApi(st);
  const actionLabel = api ? 'Add' : method === 'ankimobile' ? 'AnkiMobile' : method === 'ankidroid' ? 'AnkiDroid' : 'Save';

  const submit = async (force?: 'new' | 'overwrite') => {
    if (!values) return;
    setBusy(true);
    try {
      const out = await mineTerm(r, values, image, force);
      if (out.error) showToast(`Anki: ${out.error}`, 'error');
      else if (out.sent) showToast(`${out.sent.action === 'updated' ? 'Updated' : 'Added'} 「${r.expression}」${out.sent.warning ? ` · ${out.sent.warning}` : ''}`, out.sent.warning ? 'info' : 'ok');
      else if (method === 'local') showToast(`Saved 「${r.expression}」`, 'ok');
      onClose();
    } catch (e) {
      showToast(String((e as Error).message ?? e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const fieldPreview = api ? st.anki.fields : method === 'ankimobile' ? st.anki.mobile.fields : method === 'ankidroid' ? st.anki.droid.fields : null;
  const preview = (tpl: string) => {
    if (/\{(image|screenshot|clipboard-image)\}/.test(tpl)) return '🖼 image';
    if (tpl.includes('{audio}')) return '🔊 audio';
    return fillTemplate(tpl, values ?? {});
  };

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
        {values && (
          <div class="sentence-preview" lang="ja" dangerouslySetInnerHTML={{ __html: unchanged && initial.ruby.length ? boldWithRuby(values) : values['sentence-bold'] }} />
        )}
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
          <div class="glossary-preview" dangerouslySetInnerHTML={{ __html: values?.glossary ?? '' }} />
        </details>
        {fieldPreview && (
          <details class="field">
            <summary>Card fields</summary>
            <table class="fields-table">
              <tbody>
                {Object.entries(fieldPreview).map(([f, tpl]) => (
                  <tr key={f}>
                    <th>{f}</th>
                    <td dangerouslySetInnerHTML={{ __html: preview(tpl) }} />
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        )}
        {(method === 'ankimobile' || method === 'ankidroid') && !api && image && <p class="muted small">Image kept in Mined only</p>}
        {dupes.length > 0 && (
          <p class="small dupe-note">
            Already in Anki.{' '}
            <button class="button link small" onClick={() => viewNote(st, dupes[0])}>View note</button>
          </p>
        )}
        <div class="row sheet-actions">
          {dupes.length > 0 && api ? (
            <>
              <button class="button grow" onClick={() => submit('overwrite')} disabled={busy || !values} data-testid="mine-overwrite">Overwrite</button>
              <button class="button primary grow" onClick={() => submit('new')} disabled={busy || !values} data-testid="mine-submit">Add new</button>
            </>
          ) : (
            <button class="button primary grow" onClick={() => submit()} disabled={busy || !sentence.trim() || !values} data-testid="mine-submit">
              {busy ? 'Adding…' : actionLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Sentence preview showing both the photo's furigana and the mined word in bold. */
function boldWithRuby(v: Record<string, string>): string {
  return `${v['sentence-furigana']}<div class="muted small">${v['sentence-bold']}</div>`;
}
