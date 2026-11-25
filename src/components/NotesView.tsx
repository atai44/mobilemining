import { useEffect, useState } from 'preact/hooks';
import { deleteNote, listNotes, saveNote, type MinedNote } from '../lib/db';
import { notesToTsv, sendToAnkiConnect, viewNote } from '../lib/anki';
import { settings, showToast } from '../store';

export function NotesView() {
  const [notes, setNotes] = useState<MinedNote[] | null>(null);
  const [busy, setBusy] = useState(false);
  const reload = () => listNotes().then(setNotes);
  useEffect(() => { reload(); }, []);

  const st = settings.value;
  const canSend = st.anki.method === 'ankiconnect';

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

  const exportTsv = () => {
    const blob = new Blob([notesToTsv(notes ?? [], st.anki.tags)], { type: 'text/tab-separated-values' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `mobilemining-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  if (!notes) return <div class="page" />;
  const pendingCount = notes.filter((n) => n.status !== 'added').length;
  return (
    <div class="page">
      <header class="page-header">
        <h1>Mined cards</h1>
        <p class="muted">{notes.length} card{notes.length === 1 ? '' : 's'} · {pendingCount} not yet in Anki</p>
      </header>
      <div class="row wrap">
        {canSend && <button class="button primary" disabled={busy || !pendingCount} onClick={sendPending}>{busy ? 'Sending…' : `Send ${pendingCount} to Anki`}</button>}
        <button class="button" disabled={!notes.length} onClick={exportTsv} title="Import into Anki with File → Import">Export TSV</button>
      </div>
      {!notes.length && <p class="muted center">Cards you mine appear here.</p>}
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
          {onView && <button class="button small" onClick={onView}>View in Anki</button>}
          <button class="button small danger" onClick={() => confirm('Delete this card?') && onDelete()}>Delete</button>
        </div>
      </div>
    </li>
  );
}
