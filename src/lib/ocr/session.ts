// Progressive OCR of one photo: detect all lines once (fast), then recognize them one at a time
// in reading order in the background. Lines the user taps (and their neighbours / furigana)
// jump the queue, so a lookup never waits for the whole page.
import { localEngine, rasterize } from './client';
import { layoutLines } from './layout';
import type { LineGeomMsg, OcrLine, OcrOptions, Point } from './types';

export type LineStatus = 'pending' | 'busy' | 'done';

export interface SessionLine {
  key: string;
  geom: LineGeomMsg;
  status: LineStatus;
  result: OcrLine | null;
}

let nextImageId = 1;
const roundTo32 = (v: number) => Math.max(32, Math.round(v / 32) * 32);

export function pointInQuad(p: Point, q: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = q.length - 1; i < q.length; j = i++) {
    const a = q[i], b = q[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

const thickness = (q: Point[]) => Math.hypot(q[3].x - q[0].x, q[3].y - q[0].y);
const length = (q: Point[]) => Math.hypot(q[1].x - q[0].x, q[1].y - q[0].y);

export class OcrSession {
  readonly imageId = nextImageId++;
  lines: SessionLine[] = [];
  detected = false;
  cancelled = false;
  error: string | null = null;
  readonly ready: Promise<void>;
  private order: number[] = [];
  private urgent: number[] = [];
  private waiters: { want: Set<number>; resolve: () => void }[] = [];
  private wake: (() => void) | null = null;

  constructor(
    private canvas: HTMLCanvasElement,
    private opts: OcrOptions & { detMaxSide: number },
    private onUpdate: (s: OcrSession) => void,
    /** Called when the page should be turned (CCW degrees); returns the turned canvas, or null to keep it. */
    private rotatePage?: (ccw: number) => Promise<HTMLCanvasElement | null>,
  ) {
    this.ready = this.detect();
    this.ready.then(() => this.loop()).catch((e) => { this.error = String(e?.message ?? e); this.onUpdate(this); });
  }

  get done(): number { return this.lines.filter((l) => l.status === 'done').length; }
  get finished(): boolean { return this.detected && this.lines.every((l) => l.status === 'done'); }

  private async findLines(): Promise<LineGeomMsg[]> {
    const { width: W, height: H } = this.canvas;
    const full = { x: 0, y: 0, w: W, h: H };
    await localEngine.setImage(this.imageId, rasterize(this.canvas, full, W, H));
    const s = Math.min(this.opts.detMaxSide / Math.max(W, H), 2);
    return localEngine.detect(this.imageId, rasterize(this.canvas, full, roundTo32(W * s), roundTo32(H * s)), this.opts);
  }

  private async detect() {
    let geoms = await this.findLines();
    if (this.cancelled) return;
    // Is the page sideways / upside down? Judge from crops around the biggest text lines.
    if (this.rotatePage && geoms.length) {
      const big = [...geoms].sort((a, b) => length(b.quad) * thickness(b.quad) - length(a.quad) * thickness(a.quad)).slice(0, 6);
      const { rotate, scores } = await localEngine.orientation(this.canvas, big.map((g) => g.quad));
      const sorted = [...scores].sort((a, b) => b - a);
      if (rotate && sorted[0] > 0.45 && sorted[0] - sorted[1] > 0.15) {
        const turned = await this.rotatePage(rotate);
        if (this.cancelled) return;
        if (turned) {
          this.canvas = turned;
          geoms = await this.findLines();
          if (this.cancelled) return;
        }
      }
    }
    this.lines = geoms.map((geom, i) => ({ key: `d${i}`, geom, status: 'pending', result: null }));
    // Background order: reading order of the detected lines (furigana-sized lines go with their text).
    const pseudo = this.lines.map((l) => ({
      key: l.key, text: '', vertical: l.geom.vertical, quad: l.geom.quad, score: l.geom.score,
      box: bbox(l.geom.quad), chars: Array.from({ length: Math.max(1, Math.round(length(l.geom.quad) / Math.max(1, thickness(l.geom.quad)))) }, () => ({ c: '', p: 1 })),
    })) as OcrLine[];
    this.order = layoutLines(pseudo).map((l) => Number(l.key!.slice(1)));
    this.detected = true;
    this.onUpdate(this);
  }

  private next(): number {
    while (this.urgent.length) {
      const i = this.urgent.shift()!;
      if (this.lines[i]?.status === 'pending') return i;
    }
    return this.order.find((i) => this.lines[i].status === 'pending') ?? -1;
  }

  private async loop() {
    while (!this.cancelled) {
      const i = this.next();
      if (i < 0) {
        // Idle until a re-read is requested (e.g. after reset)
        await new Promise<void>((r) => (this.wake = r));
        this.wake = null;
        continue;
      }
      const line = this.lines[i];
      line.status = 'busy';
      try {
        const [res] = await localEngine.rec(this.imageId, [line.geom]);
        line.result = res ? { ...res, key: line.key } : null;
      } catch (e) {
        line.result = null;
        console.warn('OCR line failed', e);
      }
      line.status = 'done';
      if (this.cancelled) return;
      this.waiters = this.waiters.filter((w) => {
        if ([...w.want].every((k) => this.lines[k].status === 'done')) { w.resolve(); return false; }
        return true;
      });
      this.onUpdate(this);
    }
  }

  /** Recognize these lines next; resolves when they are all done. */
  async prioritize(indices: number[]): Promise<void> {
    await this.ready;
    const want = new Set(indices.filter((i) => this.lines[i] && this.lines[i].status !== 'done'));
    if (!want.size) return;
    this.urgent.unshift(...want);
    this.wake?.();
    await new Promise<void>((resolve) => this.waiters.push({ want, resolve }));
  }

  /** Index of the detected line under an image point (with a little slack), or -1. */
  lineAt(p: Point): number {
    let best = -1, bestD = Infinity;
    this.lines.forEach((l, i) => {
      const q = l.geom.quad;
      if (pointInQuad(p, q)) { const c = centre(q); const d = Math.hypot(c.x - p.x, c.y - p.y) / Math.max(1, length(q)); if (d < bestD) { bestD = d; best = i; } }
    });
    if (best >= 0) return best;
    // nearest line within half a line thickness
    this.lines.forEach((l, i) => {
      const q = l.geom.quad;
      const d = distToQuad(p, q);
      if (d < thickness(q) * 0.5 && d < bestD) { bestD = d; best = i; }
    });
    return best;
  }

  /** Lines that matter for a lookup at line i: its furigana and the lines just before/after it. */
  neighbours(i: number): number[] {
    const q = this.lines[i].geom.quad;
    const t = thickness(q);
    return this.lines
      .map((l, j) => ({ j, gap: j === i ? Infinity : quadGap(q, l.geom.quad) }))
      .filter(({ gap }) => gap < t * 1.6)
      .sort((a, b) => a.gap - b.gap)
      .slice(0, 6)
      .map(({ j }) => j);
  }

  /** Stop reading these lines (e.g. an area re-read replaced them). */
  skip(keys: Set<string>) {
    for (const l of this.lines) if (keys.has(l.key) && l.status === 'pending') { l.status = 'done'; l.result = null; }
  }

  /** Read these lines again (after a reset). */
  requeue(keys: Set<string>) {
    for (const l of this.lines) if (keys.has(l.key) && l.status === 'done' && !l.result) l.status = 'pending';
    this.wake?.();
  }

  cancel() {
    this.cancelled = true;
    this.wake?.();
    for (const w of this.waiters) w.resolve();
  }
}

function bbox(q: Point[]) {
  const xs = q.map((p) => p.x), ys = q.map((p) => p.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}
const centre = (q: Point[]): Point => ({ x: (q[0].x + q[1].x + q[2].x + q[3].x) / 4, y: (q[0].y + q[1].y + q[2].y + q[3].y) / 4 });

function distToSeg(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / Math.max(1e-9, dx * dx + dy * dy)));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
function distToQuad(p: Point, q: Point[]): number {
  if (pointInQuad(p, q)) return 0;
  return Math.min(...q.map((a, i) => distToSeg(p, a, q[(i + 1) % 4])));
}
/** Smallest distance between two quads (0 when they overlap). */
function quadGap(a: Point[], b: Point[]): number {
  if (a.some((p) => pointInQuad(p, b)) || b.some((p) => pointInQuad(p, a))) return 0;
  return Math.min(...a.map((p) => distToQuad(p, b)), ...b.map((p) => distToQuad(p, a)));
}
