// Tiny observable store for the signed-in user. app.js populates it after
// /api/v1/session resolves; views read it synchronously for role checks.
const target = new EventTarget();
let user = null;
export const getUser = () => user;
export const setUser = (u) => { user = u; target.dispatchEvent(new Event('change')); };
export const onUserChange = (fn) => target.addEventListener('change', fn);
export const isCreatorApproved = () => user?.creator?.status === 'approved';
export const isAdmin = () => user?.role === 'admin';
