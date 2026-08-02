// Converts each help-guide illustration (public/help/<slug>.webp) into a
// rasterizer-safe PNG (public/help/og/<slug>.png) for embedding in the guide's
// Open Graph card. resvg (the workers-og rasterizer) cannot decode webp, so the
// /og/help/[slug] endpoint loads this PNG copy instead of the source webp.
//
// Re-run after adding or changing a guide illustration:
//   node scripts/generate-help-og-images.mjs
import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = fileURLToPath(new URL('..', import.meta.url));
const srcDir = path.join(root, 'public/help');
const outDir = path.join(root, 'public/help/og');

// The illustration is drawn at 272px in the 1200x630 card; 480px source keeps it
// crisp after the rasterizer's downscale. A palette PNG (line art has few colours)
// stays small, which matters since these are committed and edge-served.
const SIZE = 480;

await mkdir(outDir, { recursive: true });
const webps = (await readdir(srcDir)).filter((f) => f.endsWith('.webp'));

let count = 0;
for (const file of webps) {
  const slug = file.replace(/\.webp$/, '');
  await sharp(path.join(srcDir, file))
    .resize(SIZE, SIZE, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9, palette: true })
    .toFile(path.join(outDir, `${slug}.png`));
  count++;
}

console.log(`Generated ${count} help OG illustration PNGs in public/help/og/`);
