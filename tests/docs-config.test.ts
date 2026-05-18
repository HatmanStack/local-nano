import { readFileSync } from 'node:fs';
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
