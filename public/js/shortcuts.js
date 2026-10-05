// Keyboard shortcuts for playback. They live in the page (not in a native menu accelerator) so they can tell when you're
// typing: Space in a search box is a space, not "pause".
//
//   Space                      play / pause            (web and desktop)
//   Ctrl/Cmd + → / ←           next / previous         (desktop app only: browsers use these for navigation)
//
// A shortcut is ignored while focus is in anything that takes keyboard input itself: text boxes, textareas, selects,
// contenteditable, sliders; and, for Space, buttons/links/switches, where Space already means "activate this".
import { player } from './player.js';

const isDesktopApp = typeof navigator !== 'undefined' && /\bElectron\//.test(navigator.userAgent);

const EDITABLE = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"], [role="combobox"], [role="slider"]';
const ACTIVATES = 'button, a[href], summary, [role="button"], [role="switch"], [role="checkbox"], [role="menuitem"], [role="tab"], [role="option"], [role="link"], video, audio';

/** Is the user typing (or operating a control that owns the key)? Looks through shadow roots to the real focused element. */
export function keyBelongsToPage(target, { includeActivators = false } = {}) {
  let el = target;
  const active = document.activeElement;
  if (active && active !== document.body && active.shadowRoot?.activeElement) el = active.shadowRoot.activeElement;
  if (!(el instanceof Element)) return false;
  if (el.isContentEditable || el.closest(EDITABLE)) return true;
  return includeActivators && !!el.closest(ACTIVATES);
}

document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || e.isComposing || e.repeat) return;
  const mod = e.ctrlKey || e.metaKey;

  if (e.code === 'Space' && !mod && !e.altKey && !e.shiftKey) {
    if (keyBelongsToPage(e.target, { includeActivators: true })) return;
    if (!player.current) return; // nothing loaded: leave Space alone (so the page can still scroll with it)
    e.preventDefault();
    player.toggle();
    return;
  }

  if (isDesktopApp && mod && !e.altKey && !e.shiftKey && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
    if (keyBelongsToPage(e.target)) return; // Ctrl/Cmd+Arrow moves the caret in a text box
    if (!player.current) return;
    e.preventDefault();
    e.key === 'ArrowRight' ? player.next() : player.prev();
  }
});
