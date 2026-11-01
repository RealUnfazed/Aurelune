"""Settings → Sound opens and works with no connection; "Copy song link" really copies a link to the song, and that link lands on the song.
   bash test/integration/runpf.sh test/integration/sound_offline_songlink.py"""
from playwright.sync_api import sync_playwright
BASE='http://127.0.0.1:3000'; API=BASE+'/api/v1'
ok=bad=0
def ck(n,c,x=''):
    global ok,bad
    ok+=bool(c); bad+=not c; print(('PASS ' if c else 'FAIL ')+n+('' if c else ' '+str(x)))
with sync_playwright() as p:
    b=p.chromium.launch()
    ctx=b.new_context(viewport={'width':1366,'height':800}, permissions=['clipboard-read','clipboard-write'])
    ctx.request.post(API+'/auth/login',data={'login':'admin@aurelune.local','password':'aurelune-admin'})
    home=ctx.request.get(API+'/home').json(); tracks=home['trending']; eps=home.get('new_episodes') or []
    pg=ctx.new_page(); errs=[]; pg.on('pageerror',lambda e:errs.append(str(e)))
    reqs=[]; pg.on('request',lambda r: reqs.append(r.url) if '/api/' in r.url else None)

    # ---- Sound, offline ----------------------------------------------------------------------------------------------------------------
    pg.goto(BASE+'/#/settings/sound'); pg.wait_for_selector('.eq-slider'); pg.wait_for_timeout(500)
    ck('online: sound tab shows 7 sliders and the presets', len(pg.query_selector_all('.eq-slider'))==7 and len(pg.query_selector_all('#eq-presets .chip'))>=12)
    ck('opening the tab makes no /me/eq request', not any(u.endswith('/me/eq') for u in reqs), [u for u in reqs if 'eq' in u])
    ctx.set_offline(True)
    pg.goto(BASE+'/#/'); pg.wait_for_timeout(300)
    pg.evaluate('location.hash="#/settings/account"'); pg.wait_for_selector('[data-tab="sound"]'); pg.click('[data-tab="sound"]')
    try: pg.wait_for_selector('.eq-slider',timeout=4000); shown=True
    except Exception: shown=False
    ck('offline: sound tab still loads (sliders drawn)', shown)
    ck('offline: all 7 sliders and the presets are there', len(pg.query_selector_all('.eq-slider'))==7 and len(pg.query_selector_all('#eq-presets .chip'))>=12)
    ck('offline: no error toast just from opening it', pg.query_selector('.toast.err')is None)
    pg.click('#eq-presets [data-preset="bass_boost"]'); pg.wait_for_timeout(900)
    bands=pg.evaluate('(async()=>(await import("/js/player.js")).player._eqBands)()')
    ck('offline: choosing a preset still changes the live sound', bands==[6,5,3,0,-1,-1,0], bands)
    ck('offline: it says it is only applied on this device (once)', 'Offline' in (pg.inner_text('#toasts,.toast-host,body')), '')
    cached=pg.evaluate('JSON.parse(localStorage.getItem("aur_user")).eq')
    ck('offline: the choice is kept on this device for the next start', cached['preset']=='bass_boost' and cached['bands']==[6,5,3,0,-1,-1,0], cached)
    pg.evaluate('(()=>{const s=document.querySelector(".eq-slider[data-band=\\"3\\"]");s.value=5;s.dispatchEvent(new Event("input",{bubbles:true}))})()'); pg.wait_for_timeout(700)
    ck('offline: dragging a slider works and becomes Custom', pg.inner_text('#eq-val-3').strip()=='+5' and 'active' in pg.get_attribute('#chip-custom','class'))
    ctx.set_offline(False)
    # online again: the same choice reaches the account
    pg.evaluate('(async()=>{const m=await import("/js/api.js"); await m.api.put("/me/eq",{preset:"flat"})})()')
    pg.reload(); pg.wait_for_selector('[data-tab="sound"]'); pg.click('[data-tab="sound"]'); pg.wait_for_selector('.eq-slider'); pg.wait_for_timeout(400)
    ck('after reload online, the account value wins (flat)', pg.get_attribute('#eq-presets [data-preset="flat"]','class').find('active')>=0)
    pg.click('#eq-presets [data-preset="rock"]'); pg.wait_for_timeout(1000)
    srv=ctx.request.get(API+'/me/eq').json()
    ck('online: saving still reaches the server', srv['preset']=='rock' and srv['bands']==[4,2,-2,-3,0,3,4], srv)

    # a real offline START (reload with no connection) must also open the Sound tab
    pg.goto(BASE+'/#/'); pg.wait_for_timeout(1500)
    sw=pg.evaluate('navigator.serviceWorker.ready.then(()=>true).catch(()=>false)')
    pg.wait_for_timeout(500); pg.reload(wait_until='load'); pg.wait_for_selector('#app'); pg.wait_for_timeout(1500)   # a second load so everything is in the cache
    ctx.set_offline(True)
    pg.goto(BASE+'/#/settings/sound'); pg.wait_for_timeout(500); pg.reload(wait_until='domcontentloaded')
    try: pg.wait_for_selector('.eq-slider',timeout=8000); started=True
    except Exception: started=False
    ck('offline START (reload with no connection): Sound tab opens with sliders', started and sw)
    if started:
        ck('offline START: shows the offline pill and the saved preset is selected', pg.query_selector('.offline-pill') is not None and 'active' in pg.get_attribute('#eq-presets [data-preset="rock"]','class'), pg.get_attribute('#eq-presets .active','data-preset') if pg.query_selector('#eq-presets .active') else None)
    ctx.set_offline(False); pg.goto(BASE+'/#/'); pg.reload(); pg.wait_for_selector('#app'); pg.wait_for_timeout(800)   # back online: a normal start again

    # ---- song link ---------------------------------------------------------------------------------------------------------------------
    t=tracks[0]
    pg.goto(BASE+'/#/search?q='+t['title'][:4]); pg.wait_for_selector('.trow'); pg.wait_for_timeout(600)
    row=pg.query_selector(f'.trow[data-id="{t["id"]}"]') or pg.query_selector('.trow')
    tid=row.get_attribute('data-id'); row.click(button='right'); pg.wait_for_selector('.ctx-menu,.context-menu,[data-ctx="share"]')
    labels=pg.eval_on_selector_all('[data-ctx]','e=>e.map(x=>x.textContent.trim())')
    ck('track menu has "Copy song link" and no "Share link"', 'Copy song link' in labels and 'Share link' not in labels, labels)
    pg.click('[data-ctx="share"]'); pg.wait_for_timeout(300)
    clip=pg.evaluate('navigator.clipboard.readText()')
    ck('clipboard holds a song link (#/track/<id>), not an album link', clip==f'{BASE}/#/track/{tid}', clip)
    ck('the menu closes after copying', pg.query_selector('.ctx-menu') is None)
    ck('toast says "Song link copied"', 'Song link copied' in pg.inner_text('body'))
    # open that link in a fresh tab: it is a page about THIS song
    full=ctx.request.get(API+f'/tracks/{tid}').json()['track']
    p2=ctx.new_page(); p2.goto(clip); p2.wait_for_selector('.detail-header h1',timeout=8000); p2.wait_for_timeout(500)
    ck('the song link stays on its own page (#/track/<id>), no redirect', p2.url==clip, p2.url)
    ck('the page names the song', p2.inner_text('.detail-header h1').strip()==full['title'], p2.inner_text('.detail-header h1'))
    ck('it says "Song", the artist and the album', 'Song' in p2.inner_text('.detail-header .kind') and full['artist']['name'] in p2.inner_text('.detail-header .facts') and (not full['album'] or full['album']['title'] in p2.inner_text('.detail-header .facts')), p2.inner_text('.detail-header .facts'))
    ck('the cover is the song\'s cover', p2.get_attribute('.detail-header .cover img','src')==full['cover'])
    ck('the song row is listed with its own play/like/menu', p2.query_selector(f'.trow[data-id="{tid}"] [data-more]') is not None and p2.query_selector(f'.trow[data-id="{tid}"] [data-like]') is not None)
    gap=p2.evaluate('(()=>{const c=document.querySelector(".detail-header .cover").getBoundingClientRect().left;const r=document.querySelector(".single-row .trow-cover").getBoundingClientRect().left;return r-c})()')
    ck('the song row has no empty number gap (its cover lines up with the big cover, within 16px)', 0<=gap<=16, gap)
    p2.click('#play-song'); p2.wait_for_timeout(1200)
    cur=p2.evaluate('(async()=>(await import("/js/player.js")).player.current?.id)()')
    ck('the big play button plays this song', cur==tid, cur)
    if full.get('has_lyrics'): ck('lyrics are shown when the song has them', p2.query_selector('#song-lyrics pre') is not None)
    # a song with NO album (standalone single): still its own page, naming the song, not the artist page
    def noalbum(route):
        r=route.fetch(); d=r.json(); d['track']['album']=None; route.fulfill(response=r, json=d)
    p4=ctx.new_page(); p4.route(f'**/api/v1/tracks/{tid}', noalbum); p4.goto(clip); p4.wait_for_selector('.detail-header h1',timeout=8000)
    ck('standalone song (no album): still the song page, not the artist page', p4.url==clip and p4.inner_text('.detail-header h1').strip()==full['title'] and '/artist/' not in p4.url, p4.url)
    ck('standalone song: shows artist, no album link', full['artist']['name'] in p4.inner_text('.detail-header .facts') and p4.query_selector('.detail-header .facts a[href^="#/album/"]') is None)
    p2.go_back(); p2.wait_for_timeout(400)
    # a track whose id does not exist
    p2.goto(BASE+'/#/track/000000000000000000000000'); p2.wait_for_timeout(1500)
    ck('unknown song link shows a clear "not available" page', 'not available' in p2.inner_text('#view'), p2.inner_text('#view')[:80])
    # episodes
    if eps:
        e=eps[0]
        pg.goto(BASE+f'/#/show/{e["show"]["id"]}'); pg.wait_for_selector('.erow'); pg.wait_for_timeout(500)
        pg.query_selector(f'.erow[data-id="{e["id"]}"]').click(button='right'); pg.wait_for_selector('[data-ctx="share"]')
        lab=pg.eval_on_selector_all('[data-ctx]','x=>x.map(y=>y.textContent.trim())')
        ck('episode menu: "Copy episode link"', 'Copy episode link' in lab, lab)
        pg.click('[data-ctx="share"]'); pg.wait_for_timeout(300)
        clip=pg.evaluate('navigator.clipboard.readText()')
        ck('episode link is #/episode/<id>', clip==f'{BASE}/#/episode/{e["id"]}', clip)
        p3=ctx.new_page(); p3.goto(clip); p3.wait_for_selector('.detail-header h1',timeout=8000)
        ep=ctx.request.get(API+f'/episodes/{e["id"]}').json()['episode']
        ck('episode link opens the episode\'s own page, naming it', p3.url==clip and p3.inner_text('.detail-header h1').strip()==ep['title'], p3.url)
        ck('it says "Episode", the show, and shows the description', 'Episode' in p3.inner_text('.detail-header .kind') and ep['show']['title'] in p3.inner_text('.detail-header .facts') and (ep['description'][:20] in p3.inner_text('#view')), p3.inner_text('.detail-header .facts'))
        p3.click('#play-ep'); p3.wait_for_timeout(1200)
        ck('its play button plays this episode', p3.evaluate('(async()=>(await import("/js/player.js")).player.current?.id)()')==e['id'])
    # signed-out visitor: not logged in
    anon=b.new_context(); a=anon.new_page(); a.goto(BASE+f'/#/track/{tid}'); a.wait_for_timeout(2500)
    ck('signed out: the link does not break the page (shows sign-in)', a.query_selector('.auth-card, .auth-screen') is not None, a.url)
    ck('no page errors', not errs, errs)
    b.close()
print(f'\n{ok} passed, {bad} failed'); raise SystemExit(1 if bad else 0)
