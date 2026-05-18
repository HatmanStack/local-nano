// Minimal ambient declaration for the vendored polyfill.
// The polyfill ships no TypeScript types; all exports are accessed via `as any`
// at the call sites in content.ts.
declare const _exports: Record<string, any>;
export = _exports;
