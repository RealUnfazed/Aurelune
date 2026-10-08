"""Regenerates the README screenshots (docs/screenshots/*.png) from a running server that has the demo catalog.
   Start the app with SEED_DEMO=true (the default for `npm start` on a fresh data dir), then:
       pip install playwright pillow && playwright install chromium
       BASE=http://127.0.0.1:3000 python3 scripts/screenshots.py
"""
import os, io, sys
from playwright.sync_api import sync_playwright
from PIL import Image, ImageDraw, ImageFilter

BASE = os.environ.get('BASE', 'http://127.0.0.1:3000'); API = BASE + '/api/v1'
OUT = os.path.join(os.path.dirname(__file__), '..', 'docs', 'screenshots'); os.makedirs(OUT, exist_ok=True)
PL = 'import("/js/player.js").then(m=>m.player)'
SCALE = 1.5

def login(ctx):
    r = ctx.request.post(API + '/auth/login', data={'login': 'demo', 'password': 'demo12345'})
    assert r.ok, 'demo login failed: is the demo catalog seeded?'

def settle(pg, ms=900):
    pg.wait_for_load_state('networkidle'); pg.wait_for_timeout(ms)

def play(pg, item, at=None, pause=False):
    pg.evaluate('(it)=>import("/js/player.js").then(m=>m.player.playQueue([it],0))', item); pg.wait_for_timeout(1500)
    if at is not None:
        pg.evaluate(PL + '.then(p=>p.seekTo(%s))' % at); pg.wait_for_timeout(500)
    if pause: pg.evaluate(PL + '.then(p=>p.pause())'); pg.wait_for_timeout(300)

def shot(pg, name, **kw):
    path = os.path.join(OUT, name + '.png'); pg.screenshot(path=path, **kw); print('wrote', name); return path

