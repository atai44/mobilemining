import { useEffect, useRef, useState } from 'preact/hooks';
import { settings, showToast } from '../../store';
import { createBackup, restoreBackup, storageStatus } from '../../lib/backup';
import { completeSettings, saveSettings } from '../../lib/settings';
import { refreshDictionaries } from '../../dictionaries';
import { Toggle } from '../ui';

function mb(n: number) {
  return n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(0.1, n / 1e6).toFixed(1)} MB`;
}

export function BackupSettings() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<{ persisted: boolean | null; usage: number | null } | null>(null);
  const [withDicts, setWithDicts] = useState(true);
  const [progress, setProgress] = useState<string | null>(null);
  const [report, setReport] = useState<string[] | null>(null);
  const refresh = () => storageStatus().then(setStatus);
  useEffect(() => { refresh(); }, []);

  const keep = async () => {
    const ok = await navigator.storage?.persist?.().catch(() => false);
    await refresh();
    showToast(ok ? '✓' : 'Declined · try Add to Home Screen', ok ? 'ok' : 'info');
  };

  const exportBackup = async () => {
    setReport(null);
    try {
      const blob = await createBackup(settings.value, withDicts, (stage, done, total) => setProgress(`${stage}${total > 1 ? ` (${done + 1}/${total})` : ''}…`));
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `mobilemining-backup-${new Date().toISOString().slice(0, 10)}.zip`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      showToast(mb(blob.size), 'ok');
    } catch (e) {
      showToast(String((e as Error).message ?? e), 'error');
    } finally {
      setProgress(null);
    }
  };

  const restore = async (f: File) => {
    setReport(null);
    try {
      const r = await restoreBackup(f, (stage, done, total) => setProgress(`${stage}${total ? ` ${Math.round((done / total) * 100)}%` : '…'}`));
      if (r.settings) {
        // Keep defaults for anything newer than the backup.
        const merged = completeSettings(r.settings);
        saveSettings(merged);
        settings.value = merged;
      }
      await refreshDictionaries();
      setReport([
        r.settings ? '✓ Settings' : '',
        `✓ ${r.notes} mined`,
        r.dictionaries.length ? `✓ ${r.dictionaries.join(', ')}` : '',
        ...r.errors.map((e) => `⚠ ${e}`),
      ].filter(Boolean));
      showToast('Restored', 'ok');
      refresh();
    } catch (e) {
      showToast(String((e as Error).message ?? e), 'error');
    } finally {
      setProgress(null);
    }
  };

  return (
    <section class="card" data-testid="backup">
      <h2>Backup</h2>
      <p class="small muted">This device only{status?.usage != null && <> · {mb(status.usage)}</>}{status?.persisted && <span class="ok-text"> · ✓ persistent</span>}</p>
      {status?.persisted === false && (
        <div class="notice-inline small">
          ⚠ May be cleared by the browser{' '}
          <button class="button small" onClick={keep} data-testid="persist">Keep</button>
        </div>
      )}
      <Toggle label="Include dictionaries" checked={withDicts} onChange={setWithDicts} />
      {progress ? (
        <p class="small">{progress}</p>
      ) : (
        <div class="row wrap">
          <button class="button primary" onClick={exportBackup} data-testid="export-backup">Export</button>
          <button class="button" onClick={() => fileRef.current?.click()} data-testid="restore-backup">Restore…</button>
        </div>
      )}
      <input ref={fileRef} type="file" accept=".zip,application/zip" hidden data-testid="backup-file" onChange={(e) => {
        const input = e.currentTarget as HTMLInputElement;
        const f = input.files?.[0];
        input.value = '';
        if (f) restore(f);
      }} />
      {report && <div class="import-summary small" data-testid="restore-report">{report.map((l) => <div key={l}>{l}</div>)}</div>}
    </section>
  );
}
