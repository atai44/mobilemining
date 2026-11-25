import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { signal } from '@preact/signals';
import { scan, settings, updateSettings, view, showToast, ocrState, locate, indexOf } from '../store';
import {
  runOcr, rotateScan, startAnalysis, focusAt, setEditedText, showPdfPage,
  mergeSections, moveSection, deleteSection, redirectSection, resetSections,
  rereadSection, createArea, updateArea, deleteArea, rereadArea, areaCorners, type Area,
} from '../scanActions';
import type { LaidOutLine } from '../lib/ocr/layout';
import type { TermResult } from '../lib/lookup';
import { lookupAt as dictLookup } from '../dictionaries';
import type { Rect } from '../lib/ocr/client';
import type { Orientation, Point } from '../lib/ocr/types';
import { Popup } from './Popup';
import { MineSheet, type MineRequest } from './MineSheet';

type Mode = 'image' | 'text';

const PANEL_KEY = 'mobilemining.panelSize';
const loadPanelSize = () => {
  try { return Number(localStorage.getItem(PANEL_KEY)) || 0.42; } catch { return 0.42; }
};

export function ScanView() {
  const s = scan.value;
  const [mode, setMode] = useState<Mode>('image');
  // The popup is tied to a (line, character) position so it survives lines being read in the background.
  const [popup, setPopup] = useState<{ pos: { key: string; ci: number } | null; index: number; results: TermResult[]; anchor: DOMRect } | null>(null);
  const [mine, setMine] = useState<MineRequest | null>(null);
  const [panelSize, setPanelSize] = useState(loadPanelSize); // fraction of the reader's height (or width on wide screens)
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => setPopup(null), [s?.url, mode]);

  if (!s) {
    return (
      <div class="page center">
        <p>No page yet.</p>
        <button class="button primary" onClick={() => (view.value = 'capture')}>Capture</button>
      </div>
    );
  }

  const effectiveMode: Mode = s.url ? mode : 'text';
  // Current index of the popup's character (lines read since may have shifted it).
  const popupIndex = popup ? (popup.pos ? indexOf(s, popup.pos) : popup.index) : -1;
  const livePopup = popup && popupIndex >= 0 && s.text[popupIndex] !== undefined ? popup : null;

  const lookupAt = async (index: number, anchor: DOMRect) => {
    try {
      const cur = scan.value!;
      const pos = locate(cur, index);
      const results = await dictLookup(cur.text, index);
      setPopup({ pos, index, results, anchor });
    } catch (e) {
      showToast(String((e as Error).message ?? e), 'error');
    }
  };

  const r0 = livePopup?.results[0];
  const hl = livePopup ? { start: popupIndex, end: popupIndex + (r0 ? r0.span ?? r0.length : 1) } : null;

  // Drag the panel's edge to resize it.
  const startResize = (e: PointerEvent) => {
    const root = rootRef.current;
    if (!root) return;
    e.preventDefault();
    const grip = e.currentTarget as HTMLElement;
    grip.setPointerCapture(e.pointerId);
    const wide = getComputedStyle(root).flexDirection === 'row';
    const move = (ev: PointerEvent) => {
      const r = root.getBoundingClientRect();
      const f = wide ? (r.right - ev.clientX) / r.width : (r.bottom - ev.clientY) / r.height;
      setPanelSize(Math.min(0.75, Math.max(0.2, f)));
    };
    const up = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      try { localStorage.setItem(PANEL_KEY, String(panelSizeRef.current)); } catch { /* ignore */ }
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
  };
  const panelSizeRef = useRef(panelSize);
  panelSizeRef.current = panelSize;

  return (
    <div class={`scan ${livePopup ? 'has-panel' : ''}`} ref={rootRef} style={{ '--panel-size': `${Math.round(panelSize * 100)}%` }}>
      <div class="scan-main">
        {effectiveMode === 'image' ? (
          <ImageReader highlight={hl} onTap={lookupAt} onEmptyTap={() => setPopup(null)} onShowText={() => setMode('text')} />
        ) : (
          <TextPanel highlight={hl} onTap={lookupAt} onShowImage={s.url ? () => setMode('image') : undefined} />
        )}
      </div>
      {livePopup && (
        <div class="dict-panel" data-testid="dict-panel">
          <div class="panel-grip" onPointerDown={startResize} aria-label="Resize" />
          <Popup
            docked
            key={(livePopup.pos ? livePopup.pos.key + ':' + livePopup.pos.ci : livePopup.index) + ':' + livePopup.results.length}
            index={popupIndex}
            results={livePopup.results}
            anchor={livePopup.anchor}
            onClose={() => setPopup(null)}
            onRelookup={() => {
              const el = rootRef.current?.querySelector(`[data-i="${popupIndex}"]`);
              lookupAt(popupIndex, el?.getBoundingClientRect() ?? livePopup.anchor);
            }}
            onEdit={(r) => setMine({ result: r, index: popupIndex })}
          />
        </div>
      )}
      {mine && <MineSheet req={mine} onClose={() => setMine(null)} />}
    </div>
  );
}

