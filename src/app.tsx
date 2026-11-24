import { useEffect } from 'preact/hooks';
import { view, toast, refreshDicts, scan, type View } from './store';
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
    // Persisted storage keeps the dictionary from being evicted on mobile browsers.
    navigator.storage?.persist?.().catch(() => {});
  }, []);

  const v = view.value;
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
