import { useEffect, useRef, useState } from 'preact/hooks';
import { localEngine, rasterize } from '../lib/ocr/client';
import { ensureOcrEngine } from '../scanActions';

/**
 * Draw a character by hand when the right one isn't among the OCR's guesses. The drawing goes
 * through the same on-device recognizer; its best candidates are offered to pick from.
 */
export function HandwritePad({ onPick, onClose }: { onPick: (c: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [cands, setCands] = useState<{ c: string; p: number }[]>([]);
  const [busy, setBusy] = useState(false);
  const drawing = useRef(false);
  const box = useRef<[number, number, number, number] | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const SIZE = 240;

  const ctx = () => ref.current!.getContext('2d')!;
  const clear = () => {
    const c = ctx();
    c.fillStyle = '#fff';
    c.fillRect(0, 0, SIZE, SIZE);
    box.current = null;
    setCands([]);
  };
  useEffect(() => { clear(); return () => clearTimeout(timer.current); }, []);

  const at = (e: PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * SIZE, ((e.clientY - r.top) / r.height) * SIZE] as const;
  };
  const grow = (x: number, y: number) => {
    const b = box.current;
    box.current = b ? [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)] : [x, y, x, y];
  };

  const recognize = async () => {
    const b = box.current;
    if (!b) return;
    setBusy(true);
    try {
      await ensureOcrEngine();
      // A square around the strokes, with a margin (the recognizer expects a text line's proportions)
      const side = Math.max(b[2] - b[0], b[3] - b[1]) * 1.35 + 16;
      const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
      const img = rasterize(ref.current!, { x: cx - side / 2, y: cy - side / 2, w: side, h: side }, 96, 96);
      setCands(await localEngine.handwriting(img));
    } catch {
      setCands([]);
    } finally {
      setBusy(false);
    }
  };

  const down = (e: PointerEvent) => {
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    clearTimeout(timer.current);
    drawing.current = true;
    const [x, y] = at(e);
    const c = ctx();
    c.strokeStyle = '#000';
    c.lineWidth = 12;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.beginPath();
    c.moveTo(x, y);
    c.lineTo(x + 0.1, y + 0.1);
    c.stroke();
    grow(x, y);
  };
  const move = (e: PointerEvent) => {
    if (!drawing.current) return;
    const [x, y] = at(e);
    const c = ctx();
    c.lineTo(x, y);
    c.stroke();
    grow(x, y);
  };
  const up = () => {
    if (!drawing.current) return;
    drawing.current = false;
    // Read shortly after the last stroke, so multi-stroke characters aren't read half-drawn.
    clearTimeout(timer.current);
    timer.current = setTimeout(recognize, 600);
  };

  return (
    <div class="handwrite" data-testid="handwrite">
      <canvas ref={ref} width={SIZE} height={SIZE} class="handwrite-pad" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
      <div class="handwrite-side">
        <div class="handwrite-cands" lang="ja">
          {cands.map((a) => (
            <button key={a.c} class="alt" onClick={() => onPick(a.c)} title={`${Math.round(a.p * 100)}%`} data-testid="handwrite-cand">{a.c}</button>
          ))}
          {!cands.length && <span class="muted small">{busy ? '…' : 'Draw the character'}</span>}
        </div>
        <div class="row">
          <button class="button small" onClick={clear}>Clear</button>
          <button class="button small" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
