"""The Liked Songs / Liked Episodes / Downloads tiles: the glyph is centred in its tile and not oversized, everywhere they appear
   (sidebar expanded + collapsed, library, the Liked pages, the icon picker), for every icon choice.
   bash test/integration/runpf.sh test/integration/liked_tiles.py"""
from playwright.sync_api import sync_playwright
BASE='http://127.0.0.1:3000'; API=BASE+'/api/v1'
ok=bad=0
def ck(n,c,x=''):
    global ok,bad
    ok+=bool(c); bad+=not c; print(('PASS ' if c else 'FAIL ')+n+('' if c else ' '+str(x)))
PROBE='''()=>[...document.querySelectorAll('.liked-tile')].filter(t=>t.getBoundingClientRect().width>0).map(t=>{const tr=t.getBoundingClientRect(),s=t.querySelector('svg').getBoundingClientRect();
  return {g:t.dataset.g||'(fixed)',tile:tr.width,sz:s.width,dx:(s.left+s.right)/2-(tr.left+tr.right)/2,dy:(s.top+s.bottom)/2-(tr.top+tr.bottom)/2,inside:s.left>=tr.left-0.5&&s.right<=tr.right+0.5&&s.top>=tr.top-0.5&&s.bottom<=tr.bottom+0.5}})'''
with sync_playwright() as p:
    b=p.chromium.launch(); ctx=b.new_context(viewport={'width':1366,'height':800}); ctx.request.post(API+'/auth/login',data={'login':'admin@aurelune.local','password':'aurelune-admin'})
    pg=ctx.new_page(); pg.goto(BASE+'/'); pg.wait_for_selector('.nav'); pg.wait_for_timeout(900)
    def check(label):
        r=pg.evaluate(PROBE); ck(f'{label}: found tiles', len(r)>0)
        for t in r:
            tol=max(1.0,t['tile']*0.045)
            ck(f"{label}: {t['g']} centred (dx {t['dx']:.1f}, dy {t['dy']:.1f}, tile {t['tile']:.0f}px)", abs(t['dx'])<=tol and abs(t['dy'])<=tol and t['inside'], t)
            ck(f"{label}: {t['g']} not oversized ({t['sz']:.0f} of {t['tile']:.0f}px)", t['sz']<=t['tile']*0.46, t)
    check('sidebar')
    pg.click('#nav-collapse'); pg.wait_for_timeout(500); check('sidebar collapsed'); pg.click('#nav-collapse'); pg.wait_for_timeout(300)
    pg.goto(BASE+'/#/library'); pg.wait_for_timeout(900); check('library')
    for icon in ('heart','star','bolt','flame','moon','note'):
        ctx.request.patch(API+'/me',data={'liked_icon':icon})
        pg.goto(BASE+'/#/liked'); pg.reload(); pg.wait_for_selector('.liked-tile.big'); pg.wait_for_timeout(500); check(f'liked page ({icon})')
    pg.goto(BASE+'/#/liked-episodes'); pg.wait_for_timeout(700); check('liked episodes page')
    pg.goto(BASE+'/#/downloads'); pg.wait_for_timeout(700); check('downloads page')
    pg.goto(BASE+'/#/liked'); pg.wait_for_selector('#liked-cover'); pg.click('#liked-cover'); pg.wait_for_selector('#lk-preview .liked-tile'); pg.wait_for_timeout(300); check('icon picker preview')
    pg.screenshot(path='/tmp/pw/tiles_picker.png')
    ctx.request.patch(API+'/me',data={'liked_icon':'heart'}); b.close()
print(f'\n{ok} passed, {bad} failed'); raise SystemExit(1 if bad else 0)
