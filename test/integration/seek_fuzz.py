"""Randomised seeking: whatever mix of seeks, lyric clicks, pause/play and bar clicks happens while a song downloads, buffers or plays,
the song must end up where the LAST seek asked (never back at the start). Both playback modes, slow host.
   bash test/integration/runpf.sh test/integration/seek_fuzz.py"""
import math, struct, json, random, urllib.request
from playwright.sync_api import sync_playwright
BASE='http://127.0.0.1:3000'; API=BASE+'/api/v1'; FP='http://127.0.0.1:4010'
ok=bad=0
def ck(n,c,x=''):
    global ok,bad
    ok+=bool(c); bad+=not c; print(('PASS ' if c else 'FAIL ')+n+('' if c else ' '+str(x)))
def wav(sec, rate=22050):
    n=int(sec*rate); data=b''.join(struct.pack('<h',int(3000*math.sin(i/9+(i>>12)))) for i in range(n))
    return b'RIFF'+struct.pack('<I',36+len(data))+b'WAVEfmt '+struct.pack('<IHHIIHH',16,1,1,rate,rate*2,2,16)+b'data'+struct.pack('<I',len(data))+data
def ctl(**o): urllib.request.urlopen(urllib.request.Request(FP+'/_ctl',data=json.dumps(o).encode(),method='POST')).read()
PL='import("/js/player.js").then(m=>m.player)'
rid=str(random.randint(10000,99999)); seed=int(rid); rnd=random.Random(seed); print('seed',seed)
with sync_playwright() as p:
    b=p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
    adm=b.new_context(); adm.request.post(API+'/auth/login',data={'login':'admin@aurelune.local','password':'aurelune-admin'})
    own=b.new_context(viewport={'width':1366,'height':800})
    assert own.request.post(API+'/auth/signup',data={'username':'fz'+rid,'email':f'fz{rid}@t.test','password':'password123'}).status==201
    cr=own.request.post(API+'/studio/request',data={'name':'Fuzzband'+rid,'focus':'both'}).json()['creator']['id']
    adm.request.post(API+f'/admin/creators/{cr}/approve',data={})
    def up(title,sec):
        r=own.request.post(API+'/studio/tracks',multipart={'audio':{'name':'a.wav','mimeType':'audio/wav','buffer':wav(sec)},'title':title,'storage':'postfile'})
        assert r.status==201, r.text(); return r.json()['track']
    tracks=[up('F%d'%i+rid,100) for i in range(4)]
    pg=own.new_page(); pg.goto(BASE+'/'); pg.wait_for_selector('#app',timeout=20000); pg.wait_for_timeout(1000)
    LY='[{t:5000},{t:20000},{t:40000},{t:60000},{t:80000}]'
    for mode in ('blob','stream'):
        pg.evaluate('(m)=>import("/js/player.js").then(x=>x.player.setStreamMode(m==="stream"))',mode)
        for cors,ign in ((True,False),(False,True)):
            for trial in range(5):
                ctl(reset=True, cors=cors, ignoreRange=ign, slowKBps=rnd.choice([250,500,1200]))
                pg.evaluate('localStorage.removeItem("aur_ext_mode")')
                it=tracks[(trial+(0 if cors else 1))%4]
                pg.evaluate('(it)=>import("/js/player.js").then(m=>m.player.playQueue([it],0))',it)
                pg.wait_for_timeout(rnd.randint(0,600))
                target=None; wantplay=True; log=[]
                for step in range(rnd.randint(2,6)):
                    act=rnd.choice(['seek','seek','bar','lyric','step','pause','play','toggle'])
                    if act=='seek':
                        target=rnd.uniform(8,90); pg.evaluate('(t)=>import("/js/player.js").then(m=>m.player.seekTo(t))',target)
                    elif act=='bar':
                        f=rnd.uniform(0.1,0.9); box=pg.locator('#p-bar').bounding_box()
                        pg.mouse.click(box['x']+box['width']*f, box['y']+2); target=f*100
                    elif act=='lyric':
                        i=rnd.randrange(5); pg.evaluate('([i])=>import("/js/player.js").then(m=>{const p=m.player;p.lyrics={synced:true,lines:%s};p.seekToLyric(i)})'%LY,[i])
                        target=[5,20,40,60,80][i]; wantplay=True
                    elif act=='step':
                        base=target if target is not None else 0
                        pg.evaluate('()=>import("/js/player.js").then(m=>m.player.seekTo(Math.max(0,m.player.position+5)))'); 
                        target=None if target is None else target+5
                        if target is None: target=pg.evaluate(PL+'.then(p=>p.position)')   # position the step started from + 5 (approx.)
                    elif act=='pause': pg.evaluate(PL+'.then(p=>p.pause())'); wantplay=False
                    elif act=='play': pg.evaluate(PL+'.then(p=>p.play())'); wantplay=True
                    else: pg.evaluate(PL+'.then(p=>p.toggle())'); wantplay=not wantplay
                    log.append(act); pg.wait_for_timeout(rnd.choice([0,50,200,700,1500]))
                if target is None or target<6: continue
                pg.wait_for_function('()=>import("/js/player.js").then(m=>!m.player.loading)',timeout=60000) if False else None
                for _ in range(60):
                    if not pg.evaluate(PL+'.then(p=>p.loading)') : break
                    pg.wait_for_timeout(500)
                pg.wait_for_timeout(3500)
                pos=pg.evaluate(PL+'.then(p=>p.position)'); pl=pg.evaluate(PL+'.then(p=>!!p.isPlaying)')
                hi=target+(14 if wantplay else 1.5)
                good = target-1.5 <= pos <= hi
                ck('%s/%s #%d %s -> last seek %.0f s, now %.1f s, playing=%s (wanted %s)'%(mode,'cors' if cors else 'proxy+ignoreRange',trial,'/'.join(log),target,pos,pl,wantplay), good, pos)
    ctl(reset=True, slowKBps=0); pg.evaluate(PL+'.then(p=>p.setStreamMode(false))')
    b.close()
print(f'\n{ok} passed, {bad} failed'); raise SystemExit(1 if bad else 0)
