// Regenerate the Chrome extension icon PNGs from the source artwork.
// MV3 manifest icons must be square raster PNGs at 16/32/48/128 px;
// icons/icon-source.png is the high-res source of truth (square) and
// these are lanczos downscales of it. Requires ffmpeg on PATH.
// Run with: npm run icons
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dir = new URL('../icons/', import.meta.url);
const source = fileURLToPath(new URL('icon-source.png', dir));

for (const size of [16, 32, 48, 128]) {
  const out = fileURLToPath(new URL(`icon${size}.png`, dir));
  execFileSync(
    'ffmpeg',
    ['-y', '-loglevel', 'error', '-i', source, '-vf', `scale=${size}:${size}:flags=lanczos`, out],
    { stdio: 'inherit' },
  );
  console.log(`wrote icons/icon${size}.png`);
}
