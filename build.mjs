import { cp, mkdir } from 'node:fs/promises';
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

// Copy ONNX runtime files Transformers.js would otherwise pull from jsdelivr
// (MV3 content-script CSP forbids remote dynamic imports).
async function copyOrt() {
  await mkdir('dist/ort', { recursive: true });
  const variants = ['', '.jsep', '.asyncify', '.jspi'];
  for (const v of variants) {
    for (const ext of ['.mjs', '.wasm']) {
      const f = `ort-wasm-simd-threaded${v}${ext}`;
      await cp(`node_modules/onnxruntime-web/dist/${f}`, `dist/ort/${f}`);
    }
  }
}

const common = {
  bundle: true,
  target: 'chrome120',
  outdir: 'dist',
  loader: { '.json': 'json' },
  logLevel: 'info',
};

const builds = [
  { ...common, entryPoints: ['content.ts'], format: 'iife' },
  { ...common, entryPoints: ['background.ts'], format: 'esm' },
];

await copyOrt();

if (watch) {
  for (const b of builds) {
    const ctx = await esbuild.context(b);
    await ctx.watch();
  }
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
