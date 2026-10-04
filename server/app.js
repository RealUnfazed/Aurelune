// The Express app itself, with no assumption about how it's run: `server/index.js`
// (local/traditional) and `api/index.js` (Vercel) both import this unchanged.
//
// There's no "startup phase" on serverless — every cold start is its own process,
// so instead of connecting once before listen(), `ready()` runs lazily on first
// request and is cached (a module-level promise survives across invocations on
// the same warm instance, the same trick db.js uses for the Mongo connection).
import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import { connectDb } from './db.js';
import { attachUser } from './auth.js';
import { privacyContext } from './privacy.js';
import { ensureAdmin } from './bootstrap.js';
import { HttpError, artSvg } from './util.js';
import { PUBLIC_DIR, IMAGE_DIR } from './config.js';

import authRoutes from './routes/auth.js';
import embedRoutes from './embed.js';
import catalogRoutes from './routes/catalog.js';
import libraryRoutes from './routes/library.js';
import listeningRoutes from './routes/listening.js';
import studioRoutes from './routes/studio.js';
import developerRoutes from './routes/developer.js';
import adminRoutes from './routes/admin.js';

export const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

let readyPromise = null;
/** Connects to MongoDB and makes sure an admin account exists. Safe to call on every request. */
export function ready() {
  if (!readyPromise) {
    readyPromise = (async () => {
      await connectDb();
      await ensureAdmin();
    })().catch((err) => { readyPromise = null; throw err; }); // let the next request retry after a cold failure
  }
  return readyPromise;
}
app.use((req, res, next) => { ready().then(() => next(), next); });

app.use(cors({ origin: true, credentials: true, exposedHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Length'] }));
app.use(cookieParser());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// Generated cover art — deterministic per id, so it never needs storage.
app.get('/art/:kind/:id.svg', (req, res) => {
  res.set('Content-Type', 'image/svg+xml').set('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(artSvg(`${req.params.kind}${req.params.id}`, req.params.kind === 'artist'));
});
// Local cover images only — PostFile-hosted ones are absolute URLs the client uses directly.
app.use('/media/img', express.static(IMAGE_DIR, { maxAge: '30d', fallthrough: true }));
app.get('/media/img/*splat', (_req, res) => res.status(404).end());

const apiLimiter = rateLimit({ windowMs: 60000, limit: 300, standardHeaders: true, legacyHeaders: false, message: { error: { message: 'Too many requests — slow down a little.', code: 'rate_limited' } } });
const authLimiter = rateLimit({ windowMs: 15 * 60000, limit: 20, standardHeaders: true, legacyHeaders: false, message: { error: { message: 'Too many attempts. Try again in a few minutes.', code: 'rate_limited' } } });

const api = express.Router();
api.use(apiLimiter);
api.use(attachUser);
api.use(privacyContext);
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
app.use(embedRoutes);

// Static app shell (the SPA handles its own client-side routing)
app.use(express.static(PUBLIC_DIR, { maxAge: '1h', index: false }));
app.get(/^\/(?!api\/|media\/|art\/).*/, (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

app.use((err, _req, res, _next) => {
  const status = err instanceof HttpError ? err.status : (err.status || err.statusCode || 500);
  if (status >= 500) console.error(err);
  const code = err instanceof HttpError ? err.code : (status === 413 ? 'too_large' : 'server_error');
  // Most 5xx messages are internal detail and stay hidden; a route can opt in with { expose: true }.
  const message = (status >= 500 && !err.expose) ? 'Something went wrong on our end.' : (err.message || 'Request failed');
  res.status(status).json({ error: { message, code } });
});
