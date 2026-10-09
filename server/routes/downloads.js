// Offline downloads. The audio itself comes from the normal stream routes (`?dl=1`); this file only hands out the *licence*:
// the key a device needs to open the encrypted copies it keeps, valid for 30 days at a time.
//
//  * The key is derived on the server (HMAC of the account, the device and the account's "epoch"), so it is stable for a
//    device — renewing never invalidates what is already stored — but different for every account and every device.
//  * Renewing needs a valid sign-in. Signing out, a deleted account, or a password change (which bumps the epoch) means the
//    next check-in fails or yields a different key, and the stored copies can no longer be opened.
//  * The browser stores the key as a non-extractable WebCrypto key and deletes it when the licence runs out; see public/js/downloads.js.
//
// Like the at-rest encryption of uploaded files, this keeps downloads Aurelune-only and stops casual copying. It is not DRM:
// a person who can run the app can, in principle, capture what their own speakers play.
import { Router } from 'express';
import crypto from 'node:crypto';
import { requireAuth, sessionOnly } from '../auth.js';
import { bad } from '../util.js';
import { IS_SERVERLESS } from '../config.js';

const r = Router();
export const LICENSE_DAYS = 30;

let SECRET = null;
function secret() {
  if (SECRET) return SECRET;
  const env = process.env.DOWNLOAD_LICENSE_SECRET || process.env.AUDIO_ENCRYPTION_KEY;
  // Serverless hosts have no persistent disk, so without an explicit secret derive a stable one from settings only the operator has.
  const basis = env || (IS_SERVERLESS ? `${process.env.MONGODB_URI || ''}|${process.env.ADMIN_PASSWORD || ''}` : '');
  if (basis.length >= 8) return (SECRET = crypto.createHash('sha256').update(`aurelune-download-licence|${basis}`).digest());
  SECRET = crypto.randomBytes(32); // self-hosted with nothing configured: lasts until restart, then devices renew and re-download
  console.warn('Aurelune: set DOWNLOAD_LICENSE_SECRET (or AUDIO_ENCRYPTION_KEY) so offline downloads survive a server restart.');
  return SECRET;
}

export const deriveLicenseKey = (userId, epoch, device) =>
  crypto.createHmac('sha256', secret()).update(`dl1|${userId}|${epoch || 0}|${device}`).digest();

const DEVICE_RE = /^[A-Za-z0-9_-]{16,64}$/;

r.post('/downloads/license', requireAuth, sessionOnly, (req, res) => {
  const device = String(req.body?.device || '');
  if (!DEVICE_RE.test(device)) throw bad('A device id (16-64 letters, digits, - or _) is required', 'bad_device');
  const now = Date.now();
  res.set('Cache-Control', 'no-store').json({
    key: deriveLicenseKey(String(req.user._id), req.user.downloadsEpoch, device).toString('base64url'),
    user_id: String(req.user._id),
    device,
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + LICENSE_DAYS * 86400000).toISOString(),
    days: LICENSE_DAYS,
  });
});

// "Remove downloads from all my devices": a new epoch means a new key, so every stored copy stops opening at its next check-in.
r.post('/downloads/revoke', requireAuth, sessionOnly, async (req, res) => {
  req.user.downloadsEpoch = (req.user.downloadsEpoch || 0) + 1;
  await req.user.save();
  res.json({ ok: true });
});

export default r;