/** Scrolls `container` so `el` is comfortably visible (it may have been hidden by the panel opening). */
function keepVisible(container: HTMLElement, el: Element) {
  const c = container.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const mx = Math.min(40, c.width * 0.15), my = Math.min(60, c.height * 0.2);
  let dx = 0, dy = 0;
  if (r.top < c.top + my || r.bottom > c.bottom - my) dy = r.top + r.height / 2 - (c.top + c.height * 0.4);
  if (r.left < c.left + mx || r.right > c.right - mx) dx = r.left + r.width / 2 - (c.left + c.width / 2);
  if (dx || dy) container.scrollBy({ left: dx, top: dy, behavior: 'smooth' });
}

// ---------------------------------------------------------------------------------------------
// Photo reader: scroll / pinch-zoom the photo and tap characters directly on it. The photo is
// read in the background; tapping a part that hasn't been read yet reads it first.

const MAX_ZOOM = 8;
const SECTION_COLORS = ['#e8590c', '#1c7ed6', '#2f9e44', '#ae3ec9', '#f08c00', '#0c8599', '#d6336c', '#5c940d'];

function ImageReader({ highlight, onTap, onEmptyTap, onShowText }: {
  highlight: { start: number; end: number } | null;
  onTap: (index: number, anchor: DOMRect) => void;
  onEmptyTap: () => void;
  onShowText: () => void;
}) {
  const s = scan.value!;
  const W = s.canvas!.width, H = s.canvas!.height;
  const scrollRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [zoom, setZoom] = useState(1);
  const [fit, setFit] = useState(1); // zoom at which the whole page is visible
  const [draw, setDraw] = useState<'area' | null>(null);
  const [selArea, setSelArea] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const selecting = draw !== null;
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [focus, setFocus] = useState<Point | null>(null);
  const [sections, setSections] = useState(false);
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

  // A touch that starts on a section-box handle drags the handle. Browsers decide on scrolling at
  // touchstart and ignore touch-action on SVG shapes, so claim the touch here (non-passive).
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const claim = (e: TouchEvent) => {
      if (e.touches.length === 1 && (e.target as Element).closest?.('.area-hit')) e.preventDefault();
    };
    svg.addEventListener('touchstart', claim, { passive: false });
    return () => svg.removeEventListener('touchstart', claim);
  }, [s.url]);

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

  const toImage = (e: { clientX: number; clientY: number }): Point => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  };

  // Area selection (re-read part of the photo)
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
      setDraw(null);
      // The box becomes its own section (reading the area first if no text was found in it).
      const { area: a, reading } = createArea(rect);
      setSelArea(a.id);
      setFlash(a.id);
      setTimeout(() => setFlash((f) => (f === a.id ? null : f)), 1400);
      reading.then(() => {
        const info = scan.value?.areas.find((x) => x.id === a.id);
        showToast(info && info.count ? `§${info.section + 1} · ${info.count} line${info.count === 1 ? '' : 's'}` : 'No text', info?.count ? 'ok' : 'info');
      });
    }
  };

  const tapAt = async (index: number) => {
    // Wait for the re-render that creates the character's tap target, then anchor the popup on it.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const el = svgRef.current?.querySelector(`[data-i="${index}"]`);
    if (el) onTap(index, el.getBoundingClientRect());
  };

  const onClick = async (e: MouseEvent) => {
    if (selecting || sections) return;
    const el = (e.target as Element).closest('[data-i]');
    if (el) { onTap(Number((el as SVGElement).dataset.i), el.getBoundingClientRect()); return; }
    onEmptyTap();
    // A line that hasn't been read yet: read it (and its neighbours) first.
    const p = toImage(e);
    if (!(e.target as Element).closest('.pending') && !s.pending.length) return;
    setFocus(p);
    try {
      const i = await focusAt(p);
      if (i >= 0) await tapAt(i);
    } finally {
      setFocus(null);
    }
  };

  // Keep the looked-up word visible above (or beside) the dictionary panel.
  useLayoutEffect(() => {
    if (!highlight) return;
    const id = requestAnimationFrame(() => {
      const el = svgRef.current?.querySelector(`[data-i="${highlight.start}"]`);
      if (el && scrollRef.current) keepVisible(scrollRef.current, el);
    });
    return () => cancelAnimationFrame(id);
  }, [highlight?.start]);

  const setOrientation = (o: Orientation) => {
    updateSettings((st) => (st.ocr.orientation = o));
    startAnalysis();
  };

  const cells = useMemo(
    () => s.geom.map((g, i) => (g ? { i, points: `${g[0]},${g[1]} ${g[2]},${g[3]} ${g[4]},${g[5]} ${g[6]},${g[7]}`, low: lowConf && (s.meta[i]?.p ?? 1) < 0.7 } : null)).filter(Boolean) as { i: number; points: string; low: boolean }[],
    [s.geom, s.meta, lowConf],
  );
  const edited = !!s.lines.length && !cells.length;
  const centre = () => { const r = scrollRef.current!.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2] as const; };
  const pg = s.progress;
  const unit = Math.max(W, H) / 100;

  return (
    <section class="image-reader">
      <div class="toolbar">
        <button class={`button small ${draw === 'area' ? 'primary' : ''}`} onClick={() => { setSections(false); setSelArea(null); setDraw(draw === 'area' ? null : 'area'); }} title="New section" data-testid="select-area">
          ⬚ {draw === 'area' ? 'Drag…' : 'Area'}
        </button>
        <button class={`button small ${sections ? 'primary' : ''}`} onClick={() => { setDraw(null); setSections(!sections); }} title="Sections" data-testid="sections">
          § Sections
        </button>
        <button class="button small" onClick={() => startAnalysis()} title="Re-read">↻</button>
        <button class="button small" onClick={() => rotateScan()} title="Rotate 90°">⟳</button>
        <select class="small" value={orientation} onChange={(e) => setOrientation((e.target as HTMLSelectElement).value as Orientation)} title="Text direction">
          <option value="auto">Auto</option>
          <option value="horizontal">横</option>
          <option value="vertical">縦</option>
        </select>
        <span class="spacer" />
        {s.doc && s.doc.pages > 1 && (
          <span class="pager" data-testid="pager">
            <button class="button small" disabled={s.doc.page <= 1} onClick={() => showPdfPage(s.doc!.page - 1)} aria-label="Previous page">‹</button>
            <span class="small">{s.doc.page}/{s.doc.pages}</span>
            <button class="button small" disabled={s.doc.page >= s.doc.pages} onClick={() => showPdfPage(s.doc!.page + 1)} aria-label="Next page" data-testid="next-page">›</button>
          </span>
        )}
        <button class="button small zoom-btn" onClick={() => zoomAt(zoom / 1.4, ...centre())} title="Zoom out">−</button>
        <button class="button small zoom-btn" onClick={() => zoomAt(zoom * 1.4, ...centre())} title="Zoom in">+</button>
        <button class="button small" onClick={() => { const [x, y] = centre(); zoomAt(Math.abs(zoom - fit) < 0.01 ? 1 : fit, x, y); }} title="Fit">⤢</button>
        <button class="button small" onClick={onShowText} title="Text" data-testid="show-text">Aa</button>
      </div>
      <ProgressBar />
      {edited && <div class="banner small">Edited text · ↻ to re-read</div>}
      <div
        class={`image-scroll ${selecting ? 'selecting' : ''}`}
        ref={scrollRef}
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
            {s.pending.map((p) => (
              <polygon key={p.key} class={`pending${p.busy ? ' busy' : ''}`} points={p.quad.map((q) => `${q.x},${q.y}`).join(' ')} />
            ))}
            {/* Line outlines in their section's colour, on a light halo so they show on any background. */}
            {!sections && s.lines.map((l, i) => {
              const pts = l.quad.map((p) => `${p.x},${p.y}`).join(' ');
              const block = (l as LaidOutLine).block ?? 0;
              return (
                <g key={`l${l.key ?? i}`}>
                  <polygon class="line-halo" points={pts} />
                  <polygon class="line-box" points={pts} style={{ stroke: SECTION_COLORS[block % SECTION_COLORS.length] }} />
                </g>
              );
            })}
            {!sections && cells.map((c) => (
              <polygon
                key={c.i}
                data-i={c.i}
                class={`ch${c.low ? ' low' : ''}${highlight && c.i >= highlight.start && c.i < highlight.end ? ' hl' : ''}`}
                points={c.points}
              />
            ))}
            {focus && <circle class="focus-dot" cx={focus.x} cy={focus.y} r={unit * 1.6} />}
            {drag && (
              <rect class="sel-rect" x={Math.min(drag.x0, drag.x1)} y={Math.min(drag.y0, drag.y1)} width={Math.abs(drag.x1 - drag.x0)} height={Math.abs(drag.y1 - drag.y0)} />
            )}
            {sections && <SectionOverlay unit={unit} />}
            {!sections && (
              <AreaLayer
                svgRef={svgRef}
                W={W}
                selected={selArea}
                drawing={selecting}
                flash={flash}
                onSelect={setSelArea}
              />
            )}
          </svg>
        </div>
      </div>
      {sections && <SectionBar onDone={() => { setDraw(null); setSections(false); }} />}
      {!sections && selArea && <AreaBar id={selArea} onDone={() => setSelArea(null)} />}
      {!pg || pg.phase !== 'done' || s.lines.length || s.busy ? null : <div class="banner small">{s.error ?? 'No text found'}</div>}
    </section>
  );
}

