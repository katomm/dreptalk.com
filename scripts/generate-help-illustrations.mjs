// Derives every shipped rendition of a help-guide illustration from its master
// in assets/help-illustrations/<slug>.webp. The masters are 640px and are NOT
// served: they exist so each rendition can be re-derived at full quality, rather
// than re-encoded from an already downscaled copy.
//
// Re-run after adding or changing a guide illustration, and commit the output:
//   npm run assets:help
//
// The renditions, and why each is the size it is:
//   public/help/<slug>.webp        360px  guide header, 180 CSS px at 2x DPI
//   public/help/cards/<slug>.webp  192px  help index cards, 96 CSS px at 2x DPI
//   public/help/og/<slug>.png      480px  Open Graph card, drawn at 272px there
//
// The index loads all 29 at once, which is why it gets its own smaller set
// instead of reusing the header rendition. The OG copy is a PNG because resvg
// (the workers-og rasterizer) cannot decode webp.
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = fileURLToPath(new URL('..', import.meta.url));
const srcDir = path.join(root, 'assets/help-illustrations');
const helpDir = path.join(root, 'public/help');

// High enough that re-encoding line art does not ring around the strokes, while
// still well under what the 640px master costs.
const WEBP_QUALITY = 88;

// PNG palette settings for the OG copies. These illustrations are flat violet
// line art, so 128 colours hold every tone they actually use and dithering only
// adds noise the encoder then has to store: the output is a third to a half the
// size of the 256-colour default and indistinguishable at the 272px the card
// draws them. Pinned explicitly so the script reproduces the same bytes rather
// than following whatever the encoder's defaults happen to be.
const PNG_PALETTE = { compressionLevel: 9, palette: true, colours: 128, dither: 0 };

const renditions = [
  { dir: helpDir, size: 360, ext: 'webp' },
  { dir: path.join(helpDir, 'cards'), size: 192, ext: 'webp' },
  { dir: path.join(helpDir, 'og'), size: 480, ext: 'png' },
];

const masters = (await readdir(srcDir)).filter((f) => f.endsWith('.webp')).sort();
if (masters.length === 0) throw new Error(`No illustration masters found in ${srcDir}`);

for (const { dir } of renditions) await mkdir(dir, { recursive: true });

for (const file of masters) {
  const slug = file.replace(/\.webp$/, '');
  for (const { dir, size, ext } of renditions) {
    // fit: 'contain' on a transparent ground, so a master that is not square
    // is letterboxed rather than cropped. All of them are square today.
    const pipeline = sharp(path.join(srcDir, file)).resize(size, size, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    });
    const out =
      ext === 'png'
        ? await pipeline.png(PNG_PALETTE).toBuffer()
        : await pipeline.webp({ quality: WEBP_QUALITY }).toBuffer();
    await writeFile(path.join(dir, `${slug}.${ext}`), out);
  }
}

console.log(
  `Generated ${masters.length * renditions.length} help illustration renditions ` +
    `(${renditions.map((r) => `${r.size}px ${r.ext}`).join(', ')}) from ${masters.length} masters.`,
);
