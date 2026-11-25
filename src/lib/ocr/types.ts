export interface RGBAImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface OcrChar {
  c: string;
  p: number; // confidence 0..1
  alts?: { c: string; p: number }[]; // other likely characters for this position
  /** Position of the character's centre along its line, 0 (start) .. 1 (end). */
  u?: number;
}

/** Furigana attached to characters [from, to) of a line. */
export interface Ruby { from: number; to: number; text: string }

export interface Point { x: number; y: number }

export interface OcrLine {
  text: string;
  chars: OcrChar[];
  vertical: boolean;
  /** Quadrilateral in source-image pixels: [start-top, end-top, end-bottom, start-bottom] in reading frame. */
  quad: [Point, Point, Point, Point];
  /** Axis-aligned bounding box in source-image pixels. */
  box: { x: number; y: number; w: number; h: number };
  score: number;
  ruby?: Ruby[];
}

export type Orientation = 'auto' | 'horizontal' | 'vertical';

export interface OcrOptions {
  orientation: Orientation;
  boxThresh: number;
  unclipRatio: number;
}

export type WorkerRequest =
  | { type: 'init'; base: string }
  | { type: 'run'; id: number; det: RGBAImage; src: RGBAImage; opts: OcrOptions };

export type WorkerResponse =
  | { type: 'progress'; file: string; loaded: number; total: number }
  | { type: 'ready'; backend: string }
  | { type: 'error'; id?: number; message: string }
  | { type: 'result'; id: number; lines: OcrLine[]; ms: { det: number; rec: number } };
