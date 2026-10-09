// Runs before the page paints (classic script in <head>): restores the animations choice so a "no animations" user never sees a flash of motion.
// The account setting (Settings → Appearance) is the source of truth; localStorage only mirrors it for this first paint.
try { if (localStorage.getItem('aur_anim') === '0') document.documentElement.classList.add('no-anim'); } catch { /* storage blocked: animations stay on */ }
// The interface scale (Settings → Appearance) is restored here too, so a zoomed interface never flashes at 100% first.
try { const s = parseInt(localStorage.getItem('aur_scale'), 10); if (s >= 75 && s <= 200 && s !== 100) { document.documentElement.style.setProperty('--ui-scale', String(s / 100)); document.documentElement.style.zoom = String(s / 100); document.documentElement.classList.add('scaled'); } } catch { /* storage blocked */ }
