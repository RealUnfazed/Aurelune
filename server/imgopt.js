// Covers and profile pictures are shown at 40–330 px (500 px in the full player), but people upload camera- and design-sized
// files (3000–6000 px, several MB). Every one of those bytes is downloaded by every listener and painted top-down, which is
// the "picture loads 10%… 20%…" effect. So an uploaded picture is downscaled once, here, before it is stored.
//
// Uses `sharp` when it is installed (it is an optionalDependency); without it, or on any error, the original is stored untouched:
// an upload must never fail because of this step.
import fs from 'node:fs';
import path from 'node:path';

export const MAX_SIDE = Number(process.env.IMAGE_MAX_SIDE || 1200); // 1200 px is sharp on a 500 px full-player cover at 2x
const KEEP_BELOW_BYTES = 250 * 1024; // already small and no bigger than MAX_SIDE: leave it alone

let sharpP;
const loadSharp = () => (sharpP ??= import('sharp').then((m) => m.default || m).catch(() => null));

/**
 * Downscales the staged file `full` (an absolute path). Returns { file, mime } — the file to store (same path, or the same
 * name with a new extension when the format changed) — or null when nothing was changed.
 */
export async function optimizeImage(full) {
  try {
    const sharp = await loadSharp();
    if (!sharp) return null;
    const ext = path.extname(full).toLowerCase();
    if (ext === '.gif' || ext === '.svg') return null; // animation / vector: never touch
    const before = (await fs.promises.stat(full)).size;
    const img = sharp(full, { failOn: 'none' }); // a slightly damaged file should still be usable
    const meta = await img.metadata();
    if (!meta.width || !meta.height || (meta.pages || 1) > 1) return null;
    if (Math.max(meta.width, meta.height) <= MAX_SIDE && before <= KEEP_BELOW_BYTES) return null;

    const pipe = img.rotate().resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true });
    const alpha = !!meta.hasAlpha;
    const out = alpha ? await pipe.png({ compressionLevel: 9, palette: true }).toBuffer() : await pipe.jpeg({ quality: 82, mozjpeg: true, progressive: true }).toBuffer();
    if (out.length >= before && Math.max(meta.width, meta.height) <= MAX_SIDE) return null; // no gain
    const newExt = alpha ? '.png' : '.jpg';
    const target = ext === newExt ? full : full.slice(0, full.length - ext.length) + newExt;
    await fs.promises.writeFile(target, out);
    if (target !== full) await fs.promises.unlink(full).catch(() => {});
    return { file: target, mime: alpha ? 'image/png' : 'image/jpeg', before, after: out.length };
  } catch {
    return null;
  }
}
