"""Player + settings UI checks: animations switch, seek hover box, seeking doesn't jump to 0, Range edge cases,
phone full-screen player.  Needs the app server on :3000 (seeded demo data)."""
from playwright.sync_api import sync_playwright
BASE='http://127.0.0.1:3000'; API=BASE+'/api/v1'
ok=bad=0
def ck(n,c,x=''):
    global ok,bad
    ok+=bool(c); bad+=not c; print(('PASS ' if c else 'FAIL ')+n+('' if c else ' '+str(x)))
PL='import("/js/player.js").then(m=>m.player)'
with sync_playwright() as p:
    b=p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])

    # ---------------- animations: default ON even when the OS asks for reduced motion
    ctx=b.new_context(viewport={'width':1366,'height':800}, reduced_motion='reduce')
    r=ctx.request.post(API+'/auth/login',data={'login':'admin@aurelune.local','password':'aurelune-admin'}); assert r.ok
    me=ctx.request.get(API+'/session').json()['user']
    ck('animations default true on the account', me.get('animations') is True, me.get('animations'))
    pg=ctx.new_page(); pg.goto(BASE+'/'); pg.wait_for_selector('[data-play-card]',timeout=20000)
    ck('OS reduced-motion does NOT disable animations', not pg.evaluate('document.documentElement.classList.contains("no-anim")'))
    ck('transitions keep their duration', pg.evaluate('parseFloat(getComputedStyle(document.querySelector(".search-box")).transitionDuration)')>0.01)
    pg.goto(BASE+'/#/settings/appearance'); pg.wait_for_selector('#s-anim',timeout=10000)
    ck('switch shows ON', pg.evaluate('document.getElementById("s-anim").classList.contains("on")'))
    pg.click('#s-anim', force=True); pg.wait_for_timeout(700)
    ck('turning it off adds no-anim at once', pg.evaluate('document.documentElement.classList.contains("no-anim")'))
    ck('...and kills transitions', pg.evaluate('parseFloat(getComputedStyle(document.querySelector(".search-box")).transitionDuration)')<0.01)
    ck('saved on the account', ctx.request.get(API+'/session').json()['user']['animations'] is False)
    ck('mirrored to localStorage', pg.evaluate('localStorage.getItem("aur_anim")')=='0')
    pg.reload(); pg.wait_for_selector('#s-anim',timeout=10000); pg.wait_for_timeout(300)
    ck('stays off after reload', pg.evaluate('document.documentElement.classList.contains("no-anim")'))
    pg.click('#s-anim', force=True); pg.wait_for_timeout(700)
    ck('turning it back on removes no-anim', not pg.evaluate('document.documentElement.classList.contains("no-anim")'))
    ck('account back to true', ctx.request.get(API+'/session').json()['user']['animations'] is True)
    ctx.close()

    # ---------------- desktop player: hover box + seeking
    ctx=b.new_context(viewport={'width':1366,'height':800})
    ctx.request.post(API+'/auth/login',data={'login':'admin@aurelune.local','password':'aurelune-admin'})
    pg=ctx.new_page(); pg.goto(BASE+'/'); pg.wait_for_selector('[data-play-card]',timeout=20000)
    pg.hover('[data-play-card] >> nth=0'); pg.click('button.play-overlay >> nth=0')
    pg.wait_for_function('import("/js/player.js").then(m=>m.player.durationSec>5)' if False else '1', timeout=1000)
    pg.wait_for_timeout(2500)
    dur=pg.evaluate(PL+'.then(p=>p.durationSec)')
    ck('has a duration', dur>5, dur)
    box=pg.locator('#p-bar').bounding_box()
    pg.mouse.move(box['x']+box['width']*0.5, box['y']+2); pg.wait_for_timeout(200)
    tip=pg.locator('.seek-tip.show')
    ck('hover box appears', tip.count()==1)
    txt=tip.inner_text() if tip.count() else ''
    exp=pg.evaluate('(d)=>{const s=Math.floor(d*0.5);return Math.floor(s/60)+":"+String(s%60).padStart(2,"0")}',dur)
    ck('hover box shows time under the mouse ('+txt+' ~ '+exp+')', txt.strip()==exp or abs(sum(int(x)*m for x,m in zip(reversed(txt.split(':')),(1,60,3600)))-dur*0.5)<=1.5, txt)
    tb=tip.bounding_box()
    ck('box sits right above the pointer', abs((tb['x']+tb['width']/2)-(box['x']+box['width']*0.5))<4 and tb['y']+tb['height']<=box['y'], tb)
    pg.mouse.move(box['x']+box['width']*0.1, box['y']+2); pg.wait_for_timeout(150)
    t2=pg.locator('.seek-tip.show').inner_text()
    ck('box follows the pointer', t2!=txt, (t2,txt))
    pg.mouse.move(box['x']+box['width']*0.5, box['y']-80); pg.wait_for_timeout(200)
    ck('box hides on leave', pg.locator('.seek-tip.show').count()==0)
    pg.mouse.move(box['x']+box['width']*0.7, box['y']+2); pg.wait_for_timeout(100)
    # volume bar has no box
    vb=pg.locator('#v-bar').bounding_box(); pg.mouse.move(vb['x']+vb['width']/2, vb['y']+2); pg.wait_for_timeout(150)
    ck('no box on the volume bar', pg.locator('.seek-tip.show').count()==0)

    # Storage: songs held in memory can be freed; browser cache clear endpoint; stream-mode switch
    pg.click('#avatar-btn'); pg.click('.avatar-menu a[href="#/settings/storage"]'); pg.wait_for_selector('#st-mem',timeout=8000)
    ck('profile menu -> Storage & cache page', 'Storage' in pg.inner_text('.tabs, body'))
    ck('shows the song held in memory', 'song' in pg.inner_text('#st-mem'), pg.inner_text('#st-mem'))
    r=ctx.request.post(API+'/me/clear-cache'); ck('clear-cache endpoint sends Clear-Site-Data', r.status==204 and r.headers.get('clear-site-data')=='"cache"', (r.status,r.headers))
    pg.on('request',lambda q: None)
    pg.click('#st-clear-all'); pg.wait_for_timeout(800)
    ck('Clear cache keeps the playing song playing', pg.evaluate(PL+'.then(p=>!!p.isPlaying)'))
    pg.click('#st-stream'); pg.wait_for_timeout(300)
    ck('stream-mode switch is remembered', pg.evaluate('localStorage.getItem("aur_stream_mode")')=='stream' and pg.evaluate(PL+'.then(p=>p.cacheInfo().streamMode)'))
    pg.click('#st-stream'); pg.wait_for_timeout(300)
    ck('...and can be turned back off', pg.evaluate('localStorage.getItem("aur_stream_mode")')is None and not pg.evaluate(PL+'.then(p=>p.cacheInfo().streamMode)'))
    pg.click('#pt-run'); pg.wait_for_function('document.getElementById("pt-run").textContent.includes("again")',timeout=90000)
    ck('playback test runs from the Storage page', 'Done.' in pg.inner_text('#pt-out'))
    pg.evaluate('location.hash="#/"'); pg.wait_for_timeout(600)
    # side panel is a column that shrinks the page (wide screens)
    mw=lambda: pg.evaluate('document.querySelector(".main-col").getBoundingClientRect().width')
    w0=mw(); pg.click('#p-queue'); pg.wait_for_timeout(600)
    w1=mw(); sp=pg.evaluate('(()=>{const r=document.getElementById("now-playing-panel").getBoundingClientRect(),m=document.querySelector(".main-col").getBoundingClientRect(),pb=document.getElementById("player-bar").getBoundingClientRect();return {l:r.left,r:r.right,w:r.width,b:r.bottom,mr:m.right,pt:pb.top,vw:innerWidth}})')
    ck('open panel makes the page narrower (%d -> %d)'%(w0,w1), w1<w0-300, (w0,w1))
    ck('panel sits beside the page, not over it', sp['l']>=sp['mr'], sp)
    ck('panel ends above the player bar and inside the window', sp['b']<=sp['pt']+1 and sp['r']<=sp['vw'], sp)
    pg.screenshot(path='/tmp/pw/sidepanel.png')
    pg.click('#np-close'); pg.wait_for_timeout(600)
    ck('closing gives the width back', abs(mw()-w0)<2, (mw(),w0))
    ck('closed panel is invisible and can\'t catch clicks', pg.evaluate('(()=>{const e=document.elementFromPoint(innerWidth-30,300);return !e.closest("#now-playing-panel")})()'))
    # a narrower window keeps the old overlay behaviour
    pg.set_viewport_size({'width':1000,'height':800}); pg.wait_for_timeout(300)
    wn=mw(); pg.click('#p-queue'); pg.wait_for_timeout(500)
    ck('under 1100px the panel overlays instead of squeezing the page', abs(mw()-wn)<2 and pg.evaluate('document.getElementById("now-playing-panel").getBoundingClientRect().right')<=1000, (mw(),wn))
    pg.click('#np-close'); pg.wait_for_timeout(400); pg.set_viewport_size({'width':1366,'height':800}); pg.wait_for_timeout(300)
    # click-seek, then next/prev behaviour
    pg.mouse.click(box['x']+box['width']*0.5, box['y']+2); pg.wait_for_timeout(1200)
    ct=pg.evaluate(PL+'.then(p=>p.audio.currentTime)')
    ck('click seeks near 50%', abs(ct-dur*0.5)<3, (ct,dur))
    pg.evaluate(PL+'.then(p=>p.seekTo(p.durationSec*0.8))'); pg.wait_for_timeout(1200)
    ct=pg.evaluate(PL+'.then(p=>p.audio.currentTime)')
    ck('seek to 80% stays there (no jump to 0)', ct>dur*0.75, (ct,dur))
    # several quick seeks
    for f in (0.2,0.6,0.35):
        pg.evaluate('f=>import("/js/player.js").then(m=>m.player.seekFraction(f))',f); pg.wait_for_timeout(500)
    ct=pg.evaluate(PL+'.then(p=>p.audio.currentTime)')
    ck('rapid seeks end at last target', abs(ct-dur*0.35)<3, (ct,dur))

    # Range edge cases on the media endpoint
    tid=pg.evaluate(PL+'.then(p=>p.current.id)')
    url=BASE+'/api/v1/stream/track/'+str(tid)
    r0=ctx.request.get(url,headers={'Range':'bytes=0-1'}); total=int(r0.headers.get('content-range','/0').split('/')[-1] or 0)
    ck('range 0-1 -> 206', r0.status==206, r0.status)
    r1=ctx.request.get(url,headers={'Range':f'bytes={total-10}-{total+5000}'})
    ck('range past EOF is clamped, not 416', r1.status==206 and len(r1.body())==10, (r1.status,len(r1.body())))
    r2=ctx.request.get(url,headers={'Range':'bytes=-100'})
    ck('suffix range returns the last 100 bytes', r2.status==206 and len(r2.body())==100, (r2.status,len(r2.body())))
    r3=ctx.request.get(url,headers={'Range':f'bytes={total+10}-'})
    ck('start beyond EOF -> 416', r3.status==416, r3.status)

    # previous button
    pg.evaluate(PL+'.then(p=>{p.seekTo(0)})')
    items=ctx.request.get(API+'/search?q=a').json()['tracks'][:4]
    pg.evaluate('(its)=>import("/js/player.js").then(m=>m.player.playQueue(its,0))',items); pg.wait_for_timeout(800)
    n=pg.evaluate(PL+'.then(p=>p.queue.length)')
    ck('queue of several tracks', n>=3, n)
    if n>2:
        pg.evaluate(PL+'.then(p=>p.next())'); pg.wait_for_timeout(600)
        i1=pg.evaluate(PL+'.then(p=>p.index)')
        pg.evaluate(PL+'.then(p=>p.seekTo(15))'); pg.wait_for_timeout(500)
        pg.click('#p-prev'); pg.wait_for_timeout(700)
        ck('...and the new song starts at 0', pg.evaluate(PL+'.then(p=>p.audio.currentTime)')<3)
        i2=pg.evaluate(PL+'.then(p=>p.index)')
        ck('Previous always goes to the previous song', i2==i1-1, (i1,i2))
    ctx.close()

    # ---------------- phone: full-screen player
    ctx=b.new_context(viewport={'width':390,'height':780}, has_touch=True, is_mobile=True)
    ctx.request.post(API+'/auth/login',data={'login':'admin@aurelune.local','password':'aurelune-admin'})
    pg=ctx.new_page(); pg.goto(BASE+'/'); pg.wait_for_selector('[data-play-card]',timeout=20000)
    pg.evaluate('import("/js/player.js").then(async m=>{const r=await fetch("/api/v1/tracks?limit=6").then(r=>r.json()).catch(()=>null);})')
    pg.locator('[data-play-card]').first.scroll_into_view_if_needed()
    pg.locator('[data-play-card] button.play-overlay').first.click(force=True)
    pg.wait_for_selector('#p-toggle-m',timeout=10000); pg.wait_for_timeout(1500)
    ck('mini bar has no repeat button', pg.locator('#p-repeat:visible').count()==0)
    pg.tap('.pnow-text'); pg.wait_for_selector('#full-player',timeout=3000); pg.wait_for_timeout(500)
    ck('tapping mini player opens the full player', pg.locator('#full-player').is_visible())
    for sel,name in (('#fp-shuffle','shuffle'),('#fp-prev','previous'),('#fp-toggle','play/pause'),('#fp-next','next'),('#fp-repeat','repeat'),('#fp-like','like'),('#fp-lyrics','lyrics'),('#fp-sound','sound'),('#fp-queue','queue'),('#fp-bar','seek bar')):
        ck('full player has '+name, pg.locator(sel).is_visible())
    box=pg.locator('#fp-bar').bounding_box()
    ck('everything fits on screen (no horizontal scroll)', pg.evaluate('document.documentElement.scrollWidth<=innerWidth'))
    fbot=pg.evaluate('(()=>{const r=document.getElementById("fp-queue").getBoundingClientRect();return r.bottom})()')
    ck('bottom row inside the viewport', fbot<=780, fbot)
    # repeat cycles
    r0=pg.evaluate(PL+'.then(p=>p.repeat)'); pg.tap('#fp-repeat'); pg.wait_for_timeout(200)
    r1=pg.evaluate(PL+'.then(p=>p.repeat)'); ck('repeat button cycles ('+r0+'→'+r1+')', r0!=r1)
    pg.tap('#fp-repeat'); pg.tap('#fp-repeat'); pg.wait_for_timeout(200)
    ck('repeat back to off after 3 taps', pg.evaluate(PL+'.then(p=>p.repeat)')==r0)
    pg.tap('#fp-shuffle'); pg.wait_for_timeout(200)
    ck('shuffle toggles', pg.evaluate(PL+'.then(p=>p.shuffle)') is True and pg.evaluate('document.getElementById("fp-shuffle").classList.contains("on")'))
    pg.tap('#fp-shuffle')
    # play/pause
    was=pg.evaluate(PL+'.then(p=>!!p.isPlaying)'); pg.tap('#fp-toggle'); pg.wait_for_timeout(400)
    ck('play/pause works', pg.evaluate(PL+'.then(p=>!!p.isPlaying)')!=was)
    pg.tap('#fp-toggle'); pg.wait_for_timeout(300)
    # seek by tap
    dur=pg.evaluate(PL+'.then(p=>p.durationSec)')
    pg.touchscreen.tap(box['x']+box['width']*0.6, box['y']+2); pg.wait_for_timeout(1000)
    ct=pg.evaluate(PL+'.then(p=>p.audio.currentTime)')
    ck('tap on seek bar seeks', abs(ct-dur*0.6)<3, (ct,dur))
    ck('time labels update', pg.inner_text('#fp-cur')!='0:00')
    # swipe down closes
    pg.evaluate('''()=>{const el=document.getElementById("full-player");const t=(y)=>new Touch({identifier:1,target:el.querySelector(".fp-art"),clientX:150,clientY:y});
      const tgt=el.querySelector(".fp-art");
      tgt.dispatchEvent(new TouchEvent("touchstart",{touches:[t(200)],bubbles:true}));
      tgt.dispatchEvent(new TouchEvent("touchmove",{touches:[t(380)],bubbles:true}));
      tgt.dispatchEvent(new TouchEvent("touchend",{touches:[],bubbles:true}));}''')
    pg.wait_for_timeout(300)
    ck('swiping down closes it', pg.locator('#full-player').count()==0)
    # reopen, queue shortcut opens the queue panel
    pg.tap('.pnow-text'); pg.wait_for_selector('#full-player'); pg.wait_for_timeout(400)
    pg.tap('#fp-queue'); pg.wait_for_timeout(500)
    ck('queue shortcut closes the sheet and opens the queue', pg.locator('#full-player').count()==0 and pg.evaluate('document.getElementById("now-playing-panel").classList.contains("open")'))
    pg.tap('#np-close'); pg.wait_for_timeout(300)
    pg.tap('.pnow-text'); pg.wait_for_selector('#full-player'); pg.wait_for_timeout(400)
    pg.tap('#fp-sound'); pg.wait_for_timeout(600)
    ck('sound shortcut goes to the sound settings', pg.locator('#full-player').count()==0 and 'settings/sound' in pg.url, pg.url)
    # tapping the heart in the mini bar must NOT open the sheet
    pg.tap('#bar-like'); pg.wait_for_timeout(400)
    ck('tapping the mini like button does not open the sheet', pg.locator('#full-player').count()==0)
    pg.screenshot(path='/tmp/pw/mini.png')
    pg.tap('.pnow-text'); pg.wait_for_selector('#full-player'); pg.wait_for_timeout(500)
    pg.screenshot(path='/tmp/pw/fullplayer.png')
    # podcast episode: shuffle + repeat like songs, plus back 15 / forward 15
    eps=ctx.request.get(API+'/search?q=a').json().get('episodes') or []
    if eps:
        pg.tap('#fp-close') if pg.locator('#fp-close').count() else None
        pg.evaluate('(its)=>import("/js/player.js").then(m=>m.player.playQueue(its,0))',eps[:1]); pg.wait_for_timeout(900)
        pg.tap('.pnow-text'); pg.wait_for_selector('#full-player'); pg.wait_for_timeout(300)
        ck('episode: back-15, forward-15, shuffle and repeat all shown', pg.locator('#fp-back').is_visible() and pg.locator('#fp-fwd').is_visible() and pg.locator('#fp-shuffle').is_visible() and pg.locator('#fp-repeat').is_visible())
        t0=pg.evaluate(PL+'.then(p=>{p.seekTo(5);return 5})'); pg.wait_for_timeout(600)
        pg.tap('#fp-fwd'); pg.wait_for_timeout(500)
        t1=pg.evaluate(PL+'.then(p=>p.audio.currentTime)')
        ck('forward 15 skips ~15s ('+str(round(t1))+')', abs(t1-20)<4, t1)
    else: print('SKIP episode checks (no episodes in the catalog)')
    # resize to desktop closes it
    pg.set_viewport_size({'width':1200,'height':780}); pg.wait_for_timeout(400)
    ck('widening to desktop closes the sheet', pg.locator('#full-player').count()==0)
    ctx.close()
    b.close()
print(f'\n{ok} passed, {bad} failed'); raise SystemExit(1 if bad else 0)
