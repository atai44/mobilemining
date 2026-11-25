// Geometry of user-drawn (rotatable) section boxes.
import type { Point } from './ocr/types';

export interface Area { id: string; cx: number; cy: number; w: number; h: number; angle: number }

/** Is point p inside the (rotated) area? */
export function inArea(a: Area, p: Point): boolean {
  const dx = p.x - a.cx, dy = p.y - a.cy;
  const c = Math.cos(-a.angle), s = Math.sin(-a.angle);
  const x = dx * c - dy * s, y = dx * s + dy * c;
  return Math.abs(x) <= a.w / 2 && Math.abs(y) <= a.h / 2;
}

export function areaCorners(a: Area): Point[] {
  const c = Math.cos(a.angle), s = Math.sin(a.angle);
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => ({
    x: a.cx + (u * a.w / 2) * c - (v * a.h / 2) * s,
    y: a.cy + (u * a.w / 2) * s + (v * a.h / 2) * c,
  }));
}

export const quadCentre = (q: Point[]) => ({ x: (q[0].x + q[1].x + q[2].x + q[3].x) / 4, y: (q[0].y + q[1].y + q[2].y + q[3].y) / 4 });

/** Do two (rotated) boxes intersect at all? Separating-axis test on their edges. */
export function areasIntersect(a: Area, b: Area): boolean {
  const pa = areaCorners(a), pb = areaCorners(b);
  for (const poly of [pa, pb]) {
    for (let i = 0; i < 4; i++) {
      const p = poly[i], q = poly[(i + 1) % 4];
      const nx = q.y - p.y, ny = p.x - q.x; // edge normal
      const proj = (pts: Point[]) => pts.map((v) => v.x * nx + v.y * ny);
      const A = proj(pa), B = proj(pb);
      if (Math.max(...A) < Math.min(...B) || Math.max(...B) < Math.min(...A)) return false;
    }
  }
  return true;
}

/** Fraction of `a` covered by `b` (sampled). */
export function areaOverlap(a: Area, b: Area): number {
  const pts = areaCorners(a);
  let hit = 0, n = 0;
  for (let i = 0; i <= 6; i++) for (let j = 0; j <= 6; j++) {
    const u = i / 6, v = j / 6;
    const p = {
      x: pts[0].x + u * (pts[1].x - pts[0].x) + v * (pts[3].x - pts[0].x),
      y: pts[0].y + u * (pts[1].y - pts[0].y) + v * (pts[3].y - pts[0].y),
    };
    n++;
    if (inArea(b, p)) hit++;
  }
  return hit / n;
}

