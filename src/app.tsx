import { useEffect } from 'preact/hooks';
import { view, toast, refreshDicts, scan, lookupPanel, type View } from './store';
import { refreshDictionaries } from './dictionaries';
import { closeLookupPanel, isNative, pendingLookup } from './lib/native';
import { openText } from './scanActions';
import { CaptureView } from './components/CaptureView';
import { ScanView } from './components/ScanView';
import { NotesView } from './components/NotesView';
import { SettingsView } from './components/SettingsView';

const TABS: { id: View; label: string; icon: string }[] = [
  { id: 'capture', label: 'Capture', icon: '📷' },
  { id: 'scan', label: 'Read', icon: '📖' },
  { id: 'notes', label: 'Mined', icon: '🗂' },
  { id: 'settings', label: 'Settings', icon: '⚙' },
];

export function App() {
  useEffect(() => {
    refreshDicts();
    refreshDictionaries().catch((e) => console.error(e));
    // Persisted storage keeps the dictionary from being evicted on mobile browsers.
    navigator.storage?.persist?.().catch(() => {});
    // Text handed over from elsewhere: selected in another app (Android), or ?text=… (web share target).
    const handed = () => pendingLookup().then((p) => {
      lookupPanel.value = p.popup;
      const text = (p.text || new URLSearchParams(location.search).get('text') || '').trim();
      if (text) openText(text, '');
    });
    handed();
    window.addEventListener('mobileminingLookup', handed);
    // Android app: the back button goes back to the capture screen, then leaves the app.
    if (!isNative()) return;
    let remove: (() => void) | undefined;
    import('@capacitor/app').then(({ App: NativeApp }) =>
      NativeApp.addListener('backButton', () => {
        if (lookupPanel.value) closeLookupPanel();
        else if (view.value !== 'capture') view.value = view.value === 'scan' || !scan.value ? 'capture' : 'scan';
        else NativeApp.minimizeApp();
      }).then((h) => { remove = () => h.remove(); }),
    );
    return () => remove?.();
  }, []);

  const v = view.value;
  // The lookup panel over another app: just the text and the dictionary.
  if (lookupPanel.value) {
    return (
      <div class="app lookup-panel" data-testid="lookup-panel">
        <div class="lookup-bar">
          <b>MobileMining</b>
          <button class="icon-button small" onClick={() => closeLookupPanel()} aria-label="Close">✕</button>
        </div>
        <main class="main">{scan.value ? <ScanView /> : <div class="page center"><p class="muted">No text</p></div>}</main>
        {toast.value && <div class={`toast toast-${toast.value.kind}`} role="status" onClick={() => (toast.value = null)}>{toast.value.text}</div>}
      </div>
    );
  }
  return (
    <div class="app">
      <main class="main">
        {v === 'capture' && <CaptureView />}
        {v === 'scan' && <ScanView />}
        {v === 'notes' && <NotesView />}
        {v === 'settings' && <SettingsView />}
      </main>
      <nav class="tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            class={`tab ${v === t.id ? 'active' : ''}`}
            disabled={t.id === 'scan' && !scan.value}
            onClick={() => (view.value = t.id)}
          >
            <span class="tab-icon" aria-hidden="true">{t.icon}</span>
            <span>{t.label}</span>
          </button>
        ))}
      </nav>
      {toast.value && (
        <div class={`toast toast-${toast.value.kind}`} role="status" onClick={() => (toast.value = null)}>
          {toast.value.text}
        </div>
      )}
    </div>
  );
}
