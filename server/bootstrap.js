// Runs on every startup, regardless of SEED_DEMO. A real deployment sets
// SEED_DEMO=false (see README) — but it still needs a first admin account to
// be able to approve creator requests, so that account's creation can never
// be gated behind the demo-catalog flag.
import { User } from './db.js';
import { hashPassword } from './auth.js';
import { ADMIN_EMAIL, ADMIN_PASSWORD, APP_NAME, IS_PRODUCTION } from './config.js';

export async function ensureAdmin() {
  if (await User.exists({ role: 'admin' })) return null;
  // A well-known default password is fine on your own machine (it's printed to the console below) but is a
  // public backdoor on an internet-facing deployment, so production never falls back to one.
  if (IS_PRODUCTION && ADMIN_PASSWORD.length < 8) {
    console.error(`${APP_NAME}: no admin account exists and ADMIN_PASSWORD (8+ characters) isn't set, so none was created. Set ADMIN_EMAIL and ADMIN_PASSWORD, then redeploy/restart.`);
    return null;
  }
  const email = ADMIN_EMAIL;
  const password = ADMIN_PASSWORD || 'aurelune-admin';
  let user = await User.findOne({ email });
  if (user) { user.role = 'admin'; await user.save(); }
  else user = await User.create({ username: 'admin', email, displayName: 'Aurelune Admin', role: 'admin', passwordHash: hashPassword(password) });
  console.log(`${APP_NAME}: created admin account — ${email} / ${ADMIN_PASSWORD ? '(the password you set in ADMIN_PASSWORD)' : password}. Change this password immediately.`);
  return user;
}
