// Long names in tight places (the player bar, the full-screen player) glide sideways so the whole name can be read, instead of
// being cut off with "…". The text is only wrapped and animated when it really overflows; with animations off (Settings →
// Appearance) it stays a plain ellipsis, and the full name is in the element's tooltip. Links inside keep working while it moves.
let ro = null;
const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (f) => setTimeout(f, 16);

function unwrap(el) {
  const inner = el.querySelector(':scope > .mq-in');
  if (inner) { while (inner.firstChild) el.insertBefore(inner.firstChild, inner); inner.remove(); }
  el.classList.remove('mq-run');
  el.style.removeProperty('--mq-dist'); el.style.removeProperty('--mq-dur');
}

export function fitMarquee(el) {
  if (!el) return;
  unwrap(el);
  el.title = el.textContent.trim();
  if (document.documentElement.classList.contains('no-anim')) return;
  if (el.scrollWidth - el.clientWidth < 3) { el.removeAttribute('title'); return; }
  const span = document.createElement('span');
  span.className = 'mq-in';
  while (el.firstChild) span.appendChild(el.firstChild);
  el.appendChild(span);
  el.classList.add('mq-run');
  const dist = Math.ceil(span.getBoundingClientRect().width - el.clientWidth + 10); // a little extra so the last letter clears the fade
  if (dist < 4) { unwrap(el); return; }
  el.style.setProperty('--mq-dist', `-${dist}px`);
  el.style.setProperty('--mq-dur', `${Math.min(24, Math.max(6, dist / 22 + 4)).toFixed(1)}s`); // ~22 px a second plus the pauses at both ends
}

/** Fit every element now and again whenever its box changes size (window resize, side panel opening, tablet <-> desktop). */
export function watchMarquee(els) {
  ro?.disconnect(); ro = null;
  const list = [...els].filter(Boolean);
  list.forEach(fitMarquee);
  if (typeof ResizeObserver !== 'function' || !list.length) return;
  const widths = new Map(list.map((el) => [el, el.clientWidth]));
  let queued = false;
  ro = new ResizeObserver(() => {
    if (queued) return; queued = true;
    raf(() => { queued = false; for (const el of list) { if (el.isConnected && el.clientWidth !== widths.get(el)) { widths.set(el, el.clientWidth); fitMarquee(el); } } });
  });
  list.forEach((el) => ro.observe(el));
  document.fonts?.ready?.then(() => list.forEach((el) => el.isConnected && fitMarquee(el))).catch(() => {});
}
