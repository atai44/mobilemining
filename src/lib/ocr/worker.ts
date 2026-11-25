/// <reference lib="webworker" />
import * as ort from 'onnxruntime-web/wasm';
import { detectLines, recognizeLine, runOcr, type Tensor } from './pipeline';
import type { RGBAImage, WorkerRequest, WorkerResponse } from './types';

declare const self: DedicatedWorkerGlobalScope;

let det: ort.InferenceSession | null = null;
let rec: ort.InferenceSession | null = null;
let dict: string[] = [];
let initPromise: Promise<void> | null = null;

const post = (msg: WorkerResponse, transfer: Transferable[] = []) => self.postMessage(msg, transfer);

async function fetchWithProgress(url: string, label: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Failed to download ${label} (HTTP ${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    post({ type: 'progress', file: label, loaded, total });
  }
  const out = new Uint8Array(loaded);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

async function init(base: string) {
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
  ort.env.wasm.proxy = false;
  const [detBuf, recBuf, dictJson] = await Promise.all([
    fetchWithProgress(base + 'models/det.onnx', 'detector'),
    fetchWithProgress(base + 'models/rec.onnx', 'recognizer'),
    fetch(base + 'models/rec_dict.json').then((r) => r.json() as Promise<string[]>),
  ]);
  const opts: ort.InferenceSession.SessionOptions = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
  det = await ort.InferenceSession.create(detBuf, opts);
  rec = await ort.InferenceSession.create(recBuf, opts);
  dict = dictJson;
}

function runner(session: () => ort.InferenceSession) {
  return async (input: Tensor): Promise<Tensor> => {
    const s = session();
    const feeds = { [s.inputNames[0]]: new ort.Tensor('float32', input.data, input.dims) };
    const out = await s.run(feeds);
    const t = out[s.outputNames[0]];
    return { data: t.data as Float32Array, dims: t.dims as number[] };
  };
}

// Model runs are serialized: ONNX Runtime sessions can't run concurrently, and serial order lets
// the main thread re-prioritize between lines.
let chain: Promise<unknown> = Promise.resolve();
const serial = <T>(fn: () => Promise<T>): Promise<T> => {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
};
const images = new Map<number, RGBAImage>();

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  if (msg.type === 'init') {
    initPromise ??= init(msg.base);
    try {
      await initPromise;
      post({ type: 'ready', backend: `wasm${ort.env.wasm.numThreads && ort.env.wasm.numThreads > 1 ? ` ×${ort.env.wasm.numThreads}` : ''}` });
    } catch (e) {
      initPromise = null;
      post({ type: 'error', message: String((e as Error)?.message ?? e) });
    }
    return;
  }
  try {
    if (msg.type === 'image') {
      images.clear(); // one photo at a time
      images.set(msg.imageId, msg.src);
      post({ type: 'ok', id: msg.id });
      return;
    }
    if (!initPromise) throw new Error('OCR engine not initialized');
    await initPromise;
    if (msg.type === 'run') {
      const { lines, ms } = await serial(() => runOcr(msg.det, msg.src, msg.opts, runner(() => det!), runner(() => rec!), dict));
      post({ type: 'result', id: msg.id, lines, ms });
    } else if (msg.type === 'detect') {
      const src = images.get(msg.imageId);
      if (!src) throw new Error('Image is no longer loaded');
      const geoms = await serial(() => detectLines(msg.det, src.width, src.height, msg.opts, runner(() => det!)));
      post({ type: 'detected', id: msg.id, geoms: geoms.map((g) => ({ quad: g.quad, vertical: g.vertical, score: g.score })) });
    } else if (msg.type === 'rec') {
      const src = images.get(msg.imageId);
      if (!src) throw new Error('Image is no longer loaded');
      const lines = await serial(async () => {
        const out = [];
        for (const g of msg.geoms) out.push(await recognizeLine(src, g, runner(() => rec!), dict));
        return out;
      });
      post({ type: 'recognized', id: msg.id, lines });
    }
  } catch (e) {
    post({ type: 'error', id: msg.id, message: String((e as Error)?.message ?? e) });
  }
};
