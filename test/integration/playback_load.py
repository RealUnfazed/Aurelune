"""While a song plays, the page must not keep the main thread busy: no running animation may animate a layout property (that re-ran layout and
   style 60 times a second), and layouts per second stay low. A phone under load drops audio when the page hogs the CPU.
   bash test/integration/runpf.sh test/integration/playback_load.py"""
from playwright.sync_api import sync_playwright
BASE='http://127.0.0.1:3000'; API=BASE+'/api/v1'
ok=bad=0
def ck(n,c,x=''):
    global ok,bad
    ok+=bool(c); bad+=not c; print(('PASS ' if c else 'FAIL ')+n+('' if c else ' '+str(x)))
OK_PROPS={'transform','opacity','offset','easing','composite','computedOffset','filter'}
with sync_playwright() as p:
    br=p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
    ctx=br.new_context(viewport={'width':390,'height':800},device_scale_factor=2,has_touch=True,is_mobile=True)
    ctx.request.post(API+'/auth/login',data={'login':'admin@aurelune.local','password':'aurelune-admin'})
    home=ctx.request.get(API+'/home').json(); tracks=home['trending']; eps=home.get('new_episodes') or []
    pg=ctx.new_page(); pg.goto(BASE+'/'); pg.wait_for_selector('#app'); pg.wait_for_timeout(1200)
    cdp=ctx.new_cdp_session(pg); cdp.send('Performance.enable')
    def m(): return {x['name']:x['value'] for x in cdp.send('Performance.getMetrics')['metrics']}
    def measure(secs=5):
        a=m(); pg.wait_for_timeout(secs*1000); b=m(); return {k:(b[k]-a[k])/secs for k in ('LayoutCount','RecalcStyleCount','TaskDuration')}
    for label,items in (('song',tracks),('episode',eps)):
        if not items: continue
        pg.evaluate('(l)=>import("/js/player.js").then(m=>m.player.playQueue(l,0))',items[:3]); pg.wait_for_timeout(1500)
        bad_anims=pg.evaluate("""()=>document.getAnimations().filter(a=>a.playState==='running').flatMap(a=>{const kf=a.effect&&a.effect.getKeyframes?a.effect.getKeyframes():[];const props=new Set();kf.forEach(k=>Object.keys(k).forEach(x=>props.add(x)));return [...props].map(x=>({n:a.animationName||a.transitionProperty,x}))})""")
        offenders=[o for o in bad_anims if o['x'] not in OK_PROPS]
        ck(f'{label}: every running animation only changes transform/opacity/filter', not offenders, offenders)
        r=measure()
        ck(f"{label}: layouts per second while playing ({r['LayoutCount']:.1f}) stays low (was ~60)", r['LayoutCount']<=15, r)
        ck(f"{label}: style recalcs per second ({r['RecalcStyleCount']:.1f}) stays low (was ~60)", r['RecalcStyleCount']<=15, r)
        ck(f"{label}: main-thread time per second ({r['TaskDuration']*1000:.0f} ms) is well under the old 85-128 ms", r['TaskDuration']*1000<=70, r)
        pg.evaluate("import('/js/player.js').then(m=>m.player.pause())"); pg.wait_for_timeout(500)
        bars=pg.evaluate("[...document.querySelectorAll('.pnow-cover .equalizer i')].map(i=>getComputedStyle(i).transform)")
        ck(f'{label}: paused equalizer bars hold a low, still pose', bars and all(t!='none' for t in bars), bars)
    br.close()
print(f'\n{ok} passed, {bad} failed'); raise SystemExit(1 if bad else 0)