function ProgressBar() {
  const s = scan.value!;
  const pg = s.progress;
  const ocr = ocrState.value;
  let label = '';
  let frac: number | undefined;
  if (s.busy) label = 'Reading…';
  else if (pg?.phase === 'models') {
    label = ocr.total ? `OCR ${((ocr.loaded ?? 0) / 1e6).toFixed(0)}/${(ocr.total / 1e6).toFixed(0)} MB` : 'OCR…';
    frac = ocr.total ? (ocr.loaded ?? 0) / ocr.total : undefined;
  } else if (pg?.phase === 'detect') label = 'Finding text…';
  else if (pg?.phase === 'read' && pg.total) { label = `Reading ${pg.done}/${pg.total}`; frac = pg.done / pg.total; }
  else if (pg?.phase === 'error') label = s.error ?? 'OCR failed';
  if (!label) return null;
  return (
    <div class={`progress-strip ${pg?.phase === 'error' ? 'error' : ''}`} data-testid="ocr-progress">
      <span>{label}</span>
      <div class="bar"><div style={{ width: frac === undefined ? '30%' : `${Math.round(frac * 100)}%` }} class={frac === undefined ? 'indeterminate' : ''} /></div>
    </div>
  );
}

// --- Section editing ------------------------------------------------------------------------

