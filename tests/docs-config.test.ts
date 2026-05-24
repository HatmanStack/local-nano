import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// process.cwd() is the repo root when Vitest runs (set by Vitest to the project root)
const repoRoot = process.cwd();

describe('docs/configuration.md — cross-reference', () => {
  const configDoc = readFileSync(resolve(repoRoot, 'docs/configuration.md'), 'utf8');

  const envExample = JSON.parse(readFileSync(resolve(repoRoot, '.env.example.json'), 'utf8')) as {
    modelName: string;
  };

  it('default modelName in .env.example.json matches docs/configuration.md', () => {
    const expectedModel = envExample.modelName;
    expect(configDoc).toContain(`"modelName": "${expectedModel}"`);
  });
});

describe('docs/testing.md — test-file table drift guard', () => {
  const testingDoc = readFileSync(resolve(repoRoot, 'docs/testing.md'), 'utf8');

  // Actual test files on disk. setup.ts is excluded (not a *.test.ts).
  const actualTestFiles = readdirSync(resolve(repoRoot, 'tests'))
    .filter((f) => f.endsWith('.test.ts'))
    .sort();

  // The table lists each file as the full `tests/<name>.test.ts` path. Pull
  // those paths back out of the doc so we can compare both directions.
  const documentedTestFiles = Array.from(
    testingDoc.matchAll(/tests\/([\w-]+\.test\.ts)/g),
    (m) => m[1],
  );

  it.each(actualTestFiles)('docs/testing.md lists tests/%s', (file) => {
    expect(
      testingDoc.includes(`tests/${file}`),
      `docs/testing.md is missing an entry for tests/${file}; add it to the test-file table`,
    ).toBe(true);
  });

  it('docs/testing.md lists no nonexistent test file', () => {
    const stale = documentedTestFiles.filter((f) => !actualTestFiles.includes(f));
    expect(
      stale,
      `docs/testing.md references test files that no longer exist: ${stale.join(', ')}`,
    ).toEqual([]);
  });
});