def framed(path, out, pad=64, radius=18, bg=((18, 40, 38), (44, 20, 66))):
    """Puts a screenshot on an aurora gradient with rounded corners and a soft shadow."""
    im = Image.open(path).convert('RGBA'); w, h = im.size
    W, H = w + pad * 2, h + pad * 2
    base = Image.new('RGB', (W, H)); px = base.load()
    for y in range(H):
        for x in range(0, W):
            t = (x / W * 0.55 + y / H * 0.45)
            px[x, y] = tuple(int(bg[0][i] + (bg[1][i] - bg[0][i]) * t) for i in range(3))
    glow = Image.new('RGB', (W, H), (0, 0, 0)); d = ImageDraw.Draw(glow)
    d.ellipse((-W * .2, -H * .4, W * .55, H * .5), fill=(24, 120, 70)); d.ellipse((W * .5, H * .55, W * 1.2, H * 1.3), fill=(110, 50, 170))
    glow = glow.filter(ImageFilter.GaussianBlur(min(W, H) // 4)); base = Image.blend(base, Image.composite(glow, base, glow.convert('L')), .55).convert('RGBA')
    mask = Image.new('L', im.size, 0); ImageDraw.Draw(mask).rounded_rectangle((0, 0, w, h), radius, fill=255)
    sh = Image.new('RGBA', (W, H), (0, 0, 0, 0)); sd = Image.new('L', (W, H), 0); ImageDraw.Draw(sd).rounded_rectangle((pad, pad + 14, pad + w, pad + h + 14), radius, fill=170)
    sh.putalpha(sd.filter(ImageFilter.GaussianBlur(26))); base = Image.alpha_composite(base, sh)
    base.paste(im, (pad, pad), mask); base.convert('RGB').save(out, optimize=True); print('wrote', os.path.basename(out))

def phones(paths, out, gap=44, pad=64):
    """Phone screenshots in a row, each in a black bezel, on the same aurora background."""
    ims = [Image.open(p).convert('RGBA') for p in paths]; bez = 12; rad = 46
    h = max(i.height for i in ims) + bez * 2; w = sum(i.width + bez * 2 for i in ims) + gap * (len(ims) - 1)
    tmp = Image.new('RGBA', (w, h), (0, 0, 0, 0)); x = 0
    for im in ims:
        bw, bh = im.width + bez * 2, im.height + bez * 2; d = ImageDraw.Draw(tmp)
        d.rounded_rectangle((x, 0, x + bw, bh), rad, fill=(8, 8, 10, 255), outline=(70, 72, 80, 255), width=2)
        m = Image.new('L', im.size, 0); ImageDraw.Draw(m).rounded_rectangle((0, 0, im.width, im.height), rad - bez, fill=255)
        tmp.paste(im, (x + bez, bez), m); x += bw + gap
    p = os.path.join(OUT, '_tmp_phones.png'); tmp.save(p); framed(p, out, pad=pad, radius=0); os.remove(p)

with sync_playwright() as p:
    b = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required', '--force-color-profile=srgb'])
    # ------------------------------------------------------------ desktop
    ctx = b.new_context(viewport={'width': 1440, 'height': 900}, device_scale_factor=SCALE, color_scheme='dark'); login(ctx)
    home = ctx.request.get(API + '/home').json()
    tracks = home['trending']; lyr = next(t for t in tracks if t['has_lyrics'])
    artist_id = home['artists'][0]['id']; show_id = next(s['id'] for s in home['shows'] if s['title'] == 'Deep Focus Collective') if any(s['title'] == 'Deep Focus Collective' for s in home['shows']) else home['shows'][0]['id']
    album_id = home['new_albums'][0]['id']
    pg = ctx.new_page(); pg.goto(BASE + '/'); pg.wait_for_selector('[data-play-card]'); settle(pg)
    play(pg, lyr, at=11)
    pg.evaluate("document.querySelector('#p-lyrics').click()"); settle(pg, 1200)
    d1 = shot(pg, '_desktop_nowplaying'); framed(d1, os.path.join(OUT, 'hero.png'))
    pg.evaluate("document.querySelector('#p-lyrics').click()"); pg.wait_for_timeout(500)
    pg.goto(BASE + f'/#/album/{album_id}'); settle(pg); shot(pg, 'album')
    pg.goto(BASE + f'/#/show/{show_id}'); settle(pg)
    eps = ctx.request.get(API + f'/shows/{show_id}').json()['episodes']
    play(pg, eps[0], at=9); shot(pg, 'podcast')
    pg.goto(BASE + '/#/settings/sound'); settle(pg); shot(pg, 'equalizer')
    pg.goto(BASE + '/#/library'); settle(pg); shot(pg, 'library')
    ctx.close()
    # ------------------------------------------------------------ tablet
    ctx = b.new_context(viewport={'width': 820, 'height': 1000}, device_scale_factor=SCALE, color_scheme='dark', has_touch=True); login(ctx)
    pg = ctx.new_page(); pg.goto(BASE + '/'); pg.wait_for_selector('[data-play-card]'); settle(pg)
    play(pg, lyr, at=14); settle(pg, 600); t = shot(pg, '_tablet'); framed(t, os.path.join(OUT, 'tablet.png'), pad=56)
    ctx.close()
    # ------------------------------------------------------------ phone
    ctx = b.new_context(viewport={'width': 390, 'height': 800}, device_scale_factor=2, color_scheme='dark', has_touch=True, is_mobile=True); login(ctx)
    pg = ctx.new_page(); pg.goto(BASE + '/'); pg.wait_for_selector('[data-play-card]'); settle(pg)
    play(pg, lyr, at=12); settle(pg, 500); a = shot(pg, '_phone_home')
    pg.tap('.pnow-text'); pg.wait_for_selector('#full-player'); pg.wait_for_timeout(900); bshot = shot(pg, '_phone_player')
    pg.evaluate("document.getElementById('fp-close').click()"); pg.wait_for_timeout(400)
    pg.goto(BASE + '/#/library'); settle(pg); c = shot(pg, '_phone_library')
    phones([a, bshot, c], os.path.join(OUT, 'phones.png'))
    ctx.close(); b.close()

# the loose phone/tablet/desktop temporaries are only inputs for the composites
for f in os.listdir(OUT):
    if f.startswith('_'): os.remove(os.path.join(OUT, f))
# keep README images light
for f in os.listdir(OUT):
    if f.endswith('.png'):
        im = Image.open(os.path.join(OUT, f)); im.save(os.path.join(OUT, f), optimize=True)
print('done')
