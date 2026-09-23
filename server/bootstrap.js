// Runs on every startup, regardless of SEED_DEMO. A real deployment sets
// SEED_DEMO=false (see README) — but it still needs a first admin account to
// be able to approve creator requests, so that account's creation can never
// be gated behind the demo-catalog flag.
import { User } from './db.js';
import { hashPassword } from './auth.js';
import { ADMIN_EMAIL, ADMIN_PASSWORD, APP_NAME } from './config.js';

export async function ensureAdmin() {
  if (await User.exists({ role: 'admin' })) return null;
  const email = ADMIN_EMAIL;
  const password = ADMIN_PASSWORD || 'aurelune-admin';
  let user = await User.findOne({ email });
  if (user) { user.role = 'admin'; await user.save(); }
  else user = await User.create({ username: 'admin', email, displayName: 'Aurelune Admin', role: 'admin', passwordHash: hashPassword(password) });
  console.log(`${APP_NAME}: created admin account — ${email} / ${ADMIN_PASSWORD ? '(the password you set in ADMIN_PASSWORD)' : password}. Change this password immediately.`);
  return user;
}
