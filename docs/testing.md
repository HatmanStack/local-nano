# Testing

The suite is Vitest + jsdom, run via:

```bash
npm test          # one-shot
npm run coverage  # with v8 coverage report and threshold enforcement
```

## Scope

We deliberately stick to **unit tests**. There is no end-to-end harness — wiring up a Chrome extension under Playwright or similar would add a lot of moving parts to validate behavior that's already exercised by manual smoke tests during development.

Tests target the modules under `src/`, which hold the testable logic extracted from the `content.ts`, `background.ts`, and `offscreen.ts` entry points:

| Test file                            | Covers                                       |
| ------------------------------------ | -------------------------------------------- |
| `tests/history.test.ts`              | `storageKey`, `loadHistory`, `saveHistory`, per-element validation |
| `tests/pageContext.test.ts`          | `pageContext` (slice-before-collapse window, truncation, whitespace, format) |
| `tests/selection-rewrite.test.ts`    | Selection constants and `isSupportedSelection` |
| `tests/ui-messages.test.ts`          | `renderMessage`, `makeTypingIndicator` (XSS-safety, alignment, scroll) |
| `tests/ui-state.test.ts`             | Send/Stop button state transitions           |
| `tests/debug.test.ts`                | `debugLog` gating behind the DEBUG flag      |
| `tests/background-handler.test.ts`   | Command handler (toggle, ignore unknown, no-id) |
| `tests/background-offscreen.test.ts` | `ensureOffscreen` document lifecycle         |
| `tests/session.test.ts`              | `initSession` — lifecycle, streaming, abort, toggle, restore re-seed, quota advisory |
| `tests/stream-client.test.ts`        | `streamOverPort` port wiring and chunk accumulation |
| `tests/offscreen-client.test.ts`     | `streamPrompt` content-script client over the SW |
| `tests/offscreen-protocol.test.ts`   | Wire-message discriminators and finiteness guards |
| `tests/offscreen-dispatch.test.ts`   | `classifyOffscreenMessage` listener routing  |
| `tests/offscreen-ladder.test.ts`     | `nextAction`/`firstTierIndex`/`tierKey`/`applyTierToConfig` fallback-ladder reducer |
| `tests/capability.test.ts`           | `classifyCapability`/`CAPABLE_MIN_BUFFER_BYTES` pure device-capability classifier |
| `tests/capability-store.test.ts`     | `loadCapabilityRecord`/`recordKnownGood`/`recordKnownBad`/`clearCapabilityRecord` per-device tier persistence |
| `tests/offscreen-failure.test.ts`    | `classifyFailure`/`isTerminalFailure` terminal-vs-transient seam |
| `tests/offscreen-diagnostic.test.ts` | `buildDiagnostic`/`errorInfo` copy-only diagnostic builder |
| `tests/offscreen-busy-gate.test.ts`  | `BusyGate` concurrent-stream rejection       |
| `tests/docs-config.test.ts`          | Doc cross-references and test-file table drift |

## Coverage

Thresholds are enforced in `vitest.config.ts`:

```text
lines/statements/functions: 75%
branches:                   80%
```

If a change drops below those, `npm run coverage` (and therefore CI) fails. The `src/` suite currently sits well above the thresholds — keep it high by adding a test alongside any new module.

What is **not** measured:

- `content.ts` and `background.ts` themselves. These are thin DOM-bootstrap entries that mutate global state at import time; meaningful coverage would require an integration harness. Coverage `include` is scoped to `src/**/*.ts`.
- `vendor/` (third-party polyfill).
- `build.mjs` (build script).

## Chrome API mock

`tests/setup.ts` installs a stub `chrome` global before each test:

- `chrome.storage.local` is an in-memory `FakeStorageArea` (a `Map` behind `get`/`set`).
- `chrome.tabs.query` defaults to returning a single tab with id `1`; tests override with `mockImplementationOnce` when they need a different shape.
- `chrome.runtime` and `chrome.commands` expose `vi.fn()` spies so handler registration can be asserted without invoking the real extension runtime.

`store` is reset before each test, so tests can assume an empty `chrome.storage.local`.

## Adding a test

```ts
import { describe, expect, it } from 'vitest';
import { thingYouAdded } from '../src/thing.js';

describe('thingYouAdded', () => {
  it('does the thing', () => {
    expect(thingYouAdded(1)).toBe(2);
  });
});
```

If the new code touches chrome APIs, import the existing mock:

```ts
import { chromeMock } from './setup.js';

chromeMock.storage.local.store['key'] = 'value';
```

## Running just one file

```bash
npx vitest run tests/history.test.ts
```
