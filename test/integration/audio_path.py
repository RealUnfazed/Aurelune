"""Why playback could crackle / "rip": (1) EQ boosts clipping loud songs, (2) every song going through Web Audio with a small buffer.
   Checks: no Web Audio at all while the EQ is flat (native <audio> path), the EQ takes over live when switched on, headroom keeps every
   preset (and the extreme custom ones) from exceeding full scale on loud material, and it is audibly the same when flat.
   bash test/integration/runpf.sh test/integration/audio_path.py"""
from playwright.sync_api import sync_playwright
BASE='http://127.0.0.1:3000'; API=BASE+'/api/v1'
ok=bad=0
def ck(n,c,x=''):
    global ok,bad
    ok+=bool(c); bad+=not c; print(('PASS ' if c else 'FAIL ')+n+('' if c else ' '+str(x)))
with sync_playwright() as p:
    b=p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
    ctx=b.new_context(viewport={'width':1100,'height':800}); ctx.request.post(API+'/auth/login',data={'login':'admin@aurelune.local','password':'aurelune-admin'})
    ctx.request.put(API+'/me/eq',data={'preset':'flat'})
    tracks=ctx.request.get(API+'/home').json()['trending']
    pg=ctx.new_page(); errs=[]; pg.on('pageerror',lambda e:errs.append(str(e)))
    pg.goto(BASE+'/'); pg.wait_for_selector('#app'); pg.wait_for_timeout(800)
    ev=lambda js: pg.evaluate(f'(async()=>{{const p=(await import("/js/player.js")).player; return ({js})}})()')
    pg.evaluate('(l)=>import("/js/player.js").then(m=>m.player.playQueue(l,0))',tracks[:3]); pg.wait_for_timeout(1500)
    ck('flat EQ: no AudioContext graph at all (native audio path)', ev('p._eqNodes===null'))
    t0=ev('p.audio.currentTime'); pg.wait_for_timeout(1200); ck('flat EQ: it plays', ev('p.audio.currentTime')>t0+0.8 and ev('!p.audio.paused'), (t0,ev('p.audio.currentTime')))
    ev('(p.next(),0)'); pg.wait_for_timeout(1200); ck('flat EQ: next song also native and playing', ev('p._eqNodes===null && !p.audio.paused'))
    # EQ switched on mid-song
    ev('(p.setEQBands([6,5,3,0,-1,-1,0]),0)'); pg.wait_for_timeout(800)
    ck('EQ on: graph created and the playing element is in it', ev('!!p._eqNodes && p._eqNodes.wrapped.has(p.audio)'))
    ck('EQ on: context uses the bigger "playback" buffer hint', ev('p._eqNodes.ctx.baseLatency')>=0)
    pre=ev('p._eqNodes.graph.pre.gain.value'); ck(f'EQ on: headroom applied (pre-gain {pre:.2f} < 1)', pre<0.8, pre)
    t0=ev('p.audio.currentTime'); pg.wait_for_timeout(1200); ck('EQ on: still playing after the switch', ev('!p.audio.paused') and ev('p.audio.currentTime')>t0+0.8, (t0,ev('p.audio.currentTime')))
    ev('(p.next(),0)'); pg.wait_for_timeout(1500); ck('EQ on: next song is equalized and plays', ev('p._eqNodes.wrapped.has(p.audio) && !p.audio.paused'))
    ev('(p.setEQBands([0,0,0,0,0,0,0]),0)'); pg.wait_for_timeout(800)
    ck('EQ back to flat: filters bypassed, still playing', ev('p._eqNodes.graph.flat===true && !p.audio.paused'))
    ev('(p.setEQBands([4,2,-2,-3,0,3,4]),0)'); pg.wait_for_timeout(900)
    ck('EQ on again after flat: back through the filters with headroom, still playing', ev('p._eqNodes.graph.flat===false && !p.audio.paused') and ev('p._eqNodes.graph.pre.gain.value')<0.8, ev('p._eqNodes.graph.pre.gain.value'))
    ev('(p.setEQBands([0,0,0,0,0,0,0]),0)'); pg.wait_for_timeout(500)
    # clipping, rendered offline through the very same graph builder
    R=pg.evaluate('''async()=>{const {createEqGraph}=await import('/js/player.js');
      const presets={flat:[0,0,0,0,0,0,0],bass_boost:[6,5,3,0,-1,-1,0],treble_boost:[-1,-1,0,1,3,5,6],vocal_boost:[-2,-1,1,4,4,1,-1],jazz:[3,2,0,1,2,3,3],rock:[4,2,-2,-3,0,3,4],pop:[-1,2,4,4,1,-1,-2],classical:[3,2,0,0,-1,2,3],electronic:[4,3,0,-2,1,2,4],hiphop:[5,4,1,-1,1,0,2],acoustic:[3,2,1,0,1,2,2],loudness:[5,3,0,0,0,2,4],all_max:[12,12,12,12,12,12,12],bass_max:[12,12,12,0,0,0,0]};
      const out={};
      for(const [name,bands] of Object.entries(presets)){ for(const mode of ['with headroom','without']){
        const oc=new OfflineAudioContext(2,44100*3,44100); const g=createEqGraph(oc,bands); if(mode==='without') g.pre.gain.value=1;
        // a loud master: full-scale-ish sweep + noise, the kind of material that clips when boosted
        const buf=oc.createBuffer(2,44100*3,44100); for(let c=0;c<2;c++){const d=buf.getChannelData(c); let ph=0; for(let i=0;i<d.length;i++){const f=40*Math.pow(400,i/d.length); ph+=2*Math.PI*f/44100; d[i]=0.95*Math.sin(ph);}}
        const src=oc.createBufferSource(); src.buffer=buf; src.connect(g.input); src.start();
        const r=await oc.startRendering(); let peak=0; for(let c=0;c<2;c++){const d=r.getChannelData(c); for(let i=0;i<d.length;i++){const a=Math.abs(d[i]); if(a>peak)peak=a}} out[name+'|'+mode]=peak }}
      return out}''')
    worst=0
    for name in ('flat','bass_boost','treble_boost','vocal_boost','jazz','rock','pop','classical','electronic','hiphop','acoustic','loudness','all_max','bass_max'):
        w=R[name+'|with headroom']; wo=R[name+'|without']; worst=max(worst,w)
        ck(f'{name}: peak {w:.3f} with headroom (without it: {wo:.2f}) never exceeds full scale', w<=1.0, (w,wo))
    ck('the problem was real: unprotected bass boost clips a loud sweep (peak > 1.2)', R['bass_boost|without']>1.2, R['bass_boost|without'])
    ck('flat is untouched (peak equals the input 0.95)', abs(R['flat|with headroom']-0.95)<0.002, R['flat|with headroom'])
    ck('no page errors', not errs, errs)
    b.close()
print(f'\n{ok} passed, {bad} failed'); raise SystemExit(1 if bad else 0)
