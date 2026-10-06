// Runs before the page paints (classic script in <head>): restores the animations choice so a "no animations" user never sees a flash of motion.
// The account setting (Settings → Appearance) is the source of truth; localStorage only mirrors it for this first paint.
try { if (localStorage.getItem('aur_anim') === '0') document.documentElement.classList.add('no-anim'); } catch { /* storage blocked: animations stay on */ }
