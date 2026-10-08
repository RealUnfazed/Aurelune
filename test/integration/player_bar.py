"""Player bar at phone/tablet/desktop widths: nothing overlaps, the title keeps room, podcast episodes get shuffle, repeat and +/-15 s.
   bash test/integration/runpf.sh test/integration/player_bar.py   (or any server with the demo data)"""
from playwright.sync_api import sync_playwright
BASE='http://127.0.0.1:3000'; API=BASE+'/api/v1'
ok=bad=0
def ck(n,c,x=''):
    global ok,bad
    ok+=bool(c); bad+=not c; print(('PASS ' if c else 'FAIL ')+n+('' if c else ' '+str(x)))
PL='import("/js/player.js").then(m=>m.player)'
with sync_playwright() as p:
    b=p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
    ctx=b.new_context(viewport={'width':1366,'height':800}); ctx.request.post(API+'/auth/login',data={'login':'admin@aurelune.local','password':'aurelune-admin'})
    home=ctx.request.get(API+'/home').json()
    eps=home.get('new_episodes') or []; tracks=home['trending']
    assert tracks, 'no demo tracks'
    pg=ctx.new_page(); pg.goto(BASE+'/'); pg.wait_for_selector('#app'); pg.wait_for_timeout(800)
    def rects():
        return pg.evaluate('''()=>{const r=s=>{const e=document.querySelector(s);if(!e)return null;const b=e.getBoundingClientRect();return {l:b.left,r:b.right,t:b.top,b:b.bottom,w:b.width,h:b.height,vis:getComputedStyle(e).display!=='none'&&getComputedStyle(e).visibility!=='hidden'}};
          return {bar:r('#player-bar'),now:r('.pnow'),cover:r('.pnow-cover'),text:r('.pnow-text'),title:r('.pnow-text .t'),like:r('#bar-like'),center:r('.pcenter'),trans:r('.ptransport'),cur:r('#p-cur'),dur:r('#p-dur'),right:r('.pright'),vol:r('.pvol'),
                  back:r('#p-back'),fwd:r('#p-fwd'),shuf:r('#p-shuffle'),rep:r('#p-repeat'),seek:r('.pseek')}}''')
    def overlap(a,c): return a and c and a['vis'] and c['vis'] and a['l']<c['r']-0.5 and c['l']<a['r']-0.5 and a['t']<c['b'] and c['t']<a['b']
    def check(label, kind):
        R=rects()
        ck(f'{label}: bar visible', R['bar'] and R['bar']['h']>40, R['bar'])
        ck(f'{label}: cover does not run into the transport/time', not overlap(R['cover'],R['center']) and not overlap(R['cover'],R['cur']), (R['cover'],R['center']))
        ck(f'{label}: left block, centre and right block do not overlap', not overlap(R['now'],R['center']) and not overlap(R['center'],R['right']) and not overlap(R['now'],R['right']), [R['now'],R['center'],R['right']])
        ck(f'{label}: title keeps room to read (>=90 px)', R['title']['w']>=90, R['title'])
        ck(f'{label}: everything inside the bar', all(R[k]['l']>=R['bar']['l']-1 and R[k]['r']<=R['bar']['r']+1 for k in ('now','center','right')), R['bar'])
        ck(f'{label}: seek row (times + bar) is inside the centre column and the bar is usable (>=120 px)', R['seek']['w']>=200, R['seek'])
        ck(f'{label}: shuffle and repeat are on screen', R['shuf'] and R['rep'] and R['shuf']['vis'] and R['rep']['vis'] and R['shuf']['l']>=R['bar']['l'] and R['rep']['r']<=R['bar']['r'], (R['shuf'],R['rep']))
        if kind=='ep':
            ck(f'{label}: episode has back-15 and forward-15', R['back'] and R['fwd'] and R['back']['vis'] and R['fwd']['vis'], (R['back'],R['fwd']))
            ck(f'{label}: episode transport fits the centre column', R['trans']['l']>=R['center']['l']-1 and R['trans']['r']<=R['center']['r']+1, (R['trans'],R['center']))
        else:
            ck(f'{label}: song has no 15-second buttons', R['back'] is None and R['fwd'] is None)
    for w in (721, 768, 820, 900, 1024, 1099, 1180, 1366):
        pg.set_viewport_size({'width':w,'height':800})
        for kind,items in (('song',tracks),('ep',eps)):
            if not items: continue
            pg.evaluate('(l)=>import("/js/player.js").then(m=>m.player.playQueue(l,0))',items[:3]); pg.wait_for_timeout(900)
            check(f'{w}px {kind}',kind)
            pg.screenshot(path=f'/tmp/pw/bar_{kind}_{w}.png',clip={'x':0,'y':700,'width':w,'height':100})
    if eps:
        pg.set_viewport_size({'width':1366,'height':800})
        pg.evaluate('(l)=>import("/js/player.js").then(m=>m.player.playQueue(l,0))',eps[:3]); pg.wait_for_timeout(1500)
        pg.evaluate(PL+'.then(p=>p.seekTo(40))'); pg.wait_for_timeout(500)
        t0=pg.evaluate(PL+'.then(p=>p.position)')
        pg.click('#p-fwd'); pg.wait_for_timeout(400); t1=pg.evaluate(PL+'.then(p=>p.position)')
        ck('forward 15 s moves ~15 s ahead (%.1f -> %.1f)'%(t0,t1), 14<=t1-t0<=17, (t0,t1))
        pg.click('#p-back'); pg.wait_for_timeout(400); t2=pg.evaluate(PL+'.then(p=>p.position)')
        ck('back 15 s moves ~15 s back (%.1f)'%t2, 14<=t1-t2<=17, (t1,t2))
        pg.evaluate(PL+'.then(p=>p.seekTo(3))'); pg.wait_for_timeout(400); pg.click('#p-back'); pg.wait_for_timeout(400)
        ck('back 15 s near the start stops at 0, not negative', pg.evaluate(PL+'.then(p=>p.position)')<2)
        pg.click('#p-shuffle'); ck('shuffle works for episodes', pg.evaluate(PL+'.then(p=>p.shuffle)')); pg.click('#p-shuffle')
        pg.click('#p-repeat'); ck('repeat works for episodes', pg.evaluate(PL+'.then(p=>p.repeat)')=='all'); pg.click('#p-repeat'); pg.click('#p-repeat')
        # phone full player
        pg.set_viewport_size({'width':390,'height':800}); pg.wait_for_timeout(400)
        pg.click('.pnow-text'); pg.wait_for_selector('#full-player',timeout=4000)
        ck('phone full player (episode): shuffle + repeat + back/forward 15', all(pg.locator(s).count()==1 for s in ('#fp-shuffle','#fp-repeat','#fp-back','#fp-fwd')))
        pg.wait_for_timeout(700); pg.screenshot(path='/tmp/pw/fp_ep.png')
        fb=pg.evaluate('(()=>{const b=document.getElementById("fp-fwd").getBoundingClientRect();const e=document.querySelector(".fp-extras").getBoundingClientRect();return {bottom:b.bottom,extrasTop:e.top,vh:innerHeight,extrasBottom:e.bottom}})()')
        ck('phone full player: the 15 s row and the shortcuts fit on screen', fb['bottom']<=fb['extrasTop']+1 and fb['extrasBottom']<=fb['vh']+1, fb)
        pg.set_viewport_size({'width':360,'height':620}); pg.wait_for_timeout(500)
        fb=pg.evaluate('(()=>{const b=document.getElementById("fp-fwd").getBoundingClientRect();const e=document.querySelector(".fp-extras").getBoundingClientRect();return {bottom:b.bottom,extrasTop:e.top,vh:innerHeight,extrasBottom:e.bottom}})()')
        ck('small phone (360x620): still fits', fb['bottom']<=fb['extrasTop']+1 and fb['extrasBottom']<=fb['vh']+1, fb)
        pg.screenshot(path='/tmp/pw/fp_ep_small.png'); pg.set_viewport_size({'width':390,'height':800}); pg.wait_for_timeout(400)
        t0=pg.evaluate(PL+'.then(p=>p.position)'); pg.click('#fp-fwd'); pg.wait_for_timeout(400); t1=pg.evaluate(PL+'.then(p=>p.position)')
        ck('phone: forward 15 s', 14<=t1-t0<=17, (t0,t1))
    b.close()
print(f'\n{ok} passed, {bad} failed'); raise SystemExit(1 if bad else 0)
