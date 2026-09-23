import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(here, '..');
export const PUBLIC_DIR = path.join(ROOT, 'public');
export const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
export const AUDIO_DIR = path.join(DATA_DIR, 'uploads', 'audio');
export const IMAGE_DIR = path.join(DATA_DIR, 'uploads', 'img');
export const PORT = Number(process.env.PORT || 3000);
export const APP_NAME = 'Aurelune';
export const SESSION_COOKIE = 'aur_session';
export const SESSION_DAYS = 30;
export const SECURE_COOKIES = process.env.NODE_ENV === 'production' && process.env.INSECURE_COOKIES !== 'true';
export const MAX_AUDIO_MB = Number(process.env.MAX_AUDIO_MB || 200);
export const MAX_IMAGE_MB = Number(process.env.MAX_IMAGE_MB || 8);
export const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@aurelune.local';
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
export const SEED_DEMO = process.env.SEED_DEMO !== 'false';

for (const d of [DATA_DIR, AUDIO_DIR, IMAGE_DIR]) fs.mkdirSync(d, { recursive: true });