const selection = signal<{ block: number; key: string; merging: boolean }>({ block: -1, key: '', merging: false });

function sectionShapes(lines: LaidOutLine[]) {
  const by = new Map<number, LaidOutLine[]>();
  for (const l of lines) by.set(l.block, [...(by.get(l.block) ?? []), l]);
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([block, ls]) => {
    const xs = ls.flatMap((l) => l.quad.map((p) => p.x)), ys = ls.flatMap((l) => l.quad.map((p) => p.y));
    const vertical = ls.filter((l) => l.vertical).length * 2 >= ls.length;
    return { block, lines: ls, x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys), vertical };
  });
}

// --- User-drawn section boxes ------------------------------------------------------------------

type AreaGeom = Omit<Area, 'id'>;
type AreaDrag = { kind: 'corner' | 'edge' | 'rotate' | 'move'; sx: number; sy: number; start: AreaGeom; p0: Point };

const rotate = (x: number, y: number, a: number) => ({ x: x * Math.cos(a) - y * Math.sin(a), y: x * Math.sin(a) + y * Math.cos(a) });

/** New geometry for a box while one of its handles is dragged to image point p. */
function dragArea(d: AreaDrag, p: Point): AreaGeom {
  const g = d.start;
  if (d.kind === 'move') return { ...g, cx: g.cx + p.x - d.p0.x, cy: g.cy + p.y - d.p0.y };
  if (d.kind === 'rotate') return { ...g, angle: Math.atan2(p.y - g.cy, p.x - g.cx) + Math.PI / 2 };
  // Stretch in the box's own (rotated) frame, keeping the opposite side fixed.
  const lp = rotate(p.x - g.cx, p.y - g.cy, -g.angle);
  let { w, h } = g;
  let ox = 0, oy = 0; // centre offset in the box frame
  const MIN = 12;
  if (d.sx) { const opp = -d.sx * g.w / 2; w = Math.max(MIN, Math.abs(lp.x - opp)); ox = opp + (d.sx * w) / 2; }
  if (d.sy) { const opp = -d.sy * g.h / 2; h = Math.max(MIN, Math.abs(lp.y - opp)); oy = opp + (d.sy * h) / 2; }
  const c = rotate(ox, oy, g.angle);
  return { ...g, w, h, cx: g.cx + c.x, cy: g.cy + c.y };
}

