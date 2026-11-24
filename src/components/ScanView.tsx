import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { scan, settings, updateSettings, view, showToast } from '../store';
import { runOcr, rotateScan } from '../scanActions';
import { findTerms, type TermResult } from '../lib/lookup';
import { lookupKeys } from '../lib/db';
import type { Rect } from '../lib/ocr/client';
import type { Orientation } from '../lib/ocr/types';
import { Popup } from './Popup';
import { MineSheet, type MineRequest } from './MineSheet';

export function ScanView() {
  const s = scan.value;
  const [imageHidden, setImageHidden] = useState(false);
  const [popup, setPopup] = useState<{ index: number; results: TermResult[]; anchor: DOMRect } | null>(null);
  const [mine, setMine] = useState<MineRequest | null>(null);
  const [activeLine, setActiveLine] = useState(-1);
  const textRef = useRef<HTMLDivElement>(null);

  useEffect(() => setPopup(null), [s?.text]);

  if (!s) {
    return (
      <div class="page center">
        <p>No page yet.</p>
        <button class="button primary" onClick={() => (view.value = 'capture')}>Capture</button>
      </div>
    );
  }

  const lookupAt = async (index: number, anchor: DOMRect) => {
    try {
      const results = await findTerms(scan.value!.text, index, lookupKeys);
      setPopup({ index, results, anchor });
    } catch (e) {
      showToast(String((e as Error).message ?? e), 'error');
    }
  };

  const onLineTap = (li: number) => {
    setActiveLine(li);
    const el = textRef.current?.querySelector(`[data-line="${li}"]`);
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  };

  const hl = popup && popup.results[0] ? { start: popup.index, end: popup.index + popup.results[0].length } : popup ? { start: popup.index, end: popup.index + 1 } : null;

  return (
    <div class={`scan ${imageHidden || !s.url ? 'no-image' : ''}`}>
      {s.url && !imageHidden && <ImagePanel onLineTap={onLineTap} activeLine={popup ? s.lineOf[popup.index] : activeLine} />}
      <TextPanel
        textRef={textRef}
        highlight={hl}
        onTap={lookupAt}
        imageHidden={imageHidden}
        toggleImage={s.url ? () => setImageHidden(!imageHidden) : undefined}
      />
      {popup && (
        <Popup
          key={popup.index + ':' + popup.results.length}
          index={popup.index}
          results={popup.results}
          anchor={popup.anchor}
          onClose={() => setPopup(null)}
          onRelookup={() => {
            const el = textRef.current?.querySelector(`[data-i="${popup.index}"]`);
            lookupAt(popup.index, el?.getBoundingClientRect() ?? popup.anchor);
          }}
          onMine={(r) => setMine({ result: r, index: popup.index })}
        />
      )}
      {mine && <MineSheet req={mine} onClose={() => setMine(null)} />}
    </div>
  );
}

