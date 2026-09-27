// DOM-level helpers shared by the router (app.js) and the views: toasts,
// modals, and the "what list is currently on screen" queue context used so
// clicking play on a row plays that row within the list it came from.
import { icon } from './icons.js';

let activeList = [];
export const setActiveList = (items) => { activeList = items || []; (items || []).forEach(registerItem); };
export const getActiveList = () => activeList;

// Every card/row registers the full DTO it was built from here, keyed by
// "type:id". Delegated click handlers (play, like, follow…) look items up
// by the id in the DOM instead of re-fetching or threading data through.
const registry = new Map();
export const registerItem = (item) => {
  if (!item) return;
  registry.set(`${item.type}:${item.id}`, item);
  if (item.type === 'artist' && item.slug) registry.set(`artist:${item.slug}`, item);
};
export const getItem = (type, id) => registry.get(`${type}:${id}`);

export const bus = new EventTarget();
export const notifyPlaylistsChanged = () => bus.dispatchEvent(new Event('playlists-changed'));

let ctxMenuEl = null;
export function closeContextMenu() { ctxMenuEl?.remove(); ctxMenuEl = null; }
/** A small floating menu at a screen position (right-click or a "more" button), not a centered modal. */
export function openContextMenu(x, y, html) {
  closeContextMenu();
  const el = document.createElement('div');
  el.className = 'ctx-menu';
  el.innerHTML = html;
  document.body.appendChild(el);
  const vw = window.innerWidth, vh = window.innerHeight;
  const rect = el.getBoundingClientRect();
  el.style.left = Math.max(8, Math.min(x, vw - rect.width - 8)) + 'px';
  el.style.top = Math.max(8, Math.min(y, vh - rect.height - 8)) + 'px';
  ctxMenuEl = el;
  return el;
}
document.addEventListener('mousedown', (e) => { if (ctxMenuEl && !e.target.closest('.ctx-menu')) closeContextMenu(); });
document.addEventListener('contextmenu', (e) => { if (ctxMenuEl && !e.target.closest('.ctx-menu')) closeContextMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeContextMenu(); });
document.addEventListener('scroll', () => closeContextMenu(), true);

export function toast(message, { err = false } = {}) {
  let stack = document.querySelector('.toast-stack');
  if (!stack) { stack = document.createElement('div'); stack.className = 'toast-stack'; document.body.appendChild(stack); }
  const el = document.createElement('div');
  el.className = 'toast' + (err ? ' err' : '');
  el.textContent = message;
  stack.appendChild(el);
  setTimeout(() => el.remove(), 3400);
}

let modalStack = [];
export function openModal({ title, body, footer, wide = false, onClose }) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `<div class="modal ${wide ? 'wide' : ''}">
    <div class="modal-head"><h3>${title}</h3><button class="icon-btn" data-close>${icon('x')}</button></div>
    <div class="modal-body scrollbar"></div>
    ${footer ? `<div class="modal-foot"></div>` : ''}
  </div>`;
  const bodyEl = backdrop.querySelector('.modal-body');
  if (typeof body === 'string') bodyEl.innerHTML = body; else bodyEl.appendChild(body);
  if (footer) {
    const footEl = backdrop.querySelector('.modal-foot');
    if (typeof footer === 'string') footEl.innerHTML = footer; else footEl.appendChild(footer);
  }
  const close = () => { backdrop.remove(); modalStack = modalStack.filter((m) => m !== backdrop); onClose?.(); };
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
  backdrop.querySelector('[data-close]').addEventListener('click', close);
  document.body.appendChild(backdrop);
  modalStack.push(backdrop);
  return { el: backdrop, close };
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && modalStack.length) modalStack[modalStack.length - 1].querySelector('[data-close]')?.click();
});

export function confirmDialog(message, { danger = true, confirmText = 'Delete' } = {}) {
  return new Promise((resolve) => {
    const m = openModal({
      title: 'Are you sure?',
      body: `<p style="color:var(--text-dim);font-size:14px;line-height:1.6">${message}</p>`,
      footer: `<button class="btn btn-ghost" data-cancel>Cancel</button><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${confirmText}</button>`,
    });
    m.el.querySelector('[data-cancel]').addEventListener('click', () => { m.close(); resolve(false); });
    m.el.querySelector('[data-ok]').addEventListener('click', () => { m.close(); resolve(true); });
  });
}

export function escHtml(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