function AreaLayer({ svgRef, W, selected, drawing, flash, onSelect }: {
  svgRef: { current: SVGSVGElement | null };
  W: number;
  selected: string | null;
  /** A new box is being drawn: existing boxes must not catch the drag. */
  drawing: boolean;
  flash: string | null;
  onSelect: (id: string | null) => void;
}) {
  const s = scan.value!;
  const [live, setLive] = useState<{ id: string; geom: AreaGeom } | null>(null);
  const drag = useRef<AreaDrag | null>(null);
  // Handles are sized in screen pixels so they stay grabbable at any zoom.
  const scale = (svgRef.current?.getBoundingClientRect().width ?? W) / W;
  const px = (n: number) => n / Math.max(scale, 1e-3);
  const toImage = (e: PointerEvent): Point => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * (r.height / r.width) * W };
  };
  const start = (a: AreaGeom & { id: string }, kind: AreaDrag['kind'], sx = 0, sy = 0) => (e: PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    drag.current = { kind, sx, sy, start: { cx: a.cx, cy: a.cy, w: a.w, h: a.h, angle: a.angle }, p0: toImage(e) };
    setLive({ id: a.id, geom: drag.current.start });
  };
  const move = (e: PointerEvent) => {
    if (!drag.current || !live) return;
    setLive({ id: live.id, geom: dragArea(drag.current, toImage(e)) });
  };
  const end = () => {
    if (drag.current && live) updateArea(live.id, live.geom);
    drag.current = null;
    setLive(null);
  };
  const handlers = { onPointerMove: move, onPointerUp: end, onPointerCancel: () => { drag.current = null; setLive(null); } };
  return (
    <g class={`areas${drawing ? ' drawing' : ''}`}>
      {/* The selected box is drawn last, so nothing else can sit on top of its handles. */}
      {[...s.areas.filter((x) => x.id !== selected), ...s.areas.filter((x) => x.id === selected)].map((info) => {
        const a = live?.id === info.id ? { ...info, ...live.geom } : info;
        const pts = areaCorners({ ...a, id: a.id });
        const color = SECTION_COLORS[Math.max(0, info.section) % SECTION_COLORS.length];
        const sel = selected === info.id;
        const top = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
        const up = rotate(0, -px(34), a.angle);
        const knob = { x: top.x + up.x, y: top.y + up.y };
        const hs = px(sel ? 11 : 0);
        const handles: [AreaDrag['kind'], number, number, Point][] = [
          ['corner', -1, -1, pts[0]], ['corner', 1, -1, pts[1]], ['corner', 1, 1, pts[2]], ['corner', -1, 1, pts[3]],
          ['edge', 0, -1, top], ['edge', 1, 0, { x: (pts[1].x + pts[2].x) / 2, y: (pts[1].y + pts[2].y) / 2 }],
          ['edge', 0, 1, { x: (pts[2].x + pts[3].x) / 2, y: (pts[2].y + pts[3].y) / 2 }], ['edge', -1, 0, { x: (pts[3].x + pts[0].x) / 2, y: (pts[3].y + pts[0].y) / 2 }],
        ];
        return (
          <g key={info.id} data-area={info.id}>
            <polygon class={`box-halo${sel ? ' selected' : ''}`} points={pts.map((p) => `${p.x},${p.y}`).join(' ')} />
            <polygon class={`area-box${sel ? ' selected' : ''}${flash === info.id ? ' flash' : ''}${info.count ? '' : ' empty'}`} points={pts.map((p) => `${p.x},${p.y}`).join(' ')} style={{ stroke: color, fill: color }} />
            <g class="area-badge" onClick={(e) => { e.stopPropagation(); onSelect(sel ? null : info.id); }} data-testid="area-badge">
              <circle cx={pts[0].x} cy={pts[0].y} r={px(13)} style={{ fill: color }} />
              <text x={pts[0].x} y={pts[0].y} font-size={px(14)} text-anchor="middle" dominant-baseline="central">{info.section >= 0 ? info.section + 1 : '·'}</text>
            </g>
            {sel && (
              <>
                <line class="area-knob-line" x1={top.x} y1={top.y} x2={knob.x} y2={knob.y} style={{ stroke: color }} />
                <circle class="area-handle rotate" cx={knob.x} cy={knob.y} r={px(12)} style={{ stroke: color }} />
                <circle class="area-handle move" cx={a.cx} cy={a.cy} r={px(14)} style={{ stroke: color }} />
                <text class="area-glyph" x={knob.x} y={knob.y} font-size={px(15)} text-anchor="middle" dominant-baseline="central">⟲</text>
                <text class="area-glyph" x={a.cx} y={a.cy} font-size={px(16)} text-anchor="middle" dominant-baseline="central">✥</text>
                {handles.map(([kind, sx, sy, p]) => (
                  <rect key={`${kind}${sx}${sy}`} class="area-handle" x={p.x - hs} y={p.y - hs} width={hs * 2} height={hs * 2} rx={px(3)} style={{ stroke: color }} />
                ))}
                {/* Larger invisible touch targets on top of the visible handles */}
                <circle class="area-hit" cx={knob.x} cy={knob.y} r={px(24)} onPointerDown={start(a, 'rotate')} {...handlers} data-handle="rotate" />
                <circle class="area-hit" cx={a.cx} cy={a.cy} r={px(24)} onPointerDown={start(a, 'move')} {...handlers} data-handle="move" />
                {handles.map(([kind, sx, sy, p]) => (
                  <circle key={`hit${kind}${sx}${sy}`} class="area-hit" cx={p.x} cy={p.y} r={px(22)} onPointerDown={start(a, kind, sx, sy)} {...handlers} data-handle={`${kind}${sx}${sy}`} />
                ))}
              </>
            )}
          </g>
        );
      })}
    </g>
  );
}

