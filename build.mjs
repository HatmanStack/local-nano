import { cp, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

// Copy ONNX runtime files Transformers.js would otherwise pull from jsdelivr
// (MV3 content-script CSP forbids remote dynamic imports).
//
// These must come from the SAME onnxruntime-web copy that esbuild bundles the
// ORT JS glue from, i.e. the one Transformers.js resolves. The emscripten glue
// (.mjs) and its .wasm are emitted as a matched pair; mixing versions leaves the
// wasm backend unable to initialize at runtime, which reads as "the model never
// loads" with a green build and green tests. Resolving from Transformers.js's
// own entry point uses the exact resolution esbuild does, so a hoisted or
// duplicated ORT in node_modules can't silently split the pair.
const require = createRequire(import.meta.url);
const requireFromTransformers = createRequire(require.resolve('@huggingface/transformers'));

async function copyOrt() {
  await mkdir('dist/ort', { recursive: true });
  const variants = ['', '.jsep', '.asyncify', '.jspi'];
  for (const v of variants) {
    for (const ext of ['.mjs', '.wasm']) {
      const f = `ort-wasm-simd-threaded${v}${ext}`;
      let src;
      try {
        src = requireFromTransformers.resolve(`onnxruntime-web/${f}`);
      } catch (err) {
        throw new Error(
          `Could not resolve ${f} from the onnxruntime-web that @huggingface/transformers ` +
            `uses. Run npm install, and if onnxruntime-web changed upstream, re-pin the ` +
            `devDependency to match transformers' own onnxruntime-web version. Cause: ${err.message}`,
        );
      }
      await cp(src, `dist/ort/${f}`);
    }
  }
}

async function copyOffscreenHtml() {
  await mkdir('dist', { recursive: true });
  await cp('offscreen.html', 'dist/offscreen.html');
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
  { ...common, entryPoints: ['offscreen.ts'], format: 'iife' },
];

await Promise.all([copyOrt(), copyOffscreenHtml()]);

if (watch) {
  for (const b of builds) {
    const ctx = await esbuild.context(b);
    await ctx.watch();
  }
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
