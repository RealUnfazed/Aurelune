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
    ICONS=('heart','star','bolt','flame','moon','note','podcast','mic')
    for icon in ICONS:
        ctx.request.patch(API+'/me',data={'liked_icon':icon})
        pg.goto(BASE+'/#/liked'); pg.reload(); pg.wait_for_selector('.liked-tile.big'); pg.wait_for_timeout(500); check(f'liked page ({icon})')
    for icon in ICONS:
        r=ctx.request.patch(API+'/me',data={'liked_episodes_icon':icon,'liked_episodes_color':'violet'}); ck(f'PATCH liked_episodes_icon={icon} accepted', r.ok, r.status)
        pg.goto(BASE+'/#/liked-episodes'); pg.reload(); pg.wait_for_selector('.liked-tile.big'); pg.wait_for_timeout(500); check(f'liked episodes page ({icon})')
    pg.goto(BASE+'/#/downloads'); pg.wait_for_timeout(700); check('downloads page')
    pg.goto(BASE+'/#/liked'); pg.wait_for_selector('#liked-cover'); pg.click('#liked-cover'); pg.wait_for_selector('#lk-preview .liked-tile'); pg.wait_for_timeout(300); check('icon picker preview')
    pg.screenshot(path='/tmp/pw/tiles_picker.png')
    ctx.request.patch(API+'/me',data={'liked_icon':'heart'})  # the loop above left it on the last icon
    # --- Liked Episodes: server validation, defaults, and the real picker end to end
    r=ctx.request.patch(API+'/me',data={'liked_episodes_icon':'nope'}); ck('liked_episodes_icon rejects unknown icon', r.status==400, r.status)
    r=ctx.request.patch(API+'/me',data={'liked_episodes_color':'nope'}); ck('liked_episodes_color rejects unknown colour', r.status==400, r.status)
    ctx.request.patch(API+'/me',data={'liked_episodes_icon':'podcast','liked_episodes_color':'violet'})
    me=ctx.request.get(API+'/session').json()['user']
    ck('session exposes liked_episodes_style', me['liked_episodes_style']=={'icon':'podcast','color':'violet'}, me.get('liked_episodes_style'))
    ck('Liked Songs style untouched by episodes changes', me['liked_style']['icon']=='heart', me['liked_style'])
    pg.goto(BASE+'/#/liked-episodes'); pg.reload(); pg.wait_for_selector('#liked-cover'); pg.click('#liked-cover'); pg.wait_for_selector('#lk-preview .liked-tile')
    ck('episodes picker titled correctly', 'Liked Episodes' in pg.inner_text('.modal, [role=dialog]'), pg.inner_text('.modal, [role=dialog]')[:80])
    check('episodes picker preview'); pg.screenshot(path='/tmp/pw/tiles_ep_picker.png')
    pg.click('#lk-icons [data-icon="star"]'); pg.click('#lk-colors [data-color="blue"]')
    ck('picker preview follows choice', pg.evaluate("document.querySelector('#lk-preview .liked-tile').dataset.g")=='starFilled')
    pg.click('#lk-save'); pg.wait_for_selector('#lk-preview', state='detached'); pg.wait_for_timeout(700)
    side=pg.evaluate("(()=>{const t=document.querySelector('.nav-playlists [data-liked-ep] .liked-tile');return {g:t.dataset.g,bg:t.style.background}})()")
    ck('sidebar Liked Episodes tile updated live', side['g']=='starFilled' and '#5eb1ff' in side['bg'].replace(' ','') or '94, 177, 255' in side['bg'], side)
    ck('page tile updated after save', pg.evaluate("document.querySelector('.detail-header .liked-tile').dataset.g")=='starFilled')
    pg.reload(); pg.wait_for_selector('.nav-playlists [data-liked-ep] .liked-tile'); pg.wait_for_timeout(600)
    ck('choice persists after reload', pg.evaluate("document.querySelector('.nav-playlists [data-liked-ep] .liked-tile').dataset.g")=='starFilled')
    ck('Liked Songs tile still heart', pg.evaluate("document.querySelector('.nav-playlists [data-liked] .liked-tile').dataset.g")=='heartFill')
    # sidebar right-click -> Change icon…
    pg.click('.nav-playlists [data-liked-ep]', button='right'); pg.wait_for_selector('.ctx-item[data-act="icon"]'); pg.click('.ctx-item[data-act="icon"]')
    pg.wait_for_selector('#lk-preview .liked-tile'); ck('sidebar menu opens the episodes picker', 'Liked Episodes' in pg.inner_text('.modal, [role=dialog]'))
    ck('episodes picker opens on the saved choice', pg.evaluate("document.querySelector('#lk-icons .on').dataset.icon")=='star')
    pg.click('[data-close]'); pg.wait_for_timeout(300)
    pg.goto(BASE+'/#/library'); pg.wait_for_timeout(900)
    ck('library card uses the chosen episodes tile', pg.evaluate("document.querySelector('#liked-eps-card .liked-tile').dataset.g")=='starFilled')
    ctx.request.patch(API+'/me',data={'liked_episodes_icon':'podcast','liked_episodes_color':'violet'})
    ctx.request.patch(API+'/me',data={'liked_icon':'heart'}); b.close()
print(f'\n{ok} passed, {bad} failed'); raise SystemExit(1 if bad else 0)