/** Text of one section (its lines joined), as read so far. */
function sectionText(s: NonNullable<typeof scan.value>, section: number): string {
  if (section < 0) return '';
  const parts: string[] = [];
  let prev = -1;
  s.text.forEach((c, i) => {
    const li = s.lineOf[i];
    if (li < 0 || (s.lines[li] as LaidOutLine).block !== section) return;
    if (prev >= 0 && li !== prev) parts.push(' ');
    parts.push(c);
    prev = li;
  });
  return parts.join('');
}

function AreaBar({ id, onDone }: { id: string; onDone: () => void }) {
  const s = scan.value!;
  const info = s.areas.find((a) => a.id === id);
  if (!info) return null;
  const text = sectionText(s, info.section);
  return (
    <div class="section-bar" data-testid="area-bar">
      <span class="small area-summary">
        <b>{info.section >= 0 ? `§${info.section + 1}` : '∅'}</b> · {info.count} line{info.count === 1 ? '' : 's'}
        {text && <span class="area-text" lang="ja" data-testid="area-text">{text}</span>}
      </span>
      <div class="row">
        <button class="button small" onClick={() => rereadArea(id)} title="Re-read" data-testid="area-reread">↻</button>
        <button class="button small danger" onClick={() => { deleteArea(id); onDone(); }} title="Remove" data-testid="area-delete">🗑</button>
        <button class="button small primary" onClick={onDone}>Done</button>
      </div>
    </div>
  );
}

