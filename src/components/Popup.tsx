import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Definition, TermResult } from '../lib/lookup';
import { getKanji, tagDescriptions, type Kanji } from '../lib/db';
import { furiganaSegments, isKanji } from '../lib/kana';
import { audioUrl, findDuplicates, viewNote } from '../lib/anki';
import { renderGlossaryItem } from '../lib/yomitan/render';
import { dictionaryTags, lookupYKanji, resolveMediaImages } from '../lib/yomitan/query';
import type { YKanji, YKanjiMeta } from '../lib/yomitan/types';
import { pitchHtml, downstepPosition } from '../lib/pitch';
import { BUILTIN_KANJIDIC } from '../lib/settings';
import { enabledDictionaries, lookupAt } from '../dictionaries';
import { markerValues, miningContext, quickMine } from '../mining';
import { scan, settings, showToast } from '../store';
import { correctChar } from '../scanActions';

interface Props {
  /** Shown in a panel next to the page instead of floating over it. */
  docked?: boolean;
  index: number;
  results: TermResult[];
  anchor: DOMRect;
  onClose: () => void;
  onRelookup: () => void;
  onEdit: (r: TermResult) => void;
}

type AnkiState = { dupes: number[]; added?: number; busy?: boolean };

export function Popup({ docked, index, results: initialResults, anchor, onClose, onRelookup, onEdit }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [kanji, setKanji] = useState<string | null>(null);
  const [tags, setTags] = useState<Record<string, string>>({});
  const [anki, setAnki] = useState<Record<string, AnkiState>>({});
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number; maxHeight: number; width: number } | null>(null);
  // Nested searches from dictionary links (?query=...)
  const [stack, setStack] = useState<{ query: string; results: TermResult[] }[]>([]);
  const results = stack.length ? stack[stack.length - 1].results : initialResults;
  const nested = stack.length > 0;

  useEffect(() => { tagDescriptions().then(setTags); }, []);

  // Close when tapping outside the popup and the reader text (floating popup only; the docked
  // panel stays open while the page is scrolled or zoomed).
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (docked) return;
      const t = e.target as Element;
      if (ref.current?.contains(t) || t.closest?.('[data-i]') || t.closest?.('.sheet') || t.closest?.('.toast')) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey); };
  }, [onClose]);

  // Duplicate check against Anki (like Yomitan's "already added" state).
  useEffect(() => {
    const st = settings.value;
    if (nested || st.anki.method !== 'ankiconnect' || !st.anki.model || !st.anki.checkForDuplicates || !results.length) return;
    let cancelled = false;
    const s = scan.value!;
    const ctx = miningContext(s, index, st.display.hardLineBreaks);
    Promise.all(
      results.slice(0, 10).map(async (r) => {
        try {
          const values = await markerValues(r, { ...ctx, source: s.source });
          return [key(r), await findDuplicates(st, values)] as const;
        } catch {
          return [key(r), [] as number[]] as const;
        }
      }),
    ).then((pairs) => {
      if (cancelled) return;
      setAnki((prev) => {
        const next = { ...prev };
        for (const [k, dupes] of pairs) next[k] = { ...next[k], dupes };
        return next;
      });
    });
    return () => { cancelled = true; };
  }, [results, index, nested]);

  useLayoutEffect(() => {
    if (docked) return;
    const vw = window.innerWidth, vh = window.innerHeight;
    const nav = document.querySelector('.tabs')?.getBoundingClientRect().height ?? 0;
    const width = Math.min(480, vw - 16);
    const left = Math.min(Math.max(8, anchor.left - 16), vw - width - 8);
    const below = vh - nav - anchor.bottom - 12;
    const above = anchor.top - 12;
    if (below >= 260 || below >= above) setPos({ left, top: anchor.bottom + 6, maxHeight: below, width });
    else setPos({ left, bottom: vh - anchor.top + 6, maxHeight: above, width });
  }, [anchor]);

  // Dictionary images + internal links
  useEffect(() => { if (ref.current) resolveMediaImages(ref.current); });
  const onClick = async (e: MouseEvent) => {
    const a = (e.target as Element).closest?.('a.gloss-link[data-query]') as HTMLAnchorElement | null;
    if (!a) return;
    e.preventDefault();
    const q = a.dataset.query ?? '';
    if (!q) return;
    const res = await lookupAt(Array.from(q), 0);
    setStack([...stack, { query: q, results: res }]);
    ref.current?.scrollTo({ top: 0 });
  };

  const s = scan.value!;
  const meta = s.meta[index];
  const tapped = s.text[index];

  const replaceChar = (c: string) => {
    correctChar(index, c);
    onRelookup();
  };

  const add = async (r: TermResult, force?: 'new' | 'overwrite') => {
    const st = settings.value;
    if (!st.anki.quickAdd || nested) { onEdit(r); return; }
    const k = key(r);
    setAnki((p) => ({ ...p, [k]: { ...(p[k] ?? { dupes: [] }), busy: true } }));
    const out = await quickMine(r, index, force);
    setAnki((p) => ({ ...p, [k]: { ...(p[k] ?? { dupes: [] }), busy: false, added: out.sent?.noteId } }));
    if (out.error) showToast(out.error, 'error');
    else if (out.sent) showToast(`${out.sent.action === 'updated' ? 'Updated' : 'Added'} 「${r.expression}」 in Anki`, 'ok');
    else if (st.anki.method === 'local') showToast(`Saved 「${r.expression}」 — export from the Mined tab`, 'ok');
  };

  const view = (id: number) => viewNote(settings.value, id).catch((e) => showToast(String(e.message ?? e), 'error'));

  return (
    <div
      ref={ref}
      class={`popup${docked ? ' docked' : ''}`}
      role="dialog"
      aria-label="Dictionary"
      data-testid="popup"
      onClick={onClick}
      style={docked ? undefined : pos ? { left: `${pos.left}px`, top: pos.top !== undefined ? `${pos.top}px` : undefined, bottom: pos.bottom !== undefined ? `${pos.bottom}px` : undefined, maxHeight: `${pos.maxHeight}px`, width: `${pos.width}px` } : { visibility: 'hidden' }}
    >
      {(nested || docked) && (
        <div class="popup-nav">
          {nested && <button class="button small" onClick={() => setStack(stack.slice(0, -1))}>← Back</button>}
          <span class="muted small grow" lang="ja">{nested ? stack[stack.length - 1].query : results[0] ? `${results[0].source}` : tapped}</span>
          {docked && <button class="icon-button small" onClick={onClose} aria-label="Close dictionary" data-testid="close-panel">✕</button>}
        </div>
      )}
      {!nested && meta?.alts?.length ? (
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
          <p>No dictionary match for <b lang="ja">{nested ? stack[stack.length - 1].query : tapped}</b>.</p>
          {!nested && isKanji(tapped) && <button class="button small" onClick={() => setKanji(tapped)}>Kanji info</button>}
        </div>
      ) : (
        results.map((r) => (
          <EntryView
            key={key(r)}
            r={r}
            tags={tags}
            anki={anki[key(r)]}
            onKanji={setKanji}
            onAdd={(force) => add(r, force)}
            onEdit={() => onEdit(r)}
            onView={view}
            canMine={!nested}
          />
        ))
      )}
    </div>
  );
}

