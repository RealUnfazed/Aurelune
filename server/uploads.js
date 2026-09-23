import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { parseFile } from 'music-metadata';
import { AUDIO_DIR, IMAGE_DIR, MAX_AUDIO_MB, MAX_IMAGE_MB } from './config.js';
import { HttpError } from './util.js';

const AUDIO = {
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.oga': 'audio/ogg',
  '.opus': 'audio/ogg', '.flac': 'audio/flac', '.wav': 'audio/wav', '.weba': 'audio/webm',
};
const IMAGES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };

const rand = () => crypto.randomBytes(12).toString('hex');

const storage = multer.diskStorage({
  destination: (_req, file, cb) => cb(null, file.fieldname === 'audio' ? AUDIO_DIR : IMAGE_DIR),
  filename: (_req, file, cb) => cb(null, rand() + path.extname(file.originalname).toLowerCase()),
});

export const upload = multer({
  storage,
  limits: { fileSize: MAX_AUDIO_MB * 1024 * 1024, files: 2, fields: 30 },
  fileFilter(_req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    if (file.fieldname === 'audio') return AUDIO[ext] ? cb(null, true) : cb(new HttpError(415, `Unsupported audio type ${ext || '(none)'}. Use MP3, M4A, AAC, OGG, OPUS, FLAC or WAV.`, 'bad_audio'));
    if (file.fieldname === 'cover' || file.fieldname === 'image') return IMAGES[ext] ? cb(null, true) : cb(new HttpError(415, 'Images must be JPG, PNG, WEBP or GIF', 'bad_image'));
    cb(new HttpError(400, `Unexpected file field "${file.fieldname}"`));
  },
});

export const mimeFor = (file) => AUDIO[path.extname(file).toLowerCase()] || 'application/octet-stream';

export const removeFile = (dir, name) => { if (name) fs.promises.unlink(path.join(dir, path.basename(name))).catch(() => {}); };
export const removeAudio = (name) => removeFile(AUDIO_DIR, name);
export const removeImage = (name) => removeFile(IMAGE_DIR, name);

export function cleanupUploads(req) {
  for (const list of Object.values(req.files || {})) for (const f of list) removeFile(f.fieldname === 'audio' ? AUDIO_DIR : IMAGE_DIR, f.filename);
}

/** Reads duration + tags (title, genre, lyrics, embedded cover) from an uploaded audio file. */
export async function inspectAudio(filename) {
  const full = path.join(AUDIO_DIR, filename);
  let meta;
  try { meta = await parseFile(full, { duration: true }); }
  catch { throw new HttpError(422, 'That file could not be read as audio. Is it corrupted?', 'bad_audio'); }
  const c = meta.common || {};
  let lyrics = '';
  const l = c.lyrics?.[0];
  if (typeof l === 'string') lyrics = l;
  else if (l?.text) lyrics = l.text;
  let cover = null;
  const pic = c.picture?.[0];
  if (pic?.data?.length) {
    const ext = /png/i.test(pic.format) ? '.png' : /webp/i.test(pic.format) ? '.webp' : '.jpg';
    cover = rand() + ext;
    await fs.promises.writeFile(path.join(IMAGE_DIR, cover), pic.data);
  }
  return {
    durationMs: Math.round((meta.format.duration || 0) * 1000),
    title: c.title || '', genre: c.genre?.[0] || '', trackNo: c.track?.no || 0,
    lyrics, cover,
  };
}
