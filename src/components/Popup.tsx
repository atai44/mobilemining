import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { TermResult } from '../lib/lookup';
import { getKanji, tagDescriptions, type Kanji } from '../lib/db';
import { furiganaSegments, isKanji } from '../lib/kana';
import { audioUrl, buildMarkerValues, canAdd } from '../lib/anki';
import { extractSentence } from '../lib/lookup';
import { scan, settings } from '../store';

interface Props {
  index: number;
  results: TermResult[];
  anchor: DOMRect;
  onClose: () => void;
  onRelookup: () => void;
  onMine: (r: TermResult) => void;
}

export function Popup({ index, results, anchor, onClose, onRelookup, onMine }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [kanji, setKanji] = useState<string | null>(null);
  const [tags, setTags] = useState<Record<string, string>>({});
  const [dupes, setDupes] = useState<Record<number, boolean>>({});
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number; maxHeight: number; width: number } | null>(null);

  useEffect(() => { tagDescriptions().then(setTags); }, []);

  // Close when tapping outside the popup and the reader text.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element;
      if (ref.current?.contains(t) || t.closest?.('[data-i]') || t.closest?.('.sheet')) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey); };
  }, [onClose]);

  // Duplicate check against the configured Anki deck.
  useEffect(() => {
    const st = settings.value;
    if (st.anki.method !== 'ankiconnect' || !st.anki.deck || !st.anki.model || !results.length) return;
    let cancelled = false;
    const s = scan.value!;
    const sent = extractSentence(s.text, index, st.display.hardLineBreaks);
    Promise.all(
      results.slice(0, 8).map((r) =>
        canAdd(st, buildMarkerValues(r, sent.sentence, null, s.source, {})).then((ok) => [r.entry.id, !ok] as const).catch(() => [r.entry.id, false] as const),
      ),
    ).then((pairs) => !cancelled && setDupes(Object.fromEntries(pairs)));
    return () => { cancelled = true; };
  }, [results, index]);

  useLayoutEffect(() => {
    const vw = window.innerWidth, vh = window.innerHeight;
    const nav = document.querySelector('.tabs')?.getBoundingClientRect().height ?? 0;
    const width = Math.min(460, vw - 16);
    const left = Math.min(Math.max(8, anchor.left - 16), vw - width - 8);
    const below = vh - nav - anchor.bottom - 12;
    const above = anchor.top - 12;
    if (below >= 240 || below >= above) setPos({ left, top: anchor.bottom + 6, maxHeight: below, width });
    else setPos({ left, bottom: vh - anchor.top + 6, maxHeight: above, width });
  }, [anchor]);

  const s = scan.value!;
  const meta = s.meta[index];
  const tapped = s.text[index];

  const replaceChar = (c: string) => {
    const text = [...s.text];
    const metaArr = [...s.meta];
    text[index] = c;
    metaArr[index] = meta ? { c, p: 1, alts: [{ c: meta.c, p: meta.p }, ...(meta.alts ?? []).filter((a) => a.c !== c)] } : null;
    scan.value = { ...s, text, meta: metaArr };
    onRelookup();
  };

  return (
    <div
      ref={ref}
      class="popup"
      role="dialog"
      aria-label="Dictionary"
      data-testid="popup"
      style={pos ? { left: `${pos.left}px`, top: pos.top !== undefined ? `${pos.top}px` : undefined, bottom: pos.bottom !== undefined ? `${pos.bottom}px` : undefined, maxHeight: `${pos.maxHeight}px`, width: `${pos.width}px` } : { visibility: 'hidden' }}
    >
      {meta?.alts?.length ? (
        <div class="ocr-alts">
          <span class="muted small">OCR read <b lang="ja">{tapped}</b> {Math.round(meta.p * 100)}% · did you mean</span>
          {meta.alts.map((a) => (
            <button key={a.c} class="alt" lang="ja" onClick={() => replaceChar(a.c)} title={`${Math.round(a.p * 100)}%`}>
              {a.c}
            </button>
          ))}
        </div>
      ) : null}
      {kanji ? (
        <KanjiCard c={kanji} onBack={() => setKanji(null)} />
      ) : results.length === 0 ? (
        <div class="empty">
          <p>No dictionary match for <b lang="ja">{tapped}</b>.</p>
          {isKanji(tapped) && <button class="button small" onClick={() => setKanji(tapped)}>Kanji info</button>}
        </div>
      ) : (
        results.map((r) => <EntryView key={r.entry.id} r={r} tags={tags} dupe={dupes[r.entry.id]} onKanji={setKanji} onMine={() => onMine(r)} />)
      )}
    </div>
  );
}