const key = (r: TermResult) => r.expression + '\u0000' + r.reading;

function EntryView({ r, tags, anki, onKanji, onAdd, onEdit, onView, canMine }: {
  r: TermResult; tags: Record<string, string>; anki?: AnkiState; onKanji: (c: string) => void;
  onAdd: (force?: 'new' | 'overwrite') => void; onEdit: () => void; onView: (id: number) => void; canMine: boolean;
}) {
  const st = settings.value;
  const play = () => {
    const a = new Audio(audioUrl(r.expression, r.reading));
    a.play().catch(() => {});
  };
  const segs = furiganaSegments(r.expression, r.reading);
  const isAnki = st.anki.method === 'ankiconnect';
  const dupe = isAnki && (anki?.dupes.length ?? 0) > 0;
  const viewId = anki?.added ?? anki?.dupes[0];
  const behavior = st.anki.duplicateBehavior;
  // Group consecutive definitions by dictionary
  const byDict: { dict: string; defs: Definition[] }[] = [];
  for (const d of r.definitions) {
    const last = byDict[byDict.length - 1];
    if (last?.dict === d.dict) last.defs.push(d);
    else byDict.push({ dict: d.dict, defs: [d] });
  }
  return (
    <article class="entry">
      <header class="entry-head">
        <div>
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
          {r.pitches.length > 0 && (
            <div class="pitches" lang="ja">
              {dedupePitches(r).map((p, i) => (
                <span key={i} class="pitch-item" title={p.dict}>
                  <span dangerouslySetInnerHTML={{ __html: pitchHtml(p.reading, p.info) }} />
                  <span class="pitch-num">[{downstepPosition(p.info.position)}]</span>
                </span>
              ))}
            </div>
          )}
        </div>
        <div class="entry-actions">
          <button class="icon-button" onClick={play} title="Play audio" aria-label="Play audio">🔊</button>
          {canMine && viewId !== undefined && isAnki && (
            <button class="icon-button" onClick={() => onView(viewId)} title="View note in Anki" aria-label="View note in Anki" data-testid="view-note">📖</button>
          )}
          {canMine && (
            <button class="icon-button" onClick={onEdit} title="Edit before adding" aria-label="Edit card" data-testid="edit-button">✎</button>
          )}
          {canMine && (
            <button
              class={`icon-button mine ${dupe && !anki?.added ? 'dupe' : ''} ${anki?.added ? 'done' : ''}`}
              disabled={anki?.busy || (dupe && behavior === 'prevent') || anki?.added !== undefined}
              onClick={() => onAdd()}
              title={anki?.added !== undefined ? 'Added' : dupe ? (behavior === 'overwrite' ? 'Already in Anki — tap to overwrite' : behavior === 'prevent' ? 'Already in Anki' : 'Already in Anki — tap to add another') : 'Add to Anki'}
              aria-label="Mine"
              data-testid="mine-button"
            >
              {anki?.busy ? '…' : anki?.added !== undefined ? '✓' : dupe ? (behavior === 'overwrite' ? '⟳' : behavior === 'prevent' ? '✓' : '＋') : '＋'}
            </button>
          )}
        </div>
      </header>
      <div class="entry-tags">
        {r.common && <span class="tag common">common</span>}
        {r.frequencies.slice(0, 4).map((f) => (
          <span key={f.dict} class="tag freq" title={f.dict}><b>{shortName(f.dict)}</b> {f.display}</span>
        ))}
        {r.reasons.length > 0 && <span class="reasons">« {r.reasons.join(' › ')}</span>}
        {r.alternates.length > 0 && <span class="alts" lang="ja">{r.alternates.slice(0, 4).join('・')}</span>}
      </div>
      {byDict.map(({ dict, defs }) => (
        <section key={dict} class="dict-block" data-dictionary={dict}>
          {byDict.length > 1 || defs[0].glossary ? <div class="dict-name">{dict}</div> : null}
          {defs[0].senses ? (
            <ol class="senses">
              {defs[0].senses.map((s, i) => (
                <li key={i}>
                  {[...s.p, ...(s.m ?? []), ...(s.f ?? []), ...(s.d ?? [])].map((t) => (
                    <span key={t} class="tag" title={tags[t] ?? t}>{t}</span>
                  ))}
                  <span class="gloss">{s.g.join('; ')}</span>
                  {s.n && <span class="muted small"> ({s.n})</span>}
                </li>
              ))}
            </ol>
          ) : (
            <ImportedDefinitions dict={dict} defs={defs} />
          )}
        </section>
      ))}
    </article>
  );
}

