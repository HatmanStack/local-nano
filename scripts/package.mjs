// Build and zip a Chrome Web Store upload containing only runtime files.
// The archive has manifest.json at its root (store requirement) plus the
// built dist/ output and the icon PNGs. Source, tests, vendor, and node
// modules are excluded. Run with: npm run package
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';

const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
const outDir = 'web-store';
const outName = `local-nano-v${manifest.version}.zip`;
const outPath = `${outDir}/${outName}`;

// Always build fresh so the package can't ship stale bundles.
execFileSync('npm', ['run', 'build'], { stdio: 'inherit' });

await mkdir(outDir, { recursive: true });
await rm(outPath, { force: true });

// -r recurse, -X drop extra file attributes for a reproducible archive.
// icon-source.png is the high-res artwork the icon PNGs are generated
// from; it isn't referenced at runtime, so keep it out of the upload.
execFileSync(
  'zip',
  [
    '-r',
    '-X',
    outPath,
    'manifest.json',
    'dist',
    'icons',
    '-x',
    '*.map',
    '-x',
    '*.DS_Store',
    '-x',
    'icons/icon-source.png',
  ],
  { stdio: 'inherit' },
);

console.log(`\nPackaged ${outPath}`);
