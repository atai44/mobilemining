import { useEffect, useState } from 'preact/hooks';
import { deleteNote, listNotes, saveNote, type MinedNote } from '../lib/db';
import { MM_FIELDS, notesToTsv, sendToAnkiConnect, usesApi, viewNote } from '../lib/anki';
import { saveFile } from '../lib/native';
import { settings, showToast } from '../store';

export function NotesView() {
  const [notes, setNotes] = useState<MinedNote[] | null>(null);
  const [busy, setBusy] = useState(false);
  const reload = () => listNotes().then(setNotes);
  useEffect(() => { reload(); }, []);

  const st = settings.value;
  const canSend = usesApi(st);

  const send = async (n: MinedNote) => {
    try {
      n.ankiNoteId = (await sendToAnkiConnect(st, n)).noteId;
      n.status = 'added';
      n.error = undefined;
    } catch (e) {
      n.status = 'error';
      n.error = String((e as Error).message ?? e);
    }
    await saveNote(n);
  };

  const sendPending = async () => {
    setBusy(true);
    const pending = (notes ?? []).filter((n) => n.status !== 'added');
    for (const n of pending) await send(n);
    await reload();
    setBusy(false);
    const failed = pending.filter((n) => n.status === 'error').length;
    showToast(failed ? `${failed} card(s) failed` : `Sent ${pending.length} card(s)`, failed ? 'error' : 'ok');
  };

  const packaging = st.anki.method === 'local' && st.anki.export.format === 'apkg';

  /** All cards not yet sent, as one Anki package: shared (e.g. to AnkiDroid) or downloaded. */
  const sendPackage = async () => {
    setBusy(true);
    try {
      const pending = (notes ?? []).filter((n) => n.status !== 'added');
      const ex = st.anki.export;
      const { buildApkg, builtinNotetype } = await import('../lib/apkg');
      const res = await buildApkg(pending, { notetype: ex.notetype ?? builtinNotetype(), fields: ex.notetype ? ex.fields : MM_FIELDS, deck: ex.deck || 'Mining', tags: st.anki.tags });
      const file = new File([res.blob], `mobilemining-${new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-')}.apkg`, { type: 'application/octet-stream' });
      let shared = false;
      if (navigator.canShare?.({ files: [file] })) {
        try { await navigator.share({ files: [file] }); shared = true; } catch (e) { if ((e as Error).name === 'AbortError') return; }
      }
      if (!shared) await saveFile(file, file.name);
      for (const n of pending) { n.status = 'added'; n.error = undefined; await saveNote(n); }
      showToast(`${res.notes} → ${file.name}`, 'ok');
    } catch (e) {
      showToast(String((e as Error).message ?? e), 'error');
    } finally {
      setBusy(false);
      reload();
    }
  };

  const exportTsv = () => {
    const blob = new Blob([notesToTsv(notes ?? [], st)], { type: 'text/tab-separated-values' });
    saveFile(blob, `mobilemining-${new Date().toISOString().slice(0, 10)}.txt`).catch((e) => showToast(String(e.message ?? e), 'error'));
  };

  if (!notes) return <div class="page" />;
  const pendingCount = notes.filter((n) => n.status !== 'added').length;
  return (
    <div class="page">
      <header class="page-header">
        <h1>Mined</h1>
        <p class="muted">{notes.length} card{notes.length === 1 ? '' : 's'} · {pendingCount} not yet in Anki</p>
      </header>
      <div class="row wrap">
        {canSend && <button class="button primary" disabled={busy || !pendingCount} onClick={sendPending}>{busy ? 'Sending…' : `Send ${pendingCount}`}</button>}
        {packaging && <button class="button primary" disabled={busy || !pendingCount} onClick={sendPackage} title="Anki package (.apkg)" data-testid="send-apkg">{busy ? '…' : `Send ${pendingCount}`}</button>}
        <button class="button" disabled={!notes.length} onClick={exportTsv} title="Anki: File → Import">TSV ↓</button>
      </div>
      {!notes.length && <p class="muted center">Empty</p>}
      <ul class="note-list">
        {notes.map((n) => (
          <NoteItem key={n.id} n={n} canSend={canSend} onView={n.ankiNoteId && canSend ? () => viewNote(st, n.ankiNoteId!).catch((e) => showToast(String(e.message ?? e), 'error')) : undefined} onSend={async () => { await send(n); reload(); }} onDelete={async () => { await deleteNote(n.id!); reload(); }} />
        ))}
      </ul>
    </div>
  );
}

function NoteItem({ n, canSend, onSend, onDelete, onView }: { n: MinedNote; canSend: boolean; onSend: () => void; onDelete: () => void; onView?: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!n.image) return;
    const u = URL.createObjectURL(n.image);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [n.image]);
  return (
    <li class="note">
      {url && <img src={url} alt="" class="note-thumb" />}
      <div class="note-body">
        <div class="note-word" lang="ja">
          <span dangerouslySetInnerHTML={{ __html: n.fields.furigana ?? n.fields['furigana-html'] ?? n.fields.expression }} />
          <span class={`badge ${n.status === 'added' ? 'ok' : n.status === 'error' ? 'err' : ''}`}>{n.status === 'added' ? 'in Anki' : n.status === 'error' ? 'failed' : 'saved'}</span>
        </div>
        <div class="note-sentence" lang="ja" dangerouslySetInnerHTML={{ __html: n.fields['sentence-bold'] ?? n.fields.sentence }} />
        <div class="muted small">{(n.fields['glossary-plain-no-dictionary'] ?? n.fields['glossary-brief'] ?? '').split('\n')[0].replace(/<[^>]+>/g, ' ').slice(0, 140)}</div>
        {n.error && <div class="error small">{n.error}</div>}
        <div class="row">
          {canSend && n.status !== 'added' && <button class="button small" onClick={onSend}>Send</button>}
          {onView && <button class="button small" onClick={onView} title="View in Anki">📖</button>}
          <button class="button small danger" onClick={() => confirm('Delete?') && onDelete()} title="Delete">🗑</button>
        </div>
      </div>
    </li>
  );
}
