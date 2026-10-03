// Vercel serverless entry point. Everything meaningful lives in server/app.js —
// this file only exists because Vercel's convention is to look under /api.
import { app } from '../server/app.js';
export default app;
