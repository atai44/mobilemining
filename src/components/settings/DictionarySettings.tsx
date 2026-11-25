import { useEffect, useRef } from 'preact/hooks';
import { dictErrors, dictProgress, dicts, refreshDicts, settings, showToast, updateSettings } from '../../store';
import { installDictionaries } from '../../lib/db';
import { BUILTIN_JMDICT, BUILTIN_KANJIDIC } from '../../lib/settings';
import { deleteDictionary, importYomitanDictionary } from '../../lib/yomitan/importer';
import { installedDictionaries, refreshDictionaries } from '../../dictionaries';

const BASE = new URL(import.meta.env.BASE_URL, location.href).href;

const KIND_LABEL: Record<string, string> = { terms: 'terms', freq: 'frequency', pitch: 'pitch accent', ipa: 'IPA', kanji: 'kanji', 'kanji-freq': 'kanji frequency' };

export function DictionarySettings() {
  const fileRef = useRef<HTMLInputElement>(null);
  // Progress lives in the store: an import keeps running (and showing) when you leave this tab.
  const progress = dictProgress.value;
  const setProgress = (p: typeof dictProgress.value) => (dictProgress.value = p);
  const errors = dictErrors.value;
  const setErrors = (e: string[]) => (dictErrors.value = e);
  useEffect(() => { refreshDictionaries(); }, []);

  const builtin = dicts.value ?? {};
  const installed = new Map(installedDictionaries.value.map((d) => [d.title, d]));
  const list = settings.value.dictionaries;

  const importFiles = async (files: File[]) => {
    setErrors([]);
    const errs: string[] = [];
    for (const f of files) {
      try {
        const rec = await importYomitanDictionary(f, (stage, done, total) => setProgress({ stage, done, total }));
        showToast(`Imported ${rec.title}`, 'ok');
      } catch (e) {
        errs.push(`${f.name}: ${(e as Error).message ?? e}`);
      }
    }
    setProgress(null);
    setErrors(errs);
    await refreshDictionaries();
  };

  const remove = async (title: string) => {
    if (!confirm(`Delete “${title}”?`)) return;
    await deleteDictionary(title, (stage, done, total) => setProgress({ stage, done, total }));
    setProgress(null);
    await refreshDictionaries();
  };

  const installBuiltin = async () => {
    try {
      await installDictionaries(BASE, (stage, done, total) => setProgress({ stage, done, total }));
      await refreshDicts();
      showToast('Installed', 'ok');
    } catch (e) {
      showToast(String((e as Error).message ?? e), 'error');
    } finally {
      setProgress(null);
    }
  };

  const move = (i: number, d: -1 | 1) => updateSettings((s) => {
    const j = i + d;
    if (j < 0 || j >= s.dictionaries.length) return;
    [s.dictionaries[i], s.dictionaries[j]] = [s.dictionaries[j], s.dictionaries[i]];
  });

  return (
    <section class="card" data-testid="dictionaries">
      <h2>Dictionaries</h2>
      <p class="muted small">Yomitan .zip · top = first</p>
      <ul class="dict-list">
        {list.map((d, i) => {
          const rec = installed.get(d.name);
          const isBuiltin = d.name === BUILTIN_JMDICT || d.name === BUILTIN_KANJIDIC;
          const builtinInfo = d.name === BUILTIN_JMDICT ? builtin.jmdict : d.name === BUILTIN_KANJIDIC ? builtin.kanjidic : undefined;
          const missing = isBuiltin && !builtinInfo;
          return (
            <li key={d.name} class={`dict-row ${d.enabled ? '' : 'disabled'}`}>
              <input type="checkbox" checked={d.enabled} aria-label={`Enable ${d.name}`} onChange={(e) => updateSettings((s) => (s.dictionaries[i].enabled = (e.target as HTMLInputElement).checked))} />
              <div class="dict-info">
                <div class="dict-title">{d.name}</div>
                <div class="muted small">
                  {rec
                    ? [rec.revision, ...rec.kinds.map((k) => KIND_LABEL[k] ?? k), rec.counts.terms ? `${rec.counts.terms.toLocaleString()} terms` : '', rec.counts.media ? `${rec.counts.media} images` : '']
                        .filter(Boolean).join(' · ')
                    : builtinInfo
                      ? `${builtinInfo.version} · ${builtinInfo.count.toLocaleString()} ${d.name === BUILTIN_JMDICT ? 'entries' : 'kanji'}`
                      : missing ? 'not installed' : ''}
                </div>
              </div>
              <div class="dict-actions">
                <button class="icon-button small" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up">↑</button>
                <button class="icon-button small" onClick={() => move(i, 1)} disabled={i === list.length - 1} aria-label="Move down">↓</button>
                {rec && <button class="icon-button small danger" onClick={() => remove(d.name)} aria-label={`Delete ${d.name}`}>✕</button>}
              </div>
            </li>
          );
        })}
      </ul>
      {progress ? (
        <div>
          <div class="progress-label">{progress.stage}{progress.total ? ` ${Math.round((progress.done / progress.total) * 100)}%` : '…'}</div>
          <progress max={progress.total || undefined} value={progress.total ? progress.done : undefined} />
        </div>
      ) : (
        <div class="row wrap">
          <button class="button primary" onClick={() => fileRef.current?.click()} data-testid="import-dict">Import .zip</button>
          <button class="button" onClick={installBuiltin}>{builtin.jmdict ? 'Update JMdict' : 'Install JMdict'}</button>
        </div>
      )}
      <input
        ref={fileRef}
        type="file"
        accept=".zip,application/zip"
        multiple
        hidden
        data-testid="dict-file"
        onChange={(e) => {
          const input = e.currentTarget as HTMLInputElement;
          const files = [...(input.files ?? [])];
          input.value = '';
          if (files.length) importFiles(files);
        }}
      />
      {errors.map((e) => <p key={e} class="error small">{e}</p>)}
    </section>
  );
}
