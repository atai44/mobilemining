import { useEffect, useRef, useState } from 'preact/hooks';
import { dicts, ocrState, refreshDicts, scan, settings, showToast, view } from '../store';
import { installDictionaries } from '../lib/db';
import { ensureOcrEngine, openImage, openText } from '../scanActions';

const BASE = new URL(import.meta.env.BASE_URL, location.href).href;

function fmtMB(n: number) {
  return (n / 1e6).toFixed(1) + ' MB';
}

export function CaptureView() {
  const cameraRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [pasting, setPasting] = useState(false);
  const [pasteText, setPasteText] = useState('');

  const onFile = async (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      await openImage(file, file.name);
    } catch (err) {
      showToast(String((err as Error).message ?? err), 'error');
    }
  };

  // Paste an image (desktop) or drop a file anywhere on this screen.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
      const f = item?.getAsFile();
      if (f) { e.preventDefault(); openImage(f, 'clipboard'); }
    };
    const onDrop = (e: DragEvent) => {
      const f = e.dataTransfer?.files?.[0];
      if (f?.type.startsWith('image/')) { e.preventDefault(); openImage(f, f.name); }
    };
    const onDragOver = (e: DragEvent) => e.preventDefault();
    window.addEventListener('paste', onPaste);
    window.addEventListener('drop', onDrop);
    window.addEventListener('dragover', onDragOver);
    return () => {
      window.removeEventListener('paste', onPaste);
      window.removeEventListener('drop', onDrop);
      window.removeEventListener('dragover', onDragOver);
    };
  }, []);

  return (
    <div class="page capture">
      <header class="page-header">
        <h1>MobileMining</h1>
        <p class="muted">Photograph Japanese text, tap words to look them up, and send sentences to Anki.</p>
      </header>

      <DictionaryCard />

      <div class="capture-buttons">
        <button class="big-button primary" onClick={() => cameraRef.current?.click()}>
          <span class="big-icon">📷</span>Take photo
        </button>
        <button class="big-button" onClick={() => fileRef.current?.click()}>
          <span class="big-icon">🖼</span>Choose image
        </button>
        <button class="big-button" onClick={() => setPasting(!pasting)}>
          <span class="big-icon">⌨</span>Paste text
        </button>
      </div>
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={onFile} data-testid="camera-input" />
      <input ref={fileRef} type="file" accept="image/*" hidden onChange={onFile} data-testid="file-input" />

      {pasting && (
        <div class="card">
          <textarea
            class="paste-area"
            lang="ja"
            placeholder="ここに日本語のテキストを貼り付け…"
            value={pasteText}
            onInput={(e) => setPasteText((e.target as HTMLTextAreaElement).value)}
          />
          <button class="button primary" disabled={!pasteText.trim()} onClick={() => openText(pasteText, 'pasted text')}>
            Read
          </button>
        </div>
      )}

      {scan.value && (
        <button class="button link" onClick={() => (view.value = 'scan')}>
          ← Back to current page
        </button>
      )}

      <OcrCard />
    </div>
  );
}

function DictionaryCard() {
  const [progress, setProgress] = useState<{ stage: string; done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const d = dicts.value;
  if (d === null) return null;
  const installed = !!d.jmdict;

  const install = async () => {
    setError(null);
    setProgress({ stage: 'Starting', done: 0, total: 0 });
    try {
      await installDictionaries(BASE, (stage, done, total) => setProgress({ stage, done, total }));
      await refreshDicts();
      showToast('Dictionary installed', 'ok');
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setProgress(null);
    }
  };

  if (installed && !progress) return null;
  return (
    <div class="card notice">
      <h2>Install the dictionary</h2>
      <p>
        MobileMining uses JMdict (≈220,000 words) and KANJIDIC2 (≈13,000 kanji), stored on your device so lookups work
        offline. One-time download of about 10 MB.
      </p>
      {progress ? (
        <div>
          <div class="progress-label">
            {progress.stage}
            {progress.total > 0 && progress.stage.startsWith('Downloading')
              ? ` ${fmtMB(progress.done)} / ${fmtMB(progress.total)}`
              : progress.total > 0
                ? ` ${progress.done.toLocaleString()} / ${progress.total.toLocaleString()}`
                : '…'}
          </div>
          <progress max={progress.total || undefined} value={progress.total ? progress.done : undefined} />
        </div>
      ) : (
        <button class="button primary" onClick={install} data-testid="install-dict">
          Install dictionary
        </button>
      )}
      {error && <p class="error">{error}</p>}
    </div>
  );
}

function OcrCard() {
  const s = ocrState.value;
  const engine = settings.value.ocr.engine;
  if (engine === 'cloud') return <p class="muted small center">OCR engine: Google Cloud Vision (Settings)</p>;
  return (
    <div class="card subtle">
      <div class="row space">
        <div>
          <strong>On-device OCR</strong>
          <div class="muted small">PP-OCRv6 · horizontal & vertical · 15,908 kanji</div>
        </div>
        {s.state === 'idle' && (
          <button class="button small" onClick={() => ensureOcrEngine().catch(() => {})}>
            Download (31 MB)
          </button>
        )}
        {s.state === 'ready' && <span class="badge ok">Ready</span>}
        {s.state === 'error' && (
          <button class="button small" onClick={() => ensureOcrEngine().catch(() => {})}>
            Retry
          </button>
        )}
      </div>
      {s.state === 'loading' && (
        <div>
          <div class="progress-label">Loading models {s.total ? `${fmtMB(s.loaded ?? 0)} / ${fmtMB(s.total)}` : '…'}</div>
          <progress max={s.total || undefined} value={s.total ? s.loaded : undefined} />
        </div>
      )}
      {s.state === 'error' && <p class="error small">{s.message}</p>}
    </div>
  );
}
