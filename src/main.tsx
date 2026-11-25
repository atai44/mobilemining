import { render } from 'preact';
import { App } from './app';
import './styles.css';
import { isNative } from './lib/native';

render(<App />, document.getElementById('app')!);

// The Android app serves its files from the APK: no service worker needed.
if ('serviceWorker' in navigator && import.meta.env.PROD && !isNative()) {
  navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('Service worker registration failed', e));
}
