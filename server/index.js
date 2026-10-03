// Local / traditional-hosting entry point (npm start, Docker, Electron). On Vercel,
// api/index.js imports server/app.js directly instead — this file is never used there.
import { app, ready } from './app.js';
import { PORT, APP_NAME, SEED_DEMO } from './config.js';

async function start() {
  await ready();
  console.log(`${APP_NAME}: connected to MongoDB`);
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
