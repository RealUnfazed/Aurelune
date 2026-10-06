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
