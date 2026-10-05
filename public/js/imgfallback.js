// Pictures that fail to load (the file host is down, a flaky connection, a CDN hiccup) must never leave a broken-image icon.
//
// The server tags every cover/avatar URL with the artwork it can be replaced by: ".../cover.jpg#art=%2Fart%2Ftrack%2F123.svg".
// (A URL fragment is never sent to a server, so this costs nothing.) When such an image errors we show the generated art at once,
// then quietly try the real picture again — soon at first, then less and less often — and swap it in as soon as it loads.
// Going back online, or the tab coming back to the foreground, triggers an immediate retry.

const DELAYS = [3000, 8000, 20000, 60000, 180000, 300000]; // the last one repeats
const pending = new Map(); // <img> -> { attempt, timer }

function artOf(src) {
  const i = (src || '').indexOf('#art=');
  if (i < 0) return null;
  try { return decodeURIComponent(src.slice(i + 5)); } catch { return null; }
}

function schedule(img, attempt) {
  clearTimeout(pending.get(img)?.timer);
  const timer = setTimeout(() => probe(img), DELAYS[Math.min(attempt, DELAYS.length - 1)]);
  pending.set(img, { attempt, timer });
}

function probe(img) {
  const st = pending.get(img);
  if (!st) return;
  if (!img.isConnected || img.dataset.fb !== '1') { pending.delete(img); return; } // the page moved on
  if (navigator.onLine === false) { schedule(img, st.attempt); return; }
  const test = new Image();
  test.onload = () => {
    pending.delete(img);
    if (img.isConnected && img.dataset.fb === '1' && img.dataset.orig) { img.dataset.fb = '0'; img.src = img.dataset.orig; }
  };
  test.onerror = () => schedule(img, st.attempt + 1);
  test.src = img.dataset.orig;
}

function retryAllNow() {
  for (const [img, st] of pending) { clearTimeout(st.timer); pending.set(img, { attempt: st.attempt, timer: setTimeout(() => probe(img), 0) }); }
}

document.addEventListener('error', (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement)) return;
  const art = artOf(img.getAttribute('src') || img.src);
  if (!art) return; // no fallback known, or this is already the fallback
  img.dataset.orig = img.getAttribute('src');
  img.dataset.fb = '1';
  img.src = art;
  schedule(img, 0);
}, true); // image errors don't bubble, so listen while the event travels down

window.addEventListener('online', retryAllNow);
document.addEventListener('visibilitychange', () => { if (!document.hidden) retryAllNow(); });

export const _pendingCount = () => pending.size; // for tests
