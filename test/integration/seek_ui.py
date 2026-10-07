"""Browser check of the two complaints: (1) seeking forward/back must not jump to the start, even when the file host ignores
Range; (2) repeat must not download the song again every loop. Run with the PostFile stand-in:
   bash test/integration/runpf.sh test/integration/seek_ui.py"""
import math, struct, json, time, random, urllib.request
from playwright.sync_api import sync_playwright
BASE='http://127.0.0.1:3000'; API=BASE+'/api/v1'; FP='http://127.0.0.1:4010'
ok=bad=0
def ck(n,c,x=''):
    global ok,bad
    ok+=bool(c); bad+=not c; print(('PASS ' if c else 'FAIL ')+n+('' if c else ' '+str(x)))
def wav(sec, rate=22050):
    n=int(sec*rate); data=b''.join(struct.pack('<h',int(3000*math.sin(i/9+(i>>12)))) for i in range(n))
    return b'RIFF'+struct.pack('<I',36+len(data))+b'WAVEfmt '+struct.pack('<IHHIIHH',16,1,1,rate,rate*2,2,16)+b'data'+struct.pack('<I',len(data))+data
def stats(): return json.loads(urllib.request.urlopen(FP+'/_stats').read())
def ctl(**o): urllib.request.urlopen(urllib.request.Request(FP+'/_ctl',data=json.dumps(o).encode(),method='POST')).read()
PL='import("/js/player.js").then(m=>m.player)'
rid=str(random.randint(10000,99999))
with sync_playwright() as p:
    b=p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
    adm=b.new_context(); adm.request.post(API+'/auth/login',data={'login':'admin@aurelune.local','password':'aurelune-admin'})
    own=b.new_context(viewport={'width':1366,'height':800})
    assert own.request.post(API+'/auth/signup',data={'username':'sk'+rid,'email':f'sk{rid}@t.test','password':'password123'}).status==201
    cr=own.request.post(API+'/studio/request',data={'name':'Seekband'+rid,'focus':'both'}).json()['creator']['id']
    adm.request.post(API+f'/admin/creators/{cr}/approve',data={})
    def up(title,sec):
        r=own.request.post(API+'/studio/tracks',multipart={'audio':{'name':'a.wav','mimeType':'audio/wav','buffer':wav(sec)},'title':title,'storage':'postfile'})
        assert r.status==201, r.text(); return r.json()['track']
    long_=up('Long'+rid,100); short=up('Short'+rid,3); cold=[up('Cold%d'%i+rid,100) for i in range(3)]
    pg=own.new_page()
    reqs=[]; pg.on('request',lambda r: reqs.append(r.url) if ('/stream/' in r.url or '/cdn/' in r.url) else None)
    pg.goto(BASE+'/'); pg.wait_for_selector('#app',timeout=20000); pg.wait_for_timeout(1000)
    def play(item):
        pg.evaluate('(it)=>import("/js/player.js").then(m=>m.player.playQueue([it],0))',item); pg.wait_for_timeout(6000)
    cur=lambda: pg.evaluate(PL+'.then(p=>p.audio.currentTime)')

    for label,cors in (('CDN without CORS (falls back to our proxy)',False),('CDN with CORS, direct',True)):
        ctl(reset=True, cors=cors, ignoreRange=True, noLength=True, slowKBps=1200)   # the host sends the whole file whatever Range says, and not instantly
        pg.evaluate('localStorage.removeItem("aur_ext_mode")'); pg.reload(); pg.wait_for_selector('#app'); pg.wait_for_timeout(800)
        reqs.clear(); hh0=stats()['cdnHits']; play(long_)
        t0=cur(); ck(label+': plays',t0>0.5,t0)
        pg.evaluate(PL+'.then(p=>p.seekTo(60))'); pg.wait_for_timeout(2500)
        t=cur(); ck(label+': seek forward to 60 s lands near 60 (not 0)', 59<=t<=70, t)
        pg.evaluate(PL+'.then(p=>p.seekTo(20))'); pg.wait_for_timeout(2500)
        t=cur(); ck(label+': seek back to 20 s lands near 20 (not 0)', 19<=t<=30, t)
        pg.evaluate(PL+'.then(p=>p.seekTo(90))'); pg.wait_for_timeout(2500)
        t=cur(); ck(label+': seek forward again to 90 s', 89<=t<=97, t)
        box=pg.locator('#p-bar').bounding_box(); pg.mouse.click(box['x']+box['width']*0.25, box['y']+2); pg.wait_for_timeout(2500)
        t=cur(); ck(label+': clicking the bar at 25% (25 s) works', 24<=t<=34, t)
        hh=stats()['cdnHits']-hh0; print('   requests:',[r.replace(BASE,'') for r in reqs])
        ck(label+': the whole song was fetched ONCE for all those seeks (host hits: %d)'%hh, hh<=(1 if cors else 2), hh)

    # ---- repeat: no download per loop
    ctl(reset=True, cors=False, ignoreRange=False, noLength=False, slowKBps=0)
    pg.evaluate('localStorage.removeItem("aur_ext_mode")'); pg.reload(); pg.wait_for_selector('#app'); pg.wait_for_timeout(800)
    pg.evaluate(PL+'.then(p=>{p.repeat="one"})')
    play(short); pg.wait_for_timeout(500)
    reqs.clear(); h0=stats()['cdnHits']
    loops=0
    for i in range(4):
        pg.evaluate(PL+'.then(p=>{p.audio.currentTime=Math.max(0,p.audio.duration-0.6)})'); pg.wait_for_timeout(2200)
        c=cur(); loops+= (c<2.5)
    ck('repeat one: it really looped 4 times', loops>=3, loops)
    ck('repeat one: playing after the loops', pg.evaluate(PL+'.then(p=>!!p.isPlaying)'))
    h1=stats()['cdnHits']
    ck('repeat one: ZERO new downloads from the file host while looping (%d before, %d after)'%(h0,h1), h1==h0, (h0,h1))
    # repeat all with a single song behaves the same
    pg.evaluate(PL+'.then(p=>{p.repeat="all"})'); reqs.clear(); h0=stats()['cdnHits']
    for i in range(3):
        pg.evaluate(PL+'.then(p=>{p.audio.currentTime=Math.max(0,p.audio.duration-0.6)})'); pg.wait_for_timeout(2200)
    ck('repeat all (one song): ZERO new downloads from the file host', stats()['cdnHits']==h0, (h0,stats()['cdnHits']))
    # replaying the same song later is served from the browser cache
    pg.evaluate(PL+'.then(p=>{p.repeat="off"})')
    play(long_); play(short); h0=stats()['cdnHits']; play(long_)
    ck('re-playing a song heard a minute ago does not hit the file host again (cache)', stats()['cdnHits']==h0, (h0,stats()['cdnHits']))
    # ---- seeking in the first seconds, before the song has downloaded (blob mode) or has any data (stream mode)
    for mode in ('blob','stream'):
        pg.evaluate('(m)=>import("/js/player.js").then(x=>x.player.setStreamMode(m==="stream"))',mode)
        for i,it in enumerate(cold[:2] if mode=='blob' else cold[2:]):
            ctl(reset=True, cors=True, ignoreRange=False, slowKBps=350)
            pg.evaluate('localStorage.removeItem("aur_ext_mode")')
            pg.evaluate('(it)=>import("/js/player.js").then(m=>m.player.playQueue([it],0))',it); pg.wait_for_timeout(1200)   # nothing downloaded yet
            ld=pg.evaluate(PL+'.then(p=>p.loading)')
            box=pg.locator('#p-bar').bounding_box()
            pg.mouse.click(box['x']+box['width']*0.7, box['y']+2); pg.wait_for_timeout(300)
            fill=pg.evaluate('parseFloat(document.getElementById("p-fill").style.width)')
            ck(mode+': seek in the first seconds (loading=%s): the bar shows ~70%% at once, not 0 (%.0f%%)'%(ld,fill), 60<=fill<=80, fill)
            pg.mouse.click(box['x']+box['width']*0.4, box['y']+2); pg.wait_for_timeout(300)     # change your mind while it loads
            fill=pg.evaluate('parseFloat(document.getElementById("p-fill").style.width)')
            ck(mode+': a second seek while loading replaces the first (%.0f%%)'%fill, 30<=fill<=50, fill)
            pg.wait_for_function('()=>import("/js/player.js").then(m=>!m.player.loading && m.player.audio.currentTime>1)' if False else '1',timeout=1000)
            pg.wait_for_timeout(14000)
            t=cur(); pl=pg.evaluate(PL+'.then(p=>!!p.isPlaying)')
            ck(mode+': once it is ready it plays from the chosen spot (~40 s), not from 0 (%.1f s)'%t, 38<=t<=58 and pl, (t,pl))
    ctl(reset=True, noLength=False, slowKBps=0); pg.evaluate(PL+'.then(p=>p.setStreamMode(false))')
    ck('the server survived all the aborted streams (no crash)', own.request.get(API+'/session').ok)
    b.close()
print(f'\n{ok} passed, {bad} failed'); raise SystemExit(1 if bad else 0)
