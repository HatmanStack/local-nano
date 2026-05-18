# Contributing

Thanks for taking the time. This is a small experimental project — the bar for new contributors is mostly "does it still build, typecheck, and pass tests?"

## Workflow

1. Fork & branch off `main`.
2. Make your change.
3. Run the checks locally:
   ```bash
   npm run typecheck
   npm run coverage
   npm run build
   ```
4. Open a PR. CI runs the same three commands; the coverage step enforces the thresholds in `vitest.config.ts`.

## Code style

- TypeScript, ES2022, no transpilation for downlevel targets (we ship to Chrome 120+).
- Strict mode is off — feel free to lean on `any` where the prompt-api polyfill or Transformers.js types aren't pulling their weight.
- Keep the bundle small. `content.ts` is loaded into every page. The heavy modules (`@huggingface/transformers`, the polyfill) are dynamically imported via `loadHeavy()` — don't move them back to top-level imports.
- One short comment when WHY isn't obvious; otherwise let the code speak.
- Prefer small pure helpers in `src/` over inline logic in `content.ts`. Helpers are testable; content-script side effects aren't.

## What to test

Any new module under `src/` should have a matching `tests/<name>.test.ts`. Coverage gates this — if you drop below 75% lines/statements/functions the PR will fail CI.

If a change is purely cosmetic (CSS strings, copy tweaks), tests aren't expected.

## Updating the vendored polyfill

`vendor/prompt-api-polyfill/` is a slimmed copy of [Google's polyfill](https://github.com/GoogleChromeLabs/web-ai-demos/tree/main/prompt-api-polyfill). See [docs/prompt-api.md](prompt-api.md) for what we modified and the full resync procedure. The short version: keep `backends-registry.js` trimmed to just the Transformers.js backend (restoring firebase/gemini/openai would silently change the privacy story for users), keep the iframe-injection block removed, and keep `max_new_tokens` at 2048.

## Reporting bugs

Open a GitHub issue with:

- Chrome version (`chrome://version`)
- Whether you're on WebGPU or WASM (`device` in your `.env.json`)
- Model you're using (`modelName`)
- Console output from the page (content script) and from the service worker DevTools

## Releases

Bump `version` in `manifest.json` and `package.json`, run `npm run build`, zip the repo (without `node_modules/` and `dist/ort/*.wasm.map`), and upload to the Chrome Web Store dashboard. There's no automated release pipeline yet.
