import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { scan, settings, updateSettings, view, showToast } from '../store';
import { runOcr, rotateScan } from '../scanActions';
import type { TermResult } from '../lib/lookup';
import { lookupAt as dictLookup } from '../dictionaries';
import type { Rect } from '../lib/ocr/client';
import type { Orientation } from '../lib/ocr/types';
import { Popup } from './Popup';
import { MineSheet, type MineRequest } from './MineSheet';

type Mode = 'image' | 'text';

export function ScanView() {
  const s = scan.value;
  const [mode, setMode] = useState<Mode>('image');
  const [popup, setPopup] = useState<{ index: number; results: TermResult[]; anchor: DOMRect } | null>(null);
  const [mine, setMine] = useState<MineRequest | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => setPopup(null), [s?.text, mode]);

  if (!s) {
    return (
      <div class="page center">
        <p>No page yet.</p>
        <button class="button primary" onClick={() => (view.value = 'capture')}>Capture</button>
      </div>
    );
  }

  const effectiveMode: Mode = s.url ? mode : 'text';

  const lookupAt = async (index: number, anchor: DOMRect) => {
    try {
      const results = await dictLookup(scan.value!.text, index);
      setPopup({ index, results, anchor });
    } catch (e) {
      showToast(String((e as Error).message ?? e), 'error');
    }
  };

  const r0 = popup?.results[0];
  const hl = popup ? { start: popup.index, end: popup.index + (r0 ? r0.span ?? r0.length : 1) } : null;

  return (
    <div class="scan" ref={rootRef}>
      {effectiveMode === 'image' ? (
        <ImageReader highlight={hl} onTap={lookupAt} onInteract={() => setPopup(null)} onShowText={() => setMode('text')} />
      ) : (
        <TextPanel highlight={hl} onTap={lookupAt} onShowImage={s.url ? () => setMode('image') : undefined} />
      )}
      {popup && (
        <Popup
          key={popup.index + ':' + popup.results.length}
          index={popup.index}
          results={popup.results}
          anchor={popup.anchor}
          onClose={() => setPopup(null)}
          onRelookup={() => {
            const el = rootRef.current?.querySelector(`[data-i="${popup.index}"]`);
            lookupAt(popup.index, el?.getBoundingClientRect() ?? popup.anchor);
          }}
          onEdit={(r) => setMine({ result: r, index: popup.index })}
        />
      )}
      {mine && <MineSheet req={mine} onClose={() => setMine(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Photo reader: scroll / pinch-zoom the photo and tap characters directly on it.

const MAX_ZOOM = 8;

function ImageReader({ highlight, onTap, onInteract, onShowText }: {
  highlight: { start: number; end: number } | null;
  onTap: (index: number, anchor: DOMRect) => void;
  onInteract: () => void;
  onShowText: () => void;
}) {
  const s = scan.value!;
  const W = s.canvas!.width, H = s.canvas!.height;
  const scrollRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [zoom, setZoom] = useState(1);
  const [fit, setFit] = useState(1); // zoom at which the whole page is visible
  const [selecting, setSelecting] = useState(false);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const pendingScroll = useRef<{ left: number; top: number } | null>(null);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const orientation = settings.value.ocr.orientation;
  const lowConf = settings.value.display.highlightLowConfidence;

  // Initial zoom: whole page on wide screens, page width on phones.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const f = Math.min(1, (el.clientHeight * W) / H / el.clientWidth);
    setFit(f);
    setZoom(el.clientWidth / el.clientHeight > W / H ? f : 1);
  }, [s.url]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && pendingScroll.current) {
      el.scrollLeft = pendingScroll.current.left;
      el.scrollTop = pendingScroll.current.top;
      pendingScroll.current = null;
    }
  }, [zoom]);

  /** Zoom keeping the content point under (clientX, clientY) fixed. */
  const zoomAt = (next: number, clientX: number, clientY: number) => {
    const el = scrollRef.current!;
    const z = Math.min(MAX_ZOOM, Math.max(Math.min(fit, 1), next));
    const cur = zoomRef.current;
    if (Math.abs(z - cur) < 1e-3) return;
    const rect = el.getBoundingClientRect();
    const px = clientX - rect.left, py = clientY - rect.top;
    const k = z / cur;
    pendingScroll.current = { left: (el.scrollLeft + px) * k - px, top: (el.scrollTop + py) * k - py };
    setZoom(z);
  };

  // Ctrl+wheel / trackpad pinch on desktop
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      zoomAt(zoomRef.current * Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [fit]);

  // Two-finger pinch on touch screens (one finger scrolls natively)
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ dist: number; zoom: number } | null>(null);
  const onPointerDown = (e: PointerEvent) => {
    if (e.pointerType !== 'touch') return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom: zoomRef.current };
      onInteract();
    }
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch.current && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      zoomAt(pinch.current.zoom * (d / pinch.current.dist), (a.x + b.x) / 2, (a.y + b.y) / 2);
    }
  };
  const onPointerEnd = (e: PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
  };

  // Area selection (re-read part of the photo)
  const toImage = (e: PointerEvent) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  };
  const selDown = (e: PointerEvent) => {
    if (!selecting) return;
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const p = toImage(e);
    setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
  };
  const selMove = (e: PointerEvent) => {
    if (!drag) return;
    const p = toImage(e);
    setDrag({ ...drag, x1: p.x, y1: p.y });
  };
  const selUp = () => {
    if (!drag) return;
    const rect: Rect = { x: Math.max(0, Math.min(drag.x0, drag.x1)), y: Math.max(0, Math.min(drag.y0, drag.y1)), w: Math.abs(drag.x1 - drag.x0), h: Math.abs(drag.y1 - drag.y0) };
    rect.w = Math.min(rect.w, W - rect.x);
    rect.h = Math.min(rect.h, H - rect.y);
    setDrag(null);
    if (rect.w > 12 && rect.h > 12) {
      setSelecting(false);
      runOcr(rect);
    }
  };

  const onClick = (e: MouseEvent) => {
    if (selecting) return;
    const el = (e.target as Element).closest('[data-i]');
    if (!el) { onInteract(); return; }
    onTap(Number((el as SVGElement).dataset.i), el.getBoundingClientRect());
  };

  const setOrientation = (o: Orientation) => {
    updateSettings((st) => (st.ocr.orientation = o));
    runOcr(null);
  };

  const cells = useMemo(
    () => s.geom.map((g, i) => (g ? { i, points: `${g[0]},${g[1]} ${g[2]},${g[3]} ${g[4]},${g[5]} ${g[6]},${g[7]}`, low: lowConf && (s.meta[i]?.p ?? 1) < 0.7 } : null)).filter(Boolean) as { i: number; points: string; low: boolean }[],
    [s.geom, s.meta, lowConf],
  );
  const edited = !!s.lines.length && !cells.length;
  const centre = () => { const r = scrollRef.current!.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2] as const; };

  return (
    <section class="image-reader">
      <div class="toolbar">
        <button class={`button small ${selecting ? 'primary' : ''}`} onClick={() => setSelecting(!selecting)} title="Drag a box around text to read just that area" data-testid="select-area">
          ⬚ {selecting ? 'Drag on photo…' : 'Area'}
        </button>
        <button class="button small" onClick={() => runOcr(null)} disabled={s.busy} title="Read the whole photo again">↻</button>
        <button class="button small" onClick={() => rotateScan()} disabled={s.busy} title="Rotate 90°">⟳</button>
        <select class="small" value={orientation} onChange={(e) => setOrientation((e.target as HTMLSelectElement).value as Orientation)} title="Text direction">
          <option value="auto">Auto</option>
          <option value="horizontal">横</option>
          <option value="vertical">縦</option>
        </select>
        <span class="spacer" />
        <button class="button small" onClick={() => zoomAt(zoom / 1.4, ...centre())} title="Zoom out">−</button>
        <button class="button small" onClick={() => zoomAt(zoom * 1.4, ...centre())} title="Zoom in">+</button>
        <button class="button small" onClick={() => { const [x, y] = centre(); zoomAt(Math.abs(zoom - fit) < 0.01 ? 1 : fit, x, y); }} title="Fit page / fit width">⤢</button>
        <button class="button small" onClick={onShowText} title="Show the recognized text" data-testid="show-text">Aa</button>
      </div>
      {edited && <div class="banner small">You edited the text, so it no longer lines up with the photo. Look words up in the text view (Aa), or press ↻ to read the photo again.</div>}
      <div
        class={`image-scroll ${selecting ? 'selecting' : ''}`}
        ref={scrollRef}
        onScroll={onInteract}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        data-testid="image-reader"
      >
        <div class="image-wrap" style={{ width: `${zoom * 100}%` }}>
          <img src={s.url!} alt="Captured page" draggable={false} />
          <svg
            ref={svgRef}
            class={`overlay ${selecting ? 'selecting' : ''}`}
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            onClick={onClick}
            onPointerDown={selDown}
            onPointerMove={selMove}
            onPointerUp={selUp}
            onPointerCancel={() => setDrag(null)}
          >
            {s.lines.map((l, i) => (
              <polygon key={`l${i}`} class="line-box" points={l.quad.map((p) => `${p.x},${p.y}`).join(' ')} />
            ))}
            {cells.map((c) => (
              <polygon
                key={c.i}
                data-i={c.i}
                class={`ch${c.low ? ' low' : ''}${highlight && c.i >= highlight.start && c.i < highlight.end ? ' hl' : ''}`}
                points={c.points}
              />
            ))}
            {drag && (
              <rect class="sel-rect" x={Math.min(drag.x0, drag.x1)} y={Math.min(drag.y0, drag.y1)} width={Math.abs(drag.x1 - drag.x0)} height={Math.abs(drag.y1 - drag.y0)} />
            )}
          </svg>
        </div>
      </div>
      {s.busy && <div class="busy-overlay"><div class="spinner" />Reading text…</div>}
      {!s.busy && !s.lines.length && <div class="banner small">{s.error ?? 'No text found. Try ⬚ Area around the text, or retake the photo closer.'}</div>}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Text view: the recognized text, for copying, editing and reading without the photo.

function TextPanel({ highlight, onTap, onShowImage }: {
  highlight: { start: number; end: number } | null;
  onTap: (index: number, anchor: DOMRect) => void;
  onShowImage?: () => void;
}) {
  const s = scan.value!;
  const d = settings.value.display;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const lines = useMemo(() => {
    // Group code points into rendered lines; a blank line separates blocks.
    const out: { start: number; chars: string[] }[] = [];
    let cur: { start: number; chars: string[] } = { start: 0, chars: [] };
    s.text.forEach((c, i) => {
      if (c === '\n') {
        out.push(cur);
        cur = { start: i + 1, chars: [] };
      } else cur.chars.push(c);
    });
    out.push(cur);
    return out;
  }, [s.text]);
  const rubyAt = useMemo(() => new Map(s.ruby.map((r) => [r.start, r])), [s.ruby]);

  const onClick = (e: MouseEvent) => {
    const el = (e.target as HTMLElement).closest('[data-i]') as HTMLElement | null;
    if (!el) return;
    onTap(Number(el.dataset.i), el.getBoundingClientRect());
  };

  const saveEdit = () => {
    const cps = Array.from(draft.normalize('NFC'));
    scan.value = { ...s, text: cps, meta: cps.map(() => null), lineOf: cps.map(() => -1), geom: cps.map(() => null), ruby: [] };
    setEditing(false);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(s.text.join(''));
      showToast('Copied', 'ok');
    } catch {
      showToast('Clipboard unavailable', 'error');
    }
  };

  const empty = !s.text.length;
  return (
    <section class="text-panel">
      <div class="toolbar">
        {onShowImage && <button class="button small" onClick={onShowImage} data-testid="show-image">🖼 Photo</button>}
        <button class="button small" onClick={() => updateSettings((st) => (st.display.vertical = !st.display.vertical))} title="Toggle vertical text">
          {d.vertical ? '横' : '縦'}
        </button>
        <button class="button small" onClick={() => { setDraft(s.text.join('')); setEditing(!editing); }}>✎ Edit</button>
        <button class="button small" onClick={copy} disabled={empty}>⧉</button>
        <span class="spacer" />
        {s.timing !== undefined && <span class="muted small">{(s.timing / 1000).toFixed(1)}s</span>}
      </div>
      {editing ? (
        <div class="edit-box">
          <textarea lang="ja" value={draft} onInput={(e) => setDraft((e.target as HTMLTextAreaElement).value)} style={{ fontSize: `${d.fontSize}px` }} />
          <div class="row">
            <button class="button primary" onClick={saveEdit}>Done</button>
            <button class="button" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <div class={`reader ${d.vertical ? 'vertical' : ''}`} lang="ja" style={{ fontSize: `${d.fontSize}px` }} onClick={onClick} data-testid="reader">
          {empty && !s.busy && <p class="muted small placeholder">{s.error ? s.error : 'No text recognized yet.'}</p>}
          {empty && s.busy && <p class="muted small placeholder">Reading text…</p>}
          {lines.map((ln) => (
            <p class={`line ${ln.chars.length ? '' : 'blank'}`} key={ln.start}>
              {renderLine(ln.start, ln.chars.length, (i) => {
                const m = s.meta[i];
                const low = d.highlightLowConfidence && m && m.p < 0.7;
                const inHl = highlight && i >= highlight.start && i < highlight.end;
                return (
                  <span key={i} data-i={i} class={`${low ? 'low' : ''}${inHl ? ' hl' : ''}`}>
                    {s.text[i]}
                  </span>
                );
              }, rubyAt)}
            </p>
          ))}
        </div>
      )}
    </section>
  );
}

/** Renders characters [start, start+len), wrapping furigana ranges in <ruby>. */
function renderLine(start: number, len: number, char: (i: number) => preact.JSX.Element, rubyAt: Map<number, { start: number; end: number; text: string }>) {
  const out: preact.JSX.Element[] = [];
  for (let i = start; i < start + len; ) {
    const r = rubyAt.get(i);
    if (r && r.end <= start + len) {
      const inner: preact.JSX.Element[] = [];
      for (let k = r.start; k < r.end; k++) inner.push(char(k));
      out.push(<ruby key={`r${i}`}>{inner}<rt>{r.text}</rt></ruby>);
      i = r.end;
    } else {
      out.push(char(i));
      i++;
    }
  }
  return out;
}
