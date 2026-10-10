// Playback speed (podcasts) and the sleep timer: the menus and the small buttons, used by the player bar, the right panel,
// the phone full-screen player, right-click menus and the profile menu. Any element with [data-speed-btn] / [data-sleep-btn]
// opens the matching menu (one delegated listener), and everything is kept in sync from the player's 'rate' / 'sleep' events.
import { player, RATES, SLEEP_OPTIONS } from './player.js';
import { icon } from './icons.js';
import { openContextMenu, closeContextMenu } from './ui.js';
import { uiScale, uiWidth, uiHeight } from './store.js';

export const rateLabel = (r) => `${r}x`;
const clock = (s) => { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`; };
/** "12:03" while a timed timer runs, "End" for end-of-item, '' when off. */
export const sleepText = () => (player.sleep?.end ? 'End' : player.sleep ? clock(player.sleepLeft ?? 0) : '');

export const speedBtn = (id, cls = 'icon-btn') => `<button class="${cls} spd-btn ${player.rate !== 1 ? 'on' : ''}" ${id ? `id="${id}"` : ''} ${player.current?.type === 'episode' ? '' : 'hidden'} data-speed-btn aria-label="Playback speed" title="Playback speed"><span data-rate-text>${rateLabel(player.rate)}</span></button>`;
export const sleepBtn = (id, cls = 'icon-btn') => `<button class="${cls} sleep-btn ${player.sleep ? 'on' : ''}" ${id ? `id="${id}"` : ''} data-sleep-btn aria-label="Sleep timer" title="Sleep timer">${icon('sleep')}<span class="sl-left" data-sleep-text>${sleepText()}</span></button>`;

let menu = null, owner = null, kind = '';
const itemWord = () => (player.current?.type === 'episode' ? 'episode' : 'track');

function place(el, anchor) {
  const z = uiScale(), vw = uiWidth(), vh = uiHeight();
  const r = anchor.getBoundingClientRect(), m = el.getBoundingClientRect(), w = m.width / z, h = m.height / z;
  let left = (r.left + r.width / 2) / z - w / 2;
  left = Math.max(8, Math.min(left, vw - w - 8));
  const low = (r.top + r.bottom) / 2 / z > vh / 2;    // a button in the lower half (the player bar) opens its menu upwards, one in the top bar downwards
  let top = low ? r.top / z - h - 8 : r.bottom / z + 8;
  if (top < 8 || top + h > vh - 8) top = Math.max(8, Math.min(top, vh - h - 8));
  el.style.left = left + 'px'; el.style.top = Math.max(8, top) + 'px';
}
/** `at` is a button (the menu appears next to it) or {x, y} (a right-click). */
function show(html, at, cls) {
  closeContextMenu();
  const el = openContextMenu(at.x ?? 0, at.y ?? 0, html);
  el.classList.add('opt-menu', cls); // (before measuring: these classes set the width)
  if (at.getBoundingClientRect) place(el, at);
  menu = el; owner = at.getBoundingClientRect ? at : null;
  return el;
}

function speedHtml() {
  return `<div class="opt-head">Playback speed</div>
    <div class="rate-grid">${RATES.map((r) => `<button type="button" class="rate-opt ${r === player.rate ? 'on' : ''}" data-rate="${r}">${rateLabel(r)}</button>`).join('')}</div>`;
}
function sleepHtml() {
  const s = player.sleep, word = itemWord();
  const label = (o) => (o.end ? `End of this ${word}` : o.min === 60 ? '1 hour' : `${o.min} minutes`);
  const on = (o) => (o.end ? !!s?.end : !!s?.total && Math.round(s.total / 60e3) === o.min);
  return `<div class="opt-head">Sleep timer</div>
    ${s ? `<div class="sl-status" data-sleep-status>${s.end ? `Stops at the end of this ${word}` : `Stops in <b data-sleep-text-menu>${sleepText()}</b>`}</div>` : ''}
    ${SLEEP_OPTIONS.map((o) => `<button type="button" class="ctx-item ${on(o) ? 'sel' : ''}" data-sl="${o.end ? 'end' : o.min}"><span>${label(o)}</span>${on(o) ? icon('check') : ''}</button>`).join('')}
    ${s ? `<div class="ctx-sep"></div><button type="button" class="ctx-item danger" data-sl="off"><span>Turn off timer</span></button>` : ''}`;
}

export function openSpeedMenu(at) {
  if (player.current?.type !== 'episode') return;
  kind = 'speed';
  const el = show(speedHtml(), at, 'speed-menu');
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-rate]'); if (!b) return;
    player.setRate(Number(b.dataset.rate)); closeContextMenu();
  });
  el.querySelector('.rate-opt.on')?.scrollIntoView?.({ block: 'nearest' });
}
export function openSleepMenu(at) {
  if (!player.current) return;
  kind = 'sleep';
  const el = show(sleepHtml(), at, 'sleep-menu');
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-sl]'); if (!b) return;
    const v = b.dataset.sl;
    if (v === 'off') player.clearSleep();
    else player.setSleep(v === 'end' ? { end: true } : { minutes: Number(v) });
    closeContextMenu();
  });
}

/** Brings every button and an open menu up to date. */
export function refreshPlayOpts() {
  const ep = player.current?.type === 'episode';
  document.querySelectorAll('[data-speed-btn]').forEach((b) => {
    b.classList.toggle('on', player.rate !== 1);
    b.hidden = !ep;
    b.querySelectorAll('[data-rate-text]').forEach((t) => { t.textContent = rateLabel(player.rate); });
  });
  document.querySelectorAll('[data-sleep-btn]').forEach((b) => {
    b.classList.toggle('on', !!player.sleep);
    b.querySelectorAll('[data-sleep-text]').forEach((t) => { t.textContent = sleepText(); });
    b.title = player.sleep ? `Sleep timer: ${player.sleep.end ? 'end of this ' + itemWord() : sleepText() + ' left'}` : 'Sleep timer';
  });
  if (menu?.isConnected && kind === 'sleep') {
    const t = menu.querySelector('[data-sleep-text-menu]');
    if (t && player.sleep?.endsAt) t.textContent = sleepText();
    else if (!!menu.querySelector('[data-sleep-status]') !== !!player.sleep || player.sleep?.end) menu.innerHTML = sleepHtml(); // started/stopped while open
  }
}

// One set of listeners for every button, however often the bar is re-rendered.
let skipClick = null;
document.addEventListener('mousedown', (e) => { // a click on the button that opened the menu closes it (instead of closing and re-opening)
  const b = e.target.closest?.('[data-speed-btn], [data-sleep-btn]');
  skipClick = menu?.isConnected && b && b === owner ? b : null;
}, true);
document.addEventListener('click', (e) => {
  const b = e.target.closest?.('[data-speed-btn], [data-sleep-btn]');
  if (!b) return;
  e.preventDefault(); e.stopPropagation();
  if (skipClick === b) { skipClick = null; return; }
  b.hasAttribute('data-speed-btn') ? openSpeedMenu(b) : openSleepMenu(b);
}, true);
player.addEventListener('rate', refreshPlayOpts);
player.addEventListener('sleep', refreshPlayOpts);
player.addEventListener('change', refreshPlayOpts);
