"""A page that is still loading must never paint over the page you navigated to afterwards (Home slow -> open Creators -> Home finishes and
   throws you back). The delay is injected into fetch() in the page, so the order of events is exact.
   bash test/integration/runpf.sh test/integration/nav_race.py"""
from playwright.sync_api import sync_playwright
BASE='http://127.0.0.1:3000'; API=BASE+'/api/v1'
ok=bad=0
def ck(n,c,x=''):
    global ok,bad
    ok+=bool(c); bad+=not c; print(('PASS ' if c else 'FAIL ')+n+('' if c else ' '+str(x)))
INIT='''window.__delays={}; const of=window.fetch; window.fetch=function(u,o){const url=String((u&&u.url)||u);
  for(const k in window.__delays){ if(url.includes(k)){ const ms=window.__delays[k]; const a=arguments, self=this; return new Promise(r=>setTimeout(r,ms)).then(()=>of.apply(self,a)); } }
  return of.apply(this,arguments)}'''
with sync_playwright() as p:
    b=p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
    ctx=b.new_context(viewport={'width':1366,'height':800}); ctx.request.post(API+'/auth/login',data={'login':'admin@aurelune.local','password':'aurelune-admin'})
    tracks=ctx.request.get(API+'/home').json()['trending']
    ctx.request.put(API+f"/me/likes/{tracks[0]['id']}")
    ctx.add_init_script(INIT)
    pg=ctx.new_page(); errs=[]; pg.on('pageerror',lambda e:errs.append(str(e)))
    pg.goto(BASE+'/'); pg.wait_for_selector('.nav'); pg.wait_for_timeout(1200)
    sig={}
    for name,route in (('home','#/'),('studio','#/studio'),('library','#/library'),('liked','#/liked'),('search','#/search'),('history','#/history')):
        pg.evaluate(f"location.hash='{route}'"); pg.wait_for_timeout(1000); sig[name]=pg.inner_text('#view').strip()[:60]
    print('signatures:',sig)
    ck('every page has a distinct look to tell them apart', len(set(sig.values()))==len(sig), sig)
    def delay(**kw): pg.evaluate('(d)=>{window.__delays=d}',kw)
    def view(): return pg.inner_text('#view').strip()[:60]
    def go(route): pg.evaluate(f"location.hash='{route}'")

    # the reported case: Home slow, open Creators (fast), Home finishes
    pg.evaluate("location.hash='#/library'"); pg.wait_for_timeout(600)
    delay(**{'/api/v1/home':2500})
    go('#/'); pg.wait_for_timeout(300)
    ck('home is still loading (skeleton)', view()!=sig['home'])
    go('#/studio'); pg.wait_for_timeout(800)
    ck('Creators loaded fast', view()==sig['studio'], view())
    pg.wait_for_timeout(3000)
    ck('...and Home finishing later does NOT replace it', view()==sig['studio'] and pg.evaluate('location.hash')=='#/studio', (view(),pg.evaluate('location.hash')))
    ck('the sidebar does not highlight Home either', pg.evaluate("!document.querySelector('[data-navkey=\"home\"].active')"))

    # Home slow -> Liked (fast): the play list must be Liked's, not Home's
    delay(**{'/api/v1/home':2500})
    go('#/'); pg.wait_for_timeout(300); go('#/liked'); pg.wait_for_timeout(1000)
    lk=pg.evaluate("import('/js/ui.js').then(m=>m.getActiveList().map(t=>t.id))")
    pg.wait_for_timeout(3000)
    lk2=pg.evaluate("import('/js/ui.js').then(m=>m.getActiveList().map(t=>t.id))")
    ck('Liked page keeps its own play list after Home finishes', lk==lk2 and len(lk2)>=1 and view()==sig['liked'], (lk,lk2,view()))

    # three in a row: A slow, B slower, C fast -> C stays
    delay(**{'/api/v1/home':2000,'/api/v1/me/library':3000,'/api/v1/me/likes':0})
    go('#/'); pg.wait_for_timeout(200); go('#/library'); pg.wait_for_timeout(200); go('#/studio'); pg.wait_for_timeout(4500)
    ck('A slow, B slower, C fast: only C is left on screen', view()==sig['studio'], view())

    # the slow page is still shown when you stay on it (no regression)
    delay(**{'/api/v1/home':1500})
    go('#/studio'); pg.wait_for_timeout(500); go('#/'); pg.wait_for_timeout(2500)
    ck('staying on a slow page: it renders normally', view()==sig['home'], view())
    # back to a page you left and returned to while its first load was still running
    delay(**{'/api/v1/home':1500}); go('#/studio'); pg.wait_for_timeout(500)
    go('#/'); pg.wait_for_timeout(300); go('#/studio'); pg.wait_for_timeout(300); go('#/'); pg.wait_for_timeout(3000)
    ck('Home -> Creators -> Home quickly: ends on Home, rendered once', view()==sig['home'] and pg.eval_on_selector_all('#view .shelf, #view h1, #view h2','e=>e.length')>0, view())
    ck('exactly one #view in the page', pg.eval_on_selector_all('#view','e=>e.length')==1)
    # browser back/forward
    delay(**{'/api/v1/home':2000}); go('#/studio'); pg.wait_for_timeout(500); go('#/'); pg.wait_for_timeout(200); pg.go_back(); pg.wait_for_timeout(3000)
    ck('browser Back during a slow load stays on the page you went back to', view()==sig['studio'] and pg.evaluate('location.hash')=='#/studio', (view(),pg.evaluate('location.hash')))
    # scroll position of the new page is not disturbed by the late one
    delay(**{}); 
    ck('no page errors', not errs, errs)
    b.close()
print(f'\n{ok} passed, {bad} failed'); raise SystemExit(1 if bad else 0)
