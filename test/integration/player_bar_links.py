"""Names in the player bar: every credited artist is a link to their page; a name too long for the space glides sideways so it can be
read in full (phone, tablet, desktop); with animations off it is a plain ellipsis. bash test/integration/runpf.sh test/integration/player_bar_links.py"""
from playwright.sync_api import sync_playwright
BASE='http://127.0.0.1:3000'; API=BASE+'/api/v1'
ok=bad=0
def ck(n,c,x=''):
    global ok,bad
    ok+=bool(c); bad+=not c; print(('PASS ' if c else 'FAIL ')+n+('' if c else ' '+str(x)))
PL='import("/js/player.js").then(m=>m.player)'
LONG_T='A Very Long Song Title That Keeps Going And Going Well Past Any Reasonable Width Of The Bar'
with sync_playwright() as p:
    b=p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
    ctx=b.new_context(viewport={'width':1366,'height':800}); ctx.request.post(API+'/auth/login',data={'login':'admin@aurelune.local','password':'aurelune-admin'})
    home=ctx.request.get(API+'/home').json(); tr=home['trending']; arts=home['artists']
    pg=ctx.new_page(); pg.goto(BASE+'/'); pg.wait_for_selector('#app'); pg.wait_for_timeout(800)
    def play_long(short=False):
        it=dict(tr[0]); a=dict(it['artist'])
        if not short:
            it['title']=LONG_T; a['name']='The Extraordinarily Long Named Principal Artist'
            it['collaborators']=[{'id':arts[0]['id'],'name':'Featured Guest With Another Very Long Name','status':'accepted','slug':arts[0].get('slug')},{'id':arts[1]['id'],'name':'Third Collaborator','status':'accepted'},{'id':'x1','name':'Pending Person','status':'pending'}]
        it['artist']=a
        pg.evaluate('(it)=>import("/js/player.js").then(m=>m.player.playQueue([it],0))',it); pg.wait_for_timeout(1200)
        return it
    it=play_long()
    # ---- links
    links=pg.evaluate('[...document.querySelectorAll("#player-bar .pnow-text .s a")].map(a=>[a.textContent.trim(),a.getAttribute("href")])')
    ck('bar lists the artist and the accepted collaborators as links (pending one is not shown)', len(links)==3 and all(h.startswith('#/artist/') for _,h in links) and not any('Pending' in t for t,_ in links), links)
    ck('title links to the album', pg.evaluate('document.querySelector("#player-bar .pnow-text .t a")?.getAttribute("href")')==f"#/album/{it['album']['id']}", pg.evaluate('document.querySelector("#player-bar .pnow-text .t")?.innerHTML'))
    pg.evaluate('document.querySelector("#player-bar .pnow-text .s a:nth-child(2), #player-bar .pnow-text .s a").click()'); pg.wait_for_timeout(700)
    ck('clicking a name opens that artist page', pg.evaluate('location.hash').startswith('#/artist/'), pg.evaluate('location.hash'))
    # ---- marquee
    for w,label in ((1366,'desktop'),(900,'tablet'),(768,'tablet (narrow)'),(390,'phone')):
        pg.set_viewport_size({'width':w,'height':800}); pg.wait_for_timeout(700)
        n=pg.evaluate('document.querySelectorAll("#player-bar .pnow-text .mq-run").length')
        ck(f'{label} {w}px: the long title and the long names both glide (2 elements animating)', n==2, n)
        vis=pg.evaluate('(()=>{const t=document.querySelector("#player-bar .pnow-text .t");const r=t.getBoundingClientRect();return {w:r.width,right:r.right,bar:document.querySelector("#player-bar").getBoundingClientRect().right}})()')
        ck(f'{label}: the title box stays inside the bar and has room', vis['w']>=80 and vis['right']<=vis['bar']+1, vis)
        pg.evaluate('document.querySelector("#player-bar .pnow-text .t").style.setProperty("--mq-dur","3s")')   # same keyframes, just quicker to sample
        pg.wait_for_timeout(300)
        x1=pg.evaluate('new DOMMatrix(getComputedStyle(document.querySelector("#player-bar .pnow-text .t .mq-in")).transform).m41'); pg.wait_for_timeout(1300)
        x2=pg.evaluate('new DOMMatrix(getComputedStyle(document.querySelector("#player-bar .pnow-text .t .mq-in")).transform).m41')
        d=pg.evaluate('parseFloat(getComputedStyle(document.querySelector("#player-bar .pnow-text .t")).getPropertyValue("--mq-dist"))')
        ck(f'{label}: it is really moving ({x1:.0f} -> {x2:.0f}px) and ends past the last letter (distance {d:.0f}px)', x1!=x2 and d<-20, (x1,x2,d))
    # the end of the slide shows the last letters
    pg.set_viewport_size({'width':1366,'height':800}); pg.wait_for_timeout(500)
    end=pg.evaluate('(()=>{const t=document.querySelector("#player-bar .pnow-text .t");const i=t.querySelector(".mq-in");i.style.animation="none";i.style.transform="translateX("+getComputedStyle(t).getPropertyValue("--mq-dist")+")";const a=i.getBoundingClientRect(),c=t.getBoundingClientRect();return {innerRight:a.right,boxRight:c.right}})()')
    ck('at the end of the slide the last letter is inside the box', end['innerRight']<=end['boxRight']+1, end)
    # short names don't animate
    play_long(short=True); pg.wait_for_timeout(500)
    ck('a name that fits is left alone (no animation)', pg.evaluate('document.querySelectorAll("#player-bar .pnow-text .mq-run").length')==0)
    # phone: tapping the title opens the full player, tapping a name goes to the artist
    play_long(); pg.set_viewport_size({'width':390,'height':800}); pg.wait_for_timeout(700)
    pg.evaluate('document.querySelector("#player-bar .pnow-text .t a").click()'); pg.wait_for_timeout(600)
    ck('phone: tapping the title opens the full player (not the album)', pg.locator('#full-player').count()==1)
    nm=pg.evaluate('document.querySelectorAll("#full-player .fp-meta-text .mq-run").length')
    ck('phone full player: long title and names glide too', nm==2, nm)
    ck('phone full player: names are links', pg.evaluate('document.querySelectorAll("#full-player .fp-by a").length')==3)
    pg.screenshot(path='/tmp/pw/fp_long.png')
    pg.evaluate('document.getElementById("fp-close").click()'); pg.wait_for_timeout(500)
    pg.screenshot(path='/tmp/pw/bar_phone_long.png',clip={'x':0,'y':600,'width':390,'height':200})
    # ---- animations off
    pg.set_viewport_size({'width':1366,'height':800}); pg.wait_for_timeout(400)
    pg.evaluate('document.documentElement.classList.add("no-anim")'); play_long(); pg.wait_for_timeout(500)
    ck('animations off: nothing glides, text is clipped with an ellipsis and the full name is in the tooltip', pg.evaluate('document.querySelectorAll("#player-bar .mq-run").length')==0 and 'Extraordinarily' in (pg.evaluate('document.querySelector("#player-bar .pnow-text .s").title') or ''))
    b.close()
print(f'\n{ok} passed, {bad} failed'); raise SystemExit(1 if bad else 0)
