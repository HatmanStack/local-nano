import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// process.cwd() is the repo root when Vitest runs (set by Vitest to the project root)
const repoRoot = process.cwd();

const require = createRequire(import.meta.url);

/**
 * `build.mjs` copies ORT's `.wasm` binaries into `dist/ort/` while esbuild
 * bundles ORT's emscripten JS glue into `dist/offscreen.js`. Those two are
 * emitted as a matched pair by a single onnxruntime-web build — if they come
 * from different versions the wasm backend cannot initialize and the model
 * silently never loads, with the build, typecheck, and every other test still
 * green. These tests pin that invariant down.
 */
describe('onnxruntime-web — wasm/glue version match', () => {
  // Transformers.js blocks `./package.json` in its exports map, so reach the
  // package root through its resolved entry point instead.
  const transformersRoot = resolve(dirname(require.resolve('@huggingface/transformers')), '..');
  const transformersPkg = JSON.parse(
    readFileSync(resolve(transformersRoot, 'package.json'), 'utf8'),
  ) as { dependencies: Record<string, string> };

  const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as {
    devDependencies: Record<string, string>;
  };

  it('the onnxruntime-web pin matches the version Transformers.js depends on', () => {
    const ours = pkg.devDependencies['onnxruntime-web'];
    const theirs = transformersPkg.dependencies['onnxruntime-web'];
    expect(
      ours,
      `package.json pins onnxruntime-web at "${ours}" but @huggingface/transformers ` +
        `depends on "${theirs}". They must be identical so npm installs a single copy: ` +
        `build.mjs ships that copy's .wasm files and esbuild bundles its JS glue. ` +
        `Bump the pin to "${theirs}".`,
    ).toBe(theirs);
  });

  // The variant list build.mjs copies. Kept in sync by hand; a rename upstream
  // should fail here rather than at the store-review stage.
  const variants = ['', '.jsep', '.asyncify', '.jspi'];
  const artifacts = variants.flatMap((v) =>
    ['.mjs', '.wasm'].map((ext) => `ort-wasm-simd-threaded${v}${ext}`),
  );

  const requireFromTransformers = createRequire(require.resolve('@huggingface/transformers'));

  it.each(artifacts)('resolves %s from the ORT copy Transformers.js uses', (file) => {
    expect(() => requireFromTransformers.resolve(`onnxruntime-web/${file}`)).not.toThrow();
  });

  it('resolves every ORT artifact from one single package directory', () => {
    const dirs = new Set(
      artifacts.map((f) => dirname(requireFromTransformers.resolve(`onnxruntime-web/${f}`))),
    );
    expect(
      [...dirs],
      'ORT artifacts resolved from more than one directory, so dist/ort would mix builds',
    ).toHaveLength(1);
  });
});