function ImagePanel({ onLineTap, activeLine }: { onLineTap: (li: number) => void; activeLine: number }) {
  const s = scan.value!;
  const [zoom, setZoom] = useState(1);
  const [selecting, setSelecting] = useState(false);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const W = s.canvas!.width, H = s.canvas!.height;
  const orientation = settings.value.ocr.orientation;

  const toImage = (e: PointerEvent) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  };

  const onDown = (e: PointerEvent) => {
    if (!selecting) return;
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const p = toImage(e);
    setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
  };
  const onMove = (e: PointerEvent) => {
    if (!drag) return;
    const p = toImage(e);
    setDrag({ ...drag, x1: p.x, y1: p.y });
  };
  const onUp = () => {
    if (!drag) return;
    const rect: Rect = {
      x: Math.max(0, Math.min(drag.x0, drag.x1)),
      y: Math.max(0, Math.min(drag.y0, drag.y1)),
      w: Math.abs(drag.x1 - drag.x0),
      h: Math.abs(drag.y1 - drag.y0),
    };
    rect.w = Math.min(rect.w, W - rect.x);
    rect.h = Math.min(rect.h, H - rect.y);
    setDrag(null);
    if (rect.w > 12 && rect.h > 12) {
      setSelecting(false);
      runOcr(rect);
    }
  };

  const setOrientation = (o: Orientation) => {
    updateSettings((st) => (st.ocr.orientation = o));
    runOcr(null);
  };

  return (
    <section class="image-panel">
      <div class="toolbar">
        <button class={`button small ${selecting ? 'primary' : ''}`} onClick={() => setSelecting(!selecting)} title="Drag a box around the text to read">
          ⬚ {selecting ? 'Drag on image…' : 'Select area'}
        </button>
        <button class="button small" onClick={() => runOcr(null)} disabled={s.busy} title="Read the whole image">↻ All</button>
        <button class="button small" onClick={() => rotateScan()} disabled={s.busy} title="Rotate 90°">⟳</button>
        <select class="small" value={orientation} onChange={(e) => setOrientation((e.target as HTMLSelectElement).value as Orientation)} title="Text direction">
          <option value="auto">Auto</option>
          <option value="horizontal">横 Horizontal</option>
          <option value="vertical">縦 Vertical</option>
        </select>
        <span class="spacer" />
        <button class="button small" onClick={() => setZoom(Math.max(1, zoom / 1.5))} disabled={zoom <= 1}>−</button>
        <button class="button small" onClick={() => setZoom(Math.min(6, zoom * 1.5))}>+</button>
      </div>
      <div class="image-scroll">
        <div class="image-wrap" style={{ width: `${zoom * 100}%` }}>
          <img src={s.url!} alt="Captured page" draggable={false} />
          <svg
            ref={svgRef}
            class={`overlay ${selecting ? 'selecting' : ''}`}
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={() => setDrag(null)}
          >
            {s.lines.map((l, i) => (
              <polygon
                key={i}
                class={`line-box ${i === activeLine ? 'active' : ''}`}
                points={l.quad.map((p) => `${p.x},${p.y}`).join(' ')}
                onClick={() => !selecting && onLineTap(i)}
              />
            ))}
            {drag && (
              <rect
                class="sel-rect"
                x={Math.min(drag.x0, drag.x1)}
                y={Math.min(drag.y0, drag.y1)}
                width={Math.abs(drag.x1 - drag.x0)}
                height={Math.abs(drag.y1 - drag.y0)}
              />
            )}
          </svg>
          {s.busy && <div class="busy-overlay"><div class="spinner" />Reading text…</div>}
        </div>
      </div>
    </section>
  );
}

function TextPanel({
  textRef,
  highlight,
  onTap,
  imageHidden,
  toggleImage,
}: {
  textRef: { current: HTMLDivElement | null };
  highlight: { start: number; end: number } | null;
  onTap: (index: number, anchor: DOMRect) => void;
  imageHidden: boolean;
  toggleImage?: () => void;
}) {
  const s = scan.value!;
  const d = settings.value.display;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const lines = useMemo(() => {
    // Group code points into rendered lines.
    const out: { li: number; start: number; chars: string[] }[] = [];
    let cur: { li: number; start: number; chars: string[] } = { li: s.lineOf[0] ?? -1, start: 0, chars: [] };
    s.text.forEach((c, i) => {
      if (c === '\n') {
        out.push(cur);
        cur = { li: s.lineOf[i + 1] ?? -1, start: i + 1, chars: [] };
      } else cur.chars.push(c);
    });
    out.push(cur);
    return out;
  }, [s.text, s.lineOf]);

  const onClick = (e: MouseEvent) => {
    const el = (e.target as HTMLElement).closest('[data-i]') as HTMLElement | null;
    if (!el) return;
    onTap(Number(el.dataset.i), el.getBoundingClientRect());
  };

  const saveEdit = () => {
    const cps = Array.from(draft.normalize('NFC'));
    scan.value = { ...s, text: cps, meta: cps.map(() => null), lineOf: cps.map(() => -1) };
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
        {toggleImage && (
          <button class="button small" onClick={toggleImage}>{imageHidden ? '🖼 Show image' : '🖼 Hide'}</button>
        )}
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
        <div
          ref={textRef}
          class={`reader ${d.vertical ? 'vertical' : ''}`}
          lang="ja"
          style={{ fontSize: `${d.fontSize}px` }}
          onClick={onClick}
          data-testid="reader"
        >
          {empty && !s.busy && <p class="muted small placeholder">{s.error ? s.error : 'No text recognized yet.'}</p>}
          {empty && s.busy && <p class="muted small placeholder">Reading text…</p>}
          {lines.map((ln) => (
            <p class={`line ${ln.chars.length ? '' : 'blank'}`} data-line={ln.li} key={ln.start}>
              {ln.chars.map((c, j) => {
                const i = ln.start + j;
                const m = s.meta[i];
                const low = d.highlightLowConfidence && m && m.p < 0.7;
                const inHl = highlight && i >= highlight.start && i < highlight.end;
                return (
                  <span key={i} data-i={i} class={`${low ? 'low' : ''}${inHl ? ' hl' : ''}`}>
                    {c}
                  </span>
                );
              })}
            </p>
          ))}
        </div>
      )}
    </section>
  );
}
