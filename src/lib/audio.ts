// Pronunciation audio availability. JapanesePod101 answers words it has no recording for with a
// fixed "audio not available" clip. Its bytes can't be read cross-origin (no CORS), but its length
// can: the clip is always 5.651 s, while real recordings are a second or two.
const MISSING_CLIP_SECONDS = 5.651;

export type AudioStatus = 'checking' | 'ok' | 'missing' | 'unknown';

interface Clip { el: HTMLAudioElement; status: AudioStatus; ready: Promise<AudioStatus> }
const clips = new Map<string, Clip>();

/** Starts loading the clip's metadata (once per URL) and reports whether it is a real recording. */
export function checkAudio(url: string): Clip {
  let c = clips.get(url);
  if (c) return c;
  const el = new Audio();
  el.preload = 'metadata';
  const clip: Clip = { el, status: 'checking', ready: Promise.resolve('checking') };
  clip.ready = new Promise<AudioStatus>((resolve) => {
    const done = (s: AudioStatus) => { if (clip.status === 'checking') { clip.status = s; resolve(s); } };
    el.addEventListener('loadedmetadata', () => done(Math.abs(el.duration - MISSING_CLIP_SECONDS) < 0.02 ? 'missing' : 'ok'), { once: true });
    el.addEventListener('error', () => done('missing'), { once: true });
    // Some browsers (iOS Low Power Mode) don't preload: leave the button usable.
    setTimeout(() => done('unknown'), 8000);
  });
  el.src = url;
  clips.set(url, clip);
  c = clip;
  return c;
}

/** Plays the clip (synchronously, so it counts as user-initiated on iOS). */
export function playAudio(url: string) {
  const c = checkAudio(url);
  if (c.status === 'missing') return;
  c.el.currentTime = 0;
  c.el.play().catch(() => {});
  // Still checking when tapped: stop if it turns out to be the "not available" clip.
  if (c.status === 'checking') c.ready.then((s) => { if (s === 'missing') c.el.pause(); });
}