function SectionOverlay({ unit }: { unit: number }) {
  const s = scan.value!;
  const sel = selection.value;
  const shapes = sectionShapes(s.lines as LaidOutLine[]);
  const pick = (block: number, key: string) => {
    if (sel.merging && sel.block >= 0 && block !== sel.block) {
      mergeSections(sel.block, block);
      selection.value = { block: Math.min(sel.block, block), key: '', merging: false };
    } else selection.value = { block, key, merging: false };
  };
  const pad = unit * 0.6;
  return (
    <g class="sections">
      {shapes.map((sh) => {
        const color = SECTION_COLORS[sh.block % SECTION_COLORS.length];
        const selected = sh.block === sel.block;
        const bx = sh.vertical ? sh.x1 + pad : sh.x0 - pad, by = sh.y0 - pad;
        return (
          <g key={sh.block} data-section={sh.block}>
            <rect x={sh.x0 - pad} y={sh.y0 - pad} width={sh.x1 - sh.x0 + 2 * pad} height={sh.y1 - sh.y0 + 2 * pad} rx={unit * 0.6}
              class={`box-halo${selected ? ' selected' : ''}`} />
            <rect x={sh.x0 - pad} y={sh.y0 - pad} width={sh.x1 - sh.x0 + 2 * pad} height={sh.y1 - sh.y0 + 2 * pad} rx={unit * 0.6}
              class={`section-box${selected ? ' selected' : ''}`} style={{ stroke: color, fill: color }} />
            {sh.lines.map((l) => (
              <polygon key={l.key} class="section-line" points={l.quad.map((p) => `${p.x},${p.y}`).join(' ')}
                data-section-line={l.key} onClick={(e) => { e.stopPropagation(); pick(sh.block, l.key!); }} />
            ))}
            <circle cx={bx} cy={by} r={unit * 1.7} style={{ fill: color }} class="section-badge" />
            <text x={bx} y={by} font-size={unit * 1.9} class="section-num" text-anchor="middle" dominant-baseline="central">{sh.block + 1}</text>
          </g>
        );
      })}
    </g>
  );
}

