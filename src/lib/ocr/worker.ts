/// <reference lib="webworker" />
import * as ort from 'onnxruntime-web/wasm';
import { runOcr, type Tensor } from './pipeline';
import type { WorkerRequest, WorkerResponse } from './types';

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
  if (msg.type === 'run') {
    try {
      if (!initPromise) throw new Error('OCR engine not initialized');
      await initPromise;
      const { lines, ms } = await runOcr(msg.det, msg.src, msg.opts, runner(() => det!), runner(() => rec!), dict);
      post({ type: 'result', id: msg.id, lines, ms });
    } catch (e) {
      post({ type: 'error', id: msg.id, message: String((e as Error)?.message ?? e) });
    }
  }
};
