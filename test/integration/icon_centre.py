"""Every icon-only button in the app: the icon is centred in its button (the drawn pixels, not just the svg box) and fits inside it.
   Covers the sidebar collapse chevron (expanded + collapsed), the top bar, the player bar (song and episode), the right panel, and phone widths.
   bash test/integration/runpf.sh test/integration/icon_centre.py"""
import io
from PIL import Image
from playwright.sync_api import sync_playwright
BASE='http://127.0.0.1:3000'; API=BASE+'/api/v1'
ok=bad=0; worst=0
def ck(n,c,x=''):
    global ok,bad
    ok+=bool(c); bad+=not c
    if not c: print('FAIL '+n+' '+str(x))
# 1) box level, every icon-only control on every page
JS='''()=>{const out=[];document.querySelectorAll('button, .icon-btn, .like-btn, .play-btn, [role=button], .mtab').forEach(b=>{
  const r=b.getBoundingClientRect(); if(r.width<8||r.height<8||getComputedStyle(b).visibility==='hidden'||b.hidden) return;
  const svgs=[...b.querySelectorAll('svg')]; if(svgs.length!==1||b.textContent.trim().length>0) return;
  if(b.closest('.sl-left')) return; if(b.querySelector('.sl-left')) return;  // the sleep button carries a time badge on purpose
  const s=svgs[0].getBoundingClientRect(); if(s.width===0) return;
  out.push({id:b.id||b.className.toString().slice(0,40),bw:r.width,bh:r.height,sw:s.width,dx:(s.left+s.right)/2-(r.left+r.right)/2,dy:(s.top+s.bottom)/2-(r.top+r.bottom)/2,over:s.width>r.width+0.5||s.height>r.height+0.5})});return out}'''
def sweep(pg,label):
    for o in pg.evaluate(JS):
        global worst
        worst=max(worst,abs(o['dx']),abs(o['dy']))
        ck(f"{label}: {o['id']} ({o['bw']:.0f}px) icon centred and inside", abs(o['dx'])<=0.6 and abs(o['dy'])<=0.6 and not o['over'], o)
# 2) pixel level for the chevron
def ink(el):
    im=Image.open(io.BytesIO(el.screenshot())).convert('RGB'); W,H=im.size; px=im.load(); bg=px[3,H//2]
    xs=[];ys=[]
    for y in range(H):
        for x in range(W):
            if sum(abs(a-b) for a,b in zip(px[x,y],bg))>90: xs.append(x); ys.append(y)
    return ((min(xs)+max(xs)+1)/2-W/2, (min(ys)+max(ys)+1)/2-H/2, W) if xs else None
with sync_playwright() as p:
    b=p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
    ctx=b.new_context(viewport={'width':1366,'height':800}); ctx.request.post(API+'/auth/login',data={'login':'admin@aurelune.local','password':'aurelune-admin'})
    home=ctx.request.get(API+'/home').json(); tracks=home['trending']; eps=home.get('new_episodes') or []
    pg=ctx.new_page(); pg.goto(BASE+'/'); pg.wait_for_selector('.nav'); pg.wait_for_timeout(800)
    play=lambda l:(pg.evaluate('(l)=>import("/js/player.js").then(m=>m.player.playQueue(l,0))',l[:2]),pg.wait_for_timeout(900))
    play(tracks)
    for route in ('#/','#/search','#/library','#/liked','#/liked-episodes','#/downloads','#/settings','#/lyrics'):
        pg.goto(BASE+'/'+route); pg.wait_for_timeout(600); sweep(pg,'expanded '+route)
    # the chevron, drawn pixels, at several scales, expanded and collapsed
    for pct in (75,100,125,150,200):
        pg.goto(BASE+'/#/'); pg.evaluate(f"import('/js/store.js').then(m=>m.applyScale({pct},{{save:false}}))"); pg.wait_for_timeout(300)
        if not pg.is_visible('#nav-collapse'): print(f'(at {pct}% the interface is narrow enough that the sidebar is icons-only: no chevron there)'); continue
        for state in ('expanded','collapsed'):
            if state=='collapsed': pg.click('#nav-collapse'); pg.wait_for_timeout(350)
            btn=pg.query_selector('#nav-collapse'); pg.hover('#nav-collapse'); pg.wait_for_timeout(250)
            r=pg.evaluate("(()=>{const b=document.querySelector('#nav-collapse'),s=b.querySelector('svg').getBoundingClientRect(),r=b.getBoundingClientRect();return {bw:r.width,sw:s.width,dx:(s.left+s.right)/2-(r.left+r.right)/2,dy:(s.top+s.bottom)/2-(r.top+r.bottom)/2}})()")
            ck(f'chevron {state} @{pct}%: svg smaller than its circle ({r["sw"]:.0f} in {r["bw"]:.0f}px)', r['sw']<=r['bw']*0.75, r)
            ck(f'chevron {state} @{pct}%: svg box centred (dx {r["dx"]:+.2f}, dy {r["dy"]:+.2f})', abs(r['dx'])<=0.6 and abs(r['dy'])<=0.6, r)
            i=ink(btn)
            if i:
                dx,dy,W=i; worst=max(worst,abs(dy))
                # a chevron points sideways: its drawn centre is the middle of the arrow, so vertical must be exact and horizontal within 1.5px
                ck(f'chevron {state} @{pct}%: drawn arrow centred vertically ({dy:+.2f}px) and horizontally ({dx:+.2f}px)', abs(dy)<=0.8 and abs(dx)<=1.6, (dx,dy,W))
            if state=='collapsed': pg.click('#nav-collapse'); pg.wait_for_timeout(350)
        pg.evaluate("import('/js/store.js').then(m=>m.applyScale(100,{save:false}))")
    pg.evaluate("import('/js/store.js').then(m=>m.applyScale(100,{save:false}))"); pg.wait_for_timeout(400)
    pg.click('#nav-collapse'); pg.wait_for_timeout(400); sweep(pg,'collapsed sidebar'); pg.click('#nav-collapse')
    pg.click('#p-lyrics'); pg.wait_for_timeout(500); sweep(pg,'right panel'); pg.click('#np-close')
    play(eps); pg.wait_for_timeout(300); sweep(pg,'episode bar')
    for w in (390,820):
        pg.set_viewport_size({'width':w,'height':800}); pg.goto(BASE+'/#/'); pg.wait_for_timeout(700); sweep(pg,f'{w}px')
    b.close()
print(f'worst offset {worst:.2f}px\n{ok} passed, {bad} failed'); raise SystemExit(1 if bad else 0)