function EntryView({ r, tags, dupe, onKanji, onMine }: { r: TermResult; tags: Record<string, string>; dupe?: boolean; onKanji: (c: string) => void; onMine: () => void }) {
  const play = () => {
    const a = new Audio(audioUrl(r.expression, r.reading));
    a.play().catch(() => {});
  };
  const segs = furiganaSegments(r.expression, r.reading);
  return (
    <article class="entry">
      <header class="entry-head">
        <h3 class="headword" lang="ja">
          {segs.map((sg, i) =>
            sg.r ? (
              <ruby key={i}>
                {Array.from(sg.t).map((c, j) => (isKanji(c) ? <span key={j} class="kanji-link" onClick={() => onKanji(c)}>{c}</span> : c))}
                <rt>{sg.r}</rt>
              </ruby>
            ) : (
              <span key={i}>{sg.t}</span>
            ),
          )}
        </h3>
        <div class="entry-actions">
          <button class="icon-button" onClick={play} title="Play audio" aria-label="Play audio">🔊</button>
          <button class={`icon-button mine ${dupe ? 'dupe' : ''}`} onClick={onMine} title={dupe ? 'Already in your deck — add anyway' : 'Mine this word'} aria-label="Mine" data-testid="mine-button">
            {dupe ? '✓' : '＋'}
          </button>
        </div>
      </header>
      <div class="entry-tags">
        {r.common && <span class="tag common">common</span>}
        {r.reasons.length > 0 && <span class="reasons">« {r.reasons.join(' › ')}</span>}
        {r.alternates.length > 0 && <span class="alts" lang="ja">{r.alternates.slice(0, 4).join('・')}</span>}
      </div>
      <ol class="senses">
        {r.senses.map((s, i) => (
          <li key={i}>
            {[...s.p, ...(s.m ?? []), ...(s.f ?? []), ...(s.d ?? [])].map((t) => (
              <span key={t} class="tag" title={tags[t] ?? t}>{t}</span>
            ))}
            <span class="gloss">{s.g.join('; ')}</span>
            {s.n && <span class="muted small"> ({s.n})</span>}
          </li>
        ))}
      </ol>
    </article>
  );
}

function KanjiCard({ c, onBack }: { c: string; onBack: () => void }) {
  const [k, setK] = useState<Kanji | null | undefined>(undefined);
  useEffect(() => { getKanji(c).then((x) => setK(x ?? null)); }, [c]);
  const cp = c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0');
  return (
    <div class="kanji-card">
      <button class="button small" onClick={onBack}>← Back</button>
      <div class="kanji-main">
        <div class="kanji-big" lang="ja">{c}</div>
        <div>
          {k ? (
            <>
              <p class="kanji-meaning">{k.m.join(', ')}</p>
              {k.on.length > 0 && <p><span class="muted">On</span> <span lang="ja">{k.on.join('、')}</span></p>}
              {k.kun.length > 0 && <p><span class="muted">Kun</span> <span lang="ja">{k.kun.join('、')}</span></p>}
              {k.na?.length ? <p><span class="muted">Nanori</span> <span lang="ja">{k.na.join('、')}</span></p> : null}
            </>
          ) : k === null ? (
            <p class="muted">Not in KANJIDIC2.</p>
          ) : null}
        </div>
      </div>
      <p class="muted small">
        U+{cp}
        {k?.sc ? ` · ${k.sc} strokes` : ''}
        {k?.g ? ` · ${k.g <= 6 ? `grade ${k.g}` : k.g === 8 ? 'jōyō (secondary)' : 'jinmeiyō'}` : ''}
        {k?.j ? ` · old JLPT level ${k.j}` : ''}
        {k?.f ? ` · freq #${k.f}` : ''}
      </p>
    </div>
  );
}
