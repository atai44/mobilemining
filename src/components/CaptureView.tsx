import { useEffect, useRef, useState } from 'preact/hooks';
import { dictProgress, dicts, ocrState, refreshDicts, scan, settings, showToast, view } from '../store';
import { installDictionaries } from '../lib/db';
import { ensureOcrEngine, openImage, openPdfFile, openText } from '../scanActions';
import { isAndroid } from '../lib/anki';
import { isNative } from '../lib/native';

const BASE = new URL(import.meta.env.BASE_URL, location.href).href;

function fmtMB(n: number) {
  return (n / 1e6).toFixed(1) + ' MB';
}

const isPdf = (f: File) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
/** A source name for cards: the file's name, unless it is just a camera's serial name. */
const sourceName = (f: File) => {
  const base = f.name.replace(/\.[a-z0-9]+$/i, '');
  return /^(jpe?g|img|image|pxl|dsc|dcim|photo|screenshot|mvimg|[0-9a-f-]{20,})?[\s_\-.\d]*$/i.test(base) ? '' : base;
};
const openFile = (f: File) => (isPdf(f) ? openPdfFile(f, f.name.replace(/\.pdf$/i, '')) : openImage(f, sourceName(f)));

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
      await openFile(file);
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
      if (f && (f.type.startsWith('image/') || isPdf(f))) { e.preventDefault(); openFile(f); }
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
      </header>

      <DictionaryCard />

      <div class="capture-buttons">
        <button class="big-button primary" onClick={() => cameraRef.current?.click()}>
          <span class="big-icon">📷</span>Camera
        </button>
        <button class="big-button" onClick={() => fileRef.current?.click()}>
          <span class="big-icon">🖼</span>Image / PDF
        </button>
        <button class="big-button" onClick={() => setPasting(!pasting)}>
          <span class="big-icon">⌨</span>Text
        </button>
      </div>
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={onFile} data-testid="camera-input" />
      <input ref={fileRef} type="file" accept="image/*,application/pdf,.pdf" hidden onChange={onFile} data-testid="file-input" />

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
          ← Back
        </button>
      )}

      <OcrCard />
      {isAndroid() && !isNative() && (
        <p class="center small"><a href="./mobilemining.apk" data-testid="apk-link">Android app ↓</a> <span class="muted">adds straight to AnkiDroid</span></p>
      )}
    </div>
  );
}

function DictionaryCard() {
  const progress = dictProgress.value;
  const setProgress = (p: typeof dictProgress.value) => (dictProgress.value = p);
  const [error, setError] = useState<string | null>(null);
  const d = dicts.value;
  const installed = !!d?.jmdict;

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

  // In the Android app the dictionary files are inside the APK: import them right away.
  useEffect(() => { if (isNative() && d !== null && !installed && !progress && !error) install(); }, [d === null, installed]);

  if (d === null || (installed && !progress)) return null;
  return (
    <div class="card notice">
      <h2>Dictionary</h2>
      {!installed && <p class="muted small">JMdict + KANJIDIC2 · 10 MB · offline</p>}
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
          Install
        </button>
      )}
      {error && <p class="error">{error}</p>}
    </div>
  );
}

function OcrCard() {
  const s = ocrState.value;
  const engine = settings.value.ocr.engine;
  if (engine === 'cloud') return <p class="muted small center">OCR: Cloud Vision</p>;
  return (
    <div class="card subtle">
      <div class="row space">
        <div>
          <strong>OCR</strong> <span class="muted small">on-device</span>
        </div>
        {s.state === 'idle' && (
          <button class="button small" onClick={() => ensureOcrEngine().catch(() => {})}>
            {isNative() ? 'Load' : 'Get · 31 MB'}
          </button>
        )}
        {s.state === 'ready' && <span class="badge ok">✓</span>}
        {s.state === 'error' && (
          <button class="button small" onClick={() => ensureOcrEngine().catch(() => {})}>
            Retry
          </button>
        )}
      </div>
      {s.state === 'loading' && (
        <div>
          <div class="progress-label">{s.total ? `${fmtMB(s.loaded ?? 0)} / ${fmtMB(s.total)}` : '…'}</div>
          <progress max={s.total || undefined} value={s.total ? s.loaded : undefined} />
        </div>
      )}
      {s.state === 'error' && <p class="error small">{s.message}</p>}
    </div>
  );
}
