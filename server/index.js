import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import { connectDb } from './db.js';
import { attachUser } from './auth.js';
import { ensureAdmin } from './bootstrap.js';
import { HttpError, artSvg } from './util.js';
import { PORT, PUBLIC_DIR, AUDIO_DIR, IMAGE_DIR, APP_NAME, SEED_DEMO } from './config.js';

import authRoutes from './routes/auth.js';
import catalogRoutes from './routes/catalog.js';
import libraryRoutes from './routes/library.js';
import listeningRoutes from './routes/listening.js';
import studioRoutes from './routes/studio.js';
import developerRoutes from './routes/developer.js';
import adminRoutes from './routes/admin.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(cors({ origin: true, credentials: true, exposedHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Length'] }));
app.use(cookieParser());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// Generated cover art — deterministic per id, so it never needs storage.
app.get('/art/:kind/:id.svg', (req, res) => {
  res.set('Content-Type', 'image/svg+xml').set('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(artSvg(`${req.params.kind}${req.params.id}`, req.params.kind === 'artist'));
});
app.use('/media/img', express.static(IMAGE_DIR, { maxAge: '30d', fallthrough: true }));
app.get('/media/img/*splat', (_req, res) => res.status(404).end());

const apiLimiter = rateLimit({ windowMs: 60000, limit: 300, standardHeaders: true, legacyHeaders: false, message: { error: { message: 'Too many requests — slow down a little.', code: 'rate_limited' } } });
const authLimiter = rateLimit({ windowMs: 15 * 60000, limit: 20, standardHeaders: true, legacyHeaders: false, message: { error: { message: 'Too many attempts. Try again in a few minutes.', code: 'rate_limited' } } });

const api = express.Router();
api.use(apiLimiter);
api.use(attachUser);
api.use(['/auth/login', '/auth/signup'], authLimiter);
api.use(authRoutes);
api.use(catalogRoutes);
api.use(libraryRoutes);
api.use(listeningRoutes);
api.use(studioRoutes);
api.use(developerRoutes);
api.use(adminRoutes);
api.use((req, _res, next) => next(new HttpError(404, `No such endpoint: ${req.method} ${req.path}`)));
app.use('/api/v1', api);

// Static app shell (the SPA handles its own client-side routing)
app.use(express.static(PUBLIC_DIR, { maxAge: '1h', index: false }));
app.get(/^\/(?!api\/|media\/|art\/).*/, (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

app.use((err, _req, res, _next) => {
  const status = err instanceof HttpError ? err.status : (err.status || err.statusCode || 500);
  if (status >= 500) console.error(err);
  const code = err instanceof HttpError ? err.code : (status === 413 ? 'too_large' : 'server_error');
  const message = status >= 500 ? 'Something went wrong on our end.' : (err.message || 'Request failed');
  res.status(status).json({ error: { message, code } });
});

async function start() {
  await connectDb();
  console.log(`${APP_NAME}: connected to MongoDB`);
  await ensureAdmin();
  if (SEED_DEMO) {
    const { Creator } = await import('./db.js');
    if ((await Creator.estimatedDocumentCount()) === 0) {
      console.log(`${APP_NAME}: no creators yet — seeding a demo catalog (set SEED_DEMO=false to skip)...`);
      await import('./seed.js');
    }
  }
  app.listen(PORT, () => console.log(`${APP_NAME} listening on http://localhost:${PORT}`));
}

start().catch((e) => { console.error('Failed to start:', e); process.exit(1); });