function SectionBar({ onDone }: { onDone: () => void }) {
  const s = scan.value!;
  const sel = selection.value;
  const count = new Set((s.lines as LaidOutLine[]).map((l) => l.block)).size;
  const valid = sel.block >= 0 && sel.block < count;
  const set = (v: Partial<typeof sel>) => (selection.value = { ...sel, ...v });
  return (
    <div class="section-bar" data-testid="section-bar">
      {!valid ? (
        <span class="small muted">Tap a section</span>
      ) : sel.merging ? (
        <span class="small">Merge §{sel.block + 1} with… <button class="button small" onClick={() => set({ merging: false })}>Cancel</button></span>
      ) : (
        <div class="row wrap">
          <b class="small">§{sel.block + 1}</b>
          <button class="button small" disabled={sel.block === 0} onClick={() => { moveSection(sel.block, -1); set({ block: sel.block - 1 }); }} title="Read earlier" data-testid="sec-earlier">◀</button>
          <button class="button small" disabled={sel.block >= count - 1} onClick={() => { moveSection(sel.block, 1); set({ block: sel.block + 1 }); }} title="Read later" data-testid="sec-later">▶</button>
          <button class="button small" onClick={() => set({ merging: true })} title="Merge" data-testid="sec-merge">⊕</button>
          <button class="button small" onClick={() => rereadSection(sel.block)} title="Re-read" data-testid="sec-reread">↻</button>
          <button class="button small" onClick={() => redirectSection(sel.block, 'vertical')} title="Vertical" data-testid="sec-vertical">縦</button>
          <button class="button small" onClick={() => redirectSection(sel.block, 'horizontal')} title="Horizontal" data-testid="sec-horizontal">横</button>
          <button class="button small danger" onClick={() => { deleteSection(sel.block); set({ block: -1, key: '' }); }} title="Remove" data-testid="sec-delete">🗑</button>
        </div>
      )}
      <div class="row">
        {s.sectionsEdited && <button class="button small" onClick={() => { resetSections(); set({ block: -1, key: '' }); }} data-testid="sec-reset">Reset</button>}
        <button class="button small primary" onClick={() => { set({ block: -1, key: '', merging: false }); onDone(); }}>Done</button>
      </div>
    </div>
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
  const readerRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!highlight) return;
    const id = requestAnimationFrame(() => {
      const el = readerRef.current?.querySelector(`[data-i="${highlight.start}"]`);
      if (el && readerRef.current) keepVisible(readerRef.current, el);
    });
    return () => cancelAnimationFrame(id);
  }, [highlight?.start]);

  const saveEdit = () => {
    setEditedText(draft);
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
        {onShowImage && <button class="button small" onClick={onShowImage} title="Photo" data-testid="show-image">🖼</button>}
        <button class="button small" onClick={() => updateSettings((st) => (st.display.vertical = !st.display.vertical))} title="Direction">
          {d.vertical ? '横' : '縦'}
        </button>
        <button class="button small" onClick={() => { setDraft(s.text.join('')); setEditing(!editing); }} title="Edit">✎</button>
        <button class="button small" onClick={copy} disabled={empty} title="Copy">⧉</button>
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
        <div ref={readerRef} class={`reader ${d.vertical ? 'vertical' : ''}`} lang="ja" style={{ fontSize: `${d.fontSize}px` }} onClick={onClick} data-testid="reader">
          {empty && !s.busy && <p class="muted small placeholder">{s.error ? s.error : 'No text'}</p>}
          {empty && s.busy && <p class="muted small placeholder">Reading…</p>}
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