function ImportedDefinitions({ dict, defs }: { dict: string; defs: Definition[] }) {
  const [tagInfo, setTagInfo] = useState<Map<string, { notes: string; category: string }>>(new Map());
  useEffect(() => { dictionaryTags(dict).then(setTagInfo); }, [dict]);
  const html = useMemo(
    () => defs.map((d) => ({ tags: d.tags, items: (d.glossary ?? []).map((g) => renderGlossaryItem(g, { dict, images: 'placeholder' })).filter(Boolean) })),
    [defs, dict],
  );
  return (
    <ol class={`senses imported ${html.length === 1 ? 'single' : ''}`}>
      {html.map((d, i) => (
        <li key={i}>
          {d.tags.map((t) => (
            <span key={t} class={`tag tag-${tagInfo.get(t)?.category ?? 'default'}`} title={tagInfo.get(t)?.notes || t}>{t}</span>
          ))}
          {d.items.length === 1 ? (
            <span class="gloss" dangerouslySetInnerHTML={{ __html: d.items[0] }} />
          ) : (
            <ul class="gloss-list">{d.items.map((h, j) => <li key={j} dangerouslySetInnerHTML={{ __html: h }} />)}</ul>
          )}
        </li>
      ))}
    </ol>
  );
}

function dedupePitches(r: TermResult) {
  const seen = new Set<string>();
  const out: { dict: string; reading: string; info: TermResult['pitches'][0]['pitches'][0] }[] = [];
  for (const p of r.pitches) for (const info of p.pitches) {
    const k = p.reading + ':' + String(info.position);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ dict: p.dict, reading: p.reading, info });
  }
  return out.slice(0, 4);
}

