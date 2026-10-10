"""Liked Songs / Liked Episodes tiles: the INK (the drawn pixels, not the svg box) is centred, for every icon, at several interface scales and
   pixel ratios, in the expanded (36px) and collapsed (44px) sidebar and as the big page cover.  Measured on a white-on-black screenshot (any visible pixel: a sharp tip like the flame's is under 50% coverage, so a stricter threshold would hide it).
   bash test/integration/runpf.sh test/integration/tile_ink.py"""
import io
from PIL import Image
from playwright.sync_api import sync_playwright
BASE='http://127.0.0.1:3000'; API=BASE+'/api/v1'
ok=bad=0; worst=0
def ck(n,c,x=''):
    global ok,bad
    ok+=bool(c); bad+=not c
    if not c: print('FAIL '+n+' '+str(x))
ICONS=['heart','star','bolt','flame','moon','note','podcast','mic']
def ink(el,dpr):
    im=Image.open(io.BytesIO(el.screenshot())).convert('L'); W,H=im.size; a=im.load()  # white glyph on a black tile
    xs=[];ys=[]
    for y in range(H):
        for x in range(W):
            if a[x,y]>20: xs.append(x); ys.append(y)
    if not xs: return None
    return ((min(xs)+max(xs)+1)/2-W/2)/dpr, ((min(ys)+max(ys)+1)/2-H/2)/dpr, (max(xs)-min(xs)+1)/dpr, (max(ys)-min(ys)+1)/dpr, W/dpr
SETUP='''async()=>{const c=await import('/js/components.js'); const host=document.querySelector('.nav-playlists'); let box=document.getElementById('ink-lab'); if(box) box.remove();
  box=document.createElement('div'); box.id='ink-lab'; box.style.cssText='position:fixed;left:0;top:0;z-index:99999;display:flex;flex-wrap:wrap;gap:6px;padding:6px;background:#000;max-width:900px'; document.body.append(box);
  const add=(kind,ic,size,big)=>{const w=document.createElement('div'); w.className='pl-thumb'; w.dataset.lab=kind+':'+ic+':'+size; w.style.cssText=`width:${size}px;height:${size}px;border-radius:6px;background:#000;`;
    w.innerHTML=(kind==='songs'?c.likedTile({icon:ic,color:'green'},big?'big':''):c.episodesTile({icon:ic,color:'violet'},big?'big':'')); const t=w.firstElementChild; t.style.background='#000'; box.append(w); return w};
  for(const ic of %s){ for(const k of ['songs','episodes']){ add(k,ic,36,false); add(k,ic,44,false); add(k,ic,120,true);} } }''' % str(ICONS)
with sync_playwright() as p:
    b=p.chromium.launch()
    for dpr in (1,2):
        ctx=b.new_context(viewport={'width':1800,'height':2200},device_scale_factor=dpr)
        ctx.request.post(API+'/auth/login',data={'login':'admin@aurelune.local','password':'aurelune-admin'})
        pg=ctx.new_page(); pg.goto(BASE+'/'); pg.wait_for_selector('.nav-playlists [data-liked]'); pg.wait_for_timeout(600)
        # map the glyph name used by the app to the picker names
        for pct in ((100,125,150) if dpr==2 else (75,100,110,125,150,200)):
            pg.evaluate(f"import('/js/store.js').then(m=>m.applyScale({pct},{{save:false}}))"); pg.wait_for_timeout(250)
            pg.evaluate(SETUP); pg.wait_for_timeout(150)
            lab=pg.query_selector_all('#ink-lab > [data-lab]')
            for w in lab:
                name=w.get_attribute('data-lab'); t=w.query_selector('.liked-tile')
                r=ink(t,dpr)
                ck(f'{name} @{pct}% dpr{dpr} has ink', r is not None)
                if not r: continue
                dx,dy,iw,ih,tile=r; tol=max(0.75, 1.0/dpr+0.01, tile*0.01)  # one device pixel, 0.75 css px, or 1% of a big cover (the flame's tip is thinner than a pixel)
                worst=max(worst,abs(dx),abs(dy))
                ck(f'{name} @{pct}% dpr{dpr} centred (dx {dx:+.2f}, dy {dy:+.2f}, ink {iw:.1f}x{ih:.1f} in {tile:.0f}px)', abs(dx)<=tol and abs(dy)<=tol, (dx,dy))
                ck(f'{name} @{pct}% dpr{dpr} ink fits and not oversized', max(iw,ih)<=tile*0.40 and iw<=tile and ih<=tile, (iw,ih,tile))
        ctx.close()
    b.close()
print(f'worst ink offset {worst:.2f} css px\n{ok} passed, {bad} failed'); raise SystemExit(1 if bad else 0)
