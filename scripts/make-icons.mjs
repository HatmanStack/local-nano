// Rasterize icons/icon.svg into the PNG sizes Chrome requires.
// MV3 manifest icons must be raster PNGs (SVG is not supported), so the
// SVG is the source of truth and the PNGs are generated artifacts.
// Run with: node scripts/make-icons.mjs
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = new URL('../icons/', import.meta.url);
const svg = await readFile(new URL('icon.svg', root));

for (const size of [16, 32, 48, 128]) {
  const out = fileURLToPath(new URL(`icon${size}.png`, root));
  // High density so the SVG renders crisp before downscaling.
  await sharp(svg, { density: 512 }).resize(size, size).png().toFile(out);
  console.log(`wrote icons/icon${size}.png`);
}