function shortName(dict: string): string {
  const s = dict.replace(/\s*[[(].*$/, '').trim();
  return s.length > 12 ? s.slice(0, 11) + '…' : s;
}

function KanjiCard({ c, onBack }: { c: string; onBack: () => void }) {
  const [k, setK] = useState<Kanji | null | undefined>(undefined);
  const [yk, setYk] = useState<{ kanji: YKanji[]; meta: YKanjiMeta[] }>({ kanji: [], meta: [] });
  useEffect(() => {
    const enabled = enabledDictionaries();
    if (enabled.has(BUILTIN_KANJIDIC)) getKanji(c).then((x) => setK(x ?? null));
    else setK(null);
    lookupYKanji(c, enabled).then(setYk);
  }, [c]);
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
          ) : k === null && !yk.kanji.length ? (
            <p class="muted">Not in any kanji dictionary.</p>
          ) : null}
        </div>
      </div>
      {yk.kanji.map((y, i) => (
        <div key={i} class="ykanji" data-dictionary={y.dict}>
          <div class="dict-name">{y.dict}</div>
          <p class="kanji-meaning">{y.meanings.join(', ')}</p>
          {y.onyomi.length > 0 && <p><span class="muted">On</span> <span lang="ja">{y.onyomi.join('、')}</span></p>}
          {y.kunyomi.length > 0 && <p><span class="muted">Kun</span> <span lang="ja">{y.kunyomi.join('、')}</span></p>}
        </div>
      ))}
      <p class="muted small">
        U+{cp}
        {k?.sc ? ` · ${k.sc} strokes` : ''}
        {k?.g ? ` · ${k.g <= 6 ? `grade ${k.g}` : k.g === 8 ? 'jōyō (secondary)' : 'jinmeiyō'}` : ''}
        {k?.j ? ` · old JLPT level ${k.j}` : ''}
        {k?.f ? ` · freq #${k.f}` : ''}
        {yk.meta.map((m) => ` · ${shortName(m.dict)} ${typeof m.data === 'object' ? (m.data.displayValue ?? m.data.value) : m.data}`).join('')}
      </p>
    </div>
  );
}
