// Tiny observable store for the signed-in user. app.js populates it after
// /api/v1/session resolves; views read it synchronously for role checks.
const target = new EventTarget();
let user = null;
export const getUser = () => user;
export const setUser = (u) => { user = u; target.dispatchEvent(new Event('change')); };
export const onUserChange = (fn) => target.addEventListener('change', fn);
/** Turns UI animations on or off for this page and remembers it for the next load. On by default. */
export function applyAnimations(on) {
  document.documentElement.classList.toggle('no-anim', !on);
  try { localStorage.setItem('aur_anim', on ? '1' : '0'); } catch { /* storage blocked */ }
}
target.addEventListener('change', () => { if (user && typeof user.animations === 'boolean') applyAnimations(user.animations); });
export const isCreatorApproved = () => !!user?.creators?.some((c) => c.status === 'approved') || user?.creator?.status === 'approved';
export const isAdmin = () => user?.role === 'admin';

/* ------------------------------ Interface scale (Settings → Appearance) ------------------------------ */
// Like Spotify's zoom: the whole interface gets bigger or smaller, on this device (screens differ, so it is not an account setting).
// Done with CSS `zoom` on <html>. Two things zoom does not do by itself, handled here:
//  * media queries keep using the real window width, so a 150% interface on a 1000 px window would still get the desktop layout in what
//    is really 666 px. Every width/height media query is rewritten (x scale) so the layout switches as if the window were that small,
//    exactly like browser zoom does;
//  * viewport units are zoomed too, so the few `100vw/100vh` uses divide by --ui-scale (see styles.css) and `uiScale()` is there for
//    code that turns pointer coordinates (real pixels) into CSS pixels.
const SCALE_KEY = 'aur_scale';
export const SCALES = [75, 80, 90, 100, 110, 125, 150, 175, 200];
const clampScale = (n) => (Number.isFinite(n) ? Math.min(200, Math.max(75, Math.round(n))) : 100);
export function getScale() { try { return clampScale(parseInt(localStorage.getItem(SCALE_KEY), 10) || 100); } catch { return 100; } }
let scaleNow = 1;
/** CSS px per real px: coordinates from the pointer or getBoundingClientRect are divided by this. */
export const uiScale = () => scaleNow;
export const uiWidth = () => window.innerWidth / scaleNow;
export const uiHeight = () => window.innerHeight / scaleNow;

const origMedia = new WeakMap(); // rule -> its media text as written in the stylesheet
function rewriteMedia(z) {
  const re = /((?:min|max)-(?:width|height)\s*:\s*)(\d+(?:\.\d+)?)px/g;
  const walk = (rules) => {
    for (const r of rules) {
      if (r.type === CSSRule.MEDIA_RULE) {
        if (!origMedia.has(r)) origMedia.set(r, r.media.mediaText);
        const next = origMedia.get(r).replace(re, (_, f, n) => `${f}${(parseFloat(n) * z).toFixed(2)}px`);
        if (r.media.mediaText !== next) r.media.mediaText = next;
      }
      if (r.cssRules && r.type !== CSSRule.STYLE_RULE) walk(r.cssRules);
    }
  };
  for (const sheet of document.styleSheets) { try { walk(sheet.cssRules); } catch { /* cross-origin sheet: not ours */ } }
}

/** Applies a scale in percent (75–200), remembers it, and tells the page (the 'aur-scale' event). 100 removes the zoom entirely. */
export function applyScale(pct, { save = true } = {}) {
  const p = clampScale(pct), z = p / 100;
  const root = document.documentElement;
  scaleNow = z;
  root.style.setProperty('--ui-scale', String(z));
  root.style.zoom = z === 1 ? '' : String(z);
  root.classList.toggle('scaled', z !== 1);
  rewriteMedia(z);
  if (save) { try { p === 100 ? localStorage.removeItem(SCALE_KEY) : localStorage.setItem(SCALE_KEY, String(p)); } catch { /* storage blocked */ } }
  window.dispatchEvent(new Event('aur-scale'));
  return p;
}
