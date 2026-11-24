#!/usr/bin/env node
// Downloads the PaddleOCR PP-OCRv6 (small) detection + recognition ONNX models from Hugging Face
// into public/models/ and extracts the recognizer's character set.
import { mkdir, stat, writeFile, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const modelsDir = join(root, 'public', 'models');
const cacheDir = join(root, '.cache');

const HF = 'https://huggingface.co/PaddlePaddle';
const MODELS = [
  { repo: 'PP-OCRv6_small_det_onnx', out: 'det.onnx' },
  { repo: 'PP-OCRv6_small_rec_onnx', out: 'rec.onnx', yml: true },
];

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

async function fetchTo(url, dest) {
  if (await exists(dest)) return;
  await writeFile(dest, await fetchRetry(url));
}

await mkdir(modelsDir, { recursive: true });
await mkdir(cacheDir, { recursive: true });

for (const m of MODELS) {
  await fetchTo(`${HF}/${m.repo}/resolve/main/inference.onnx`, join(modelsDir, m.out));
  if (m.yml) {
    const ymlPath = join(cacheDir, `${m.repo}.yml`);
    await fetchTo(`${HF}/${m.repo}/resolve/main/inference.yml`, ymlPath);
    const cfg = parse(await readFile(ymlPath, 'utf8'));
    const dict = cfg.PostProcess.character_dict.map(String);
    // CTC: index 0 is the blank token; the recognizer also appends a trailing space class.
    await writeFile(join(modelsDir, 'rec_dict.json'), JSON.stringify(['', ...dict, ' ']));
    console.log(`Recognizer character set: ${dict.length} symbols`);
  }
}

console.log('Models ready.');

/** fetch with retries and exponential backoff (CI networks occasionally time out). */
async function fetchRetry(url, attempts = 5) {
  for (let i = 1; ; i++) {
    try {
      console.log(`Downloading ${url}${i > 1 ? ` (attempt ${i})` : ''}`);
      const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      if (i >= attempts) throw e;
      const wait = 2000 * 2 ** (i - 1);
      console.warn(`  failed (${e.cause?.code ?? e.message}); retrying in ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}
