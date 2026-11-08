"""Pictures: no blink when the player re-renders, shown only when fully loaded, and uploads are downscaled.
   bash test/integration/runpf.sh test/integration/img_loading.py   (or any server on :3000 with the demo seed)"""
import io, os, time
import numpy as np
from PIL import Image
from playwright.sync_api import sync_playwright
BASE='http://127.0.0.1:3000'; API=BASE+'/api/v1'
DATA=os.environ.get('DATA_DIR') or os.path.join(os.getcwd(),'data')
ok=bad=0
def ck(n,c,x=''):
    global ok,bad
    ok+=bool(c); bad+=not c; print(('PASS ' if c else 'FAIL ')+n+('' if c else ' '+str(x)))
def noise_jpeg(w,h,q=92):
    a=np.random.randint(0,256,(h//8,w//8,3),dtype=np.uint8)
    im=Image.fromarray(a).resize((w,h),Image.BICUBIC); b=io.BytesIO(); im.save(b,'JPEG',quality=q); return b.getvalue()
PL='import("/js/player.js").then(m=>m.player)'

with sync_playwright() as p:
    b=p.chromium.launch(); rid=str(int(time.time()))[-6:]
    # ---------------- 1. an uploaded cover is downscaled before it is stored ----------------
    admin=p.request.new_context(); admin.post(API+'/auth/login',data={'login':'admin@aurelune.local','password':'aurelune-admin'})
    owner=p.request.new_context(); r=owner.post(API+'/auth/signup',data={'username':'img'+rid,'email':f'img{rid}@t.test','password':'password123'}); assert r.status==201, r.text()
    cr=owner.post(API+'/studio/request',data={'name':'Imgband'+rid,'focus':'both'}).json()['creator']; admin.post(API+f'/admin/creators/{cr["id"]}/approve',data={})
    big=noise_jpeg(4000,3000,95)
    ck('test picture really is big (>1.5 MB, 4000x3000)', len(big)>1_500_000, len(big))
    r=owner.post(API+'/studio/albums',multipart={'title':'Big cover '+rid,'kind':'single','cover':{'name':'huge.jpg','mimeType':'image/jpeg','buffer':big}})
    ck('album with a huge cover is accepted', r.status==201, r.text()[:200])
    cover=r.json()['album']['cover'].split('#')[0]
    pic=p.request.new_context().get(BASE+cover); body=pic.body(); im=Image.open(io.BytesIO(body))
    ck('stored cover is at most 1200 px on its long side', max(im.size)<=1200 and max(im.size)>=1000, im.size)
    ck('and it is far smaller than the upload', len(body)<len(big)/3, (len(big),len(body)))
    ck('aspect ratio kept (4:3)', abs(im.size[0]/im.size[1]-4/3)<0.01, im.size)
    # a normal-sized picture is not recompressed
    small=noise_jpeg(500,500,85); r=owner.post(API+'/studio/albums',multipart={'title':'Small cover '+rid,'kind':'single','cover':{'name':'s.jpg','mimeType':'image/jpeg','buffer':small}})
    sc=r.json()['album']['cover'].split('#')[0]; sb=p.request.new_context().get(BASE+sc).body()
    ck('a picture already small enough is stored untouched', sb==small, (len(small),len(sb)))

    # ---------------- 2. browser: no blink on re-render ----------------
    ctx=b.new_context(viewport={'width':1366,'height':800}, service_workers='block'); ctx.request.post(API+'/auth/login',data={'login':'admin@aurelune.local','password':'aurelune-admin'})
    tracks=ctx.request.get(API+'/home').json()['trending']
    pg=ctx.new_page(); errs=[]; pg.on('pageerror',lambda e:errs.append(str(e)))
    pg.goto(BASE+'/'); pg.wait_for_selector('#player-bar',state='attached'); pg.wait_for_timeout(800)
    pg.evaluate(f'(async()=>{{const pl=await {PL}; await pl.playQueue({tracks[:4]!r}.map(t=>t),0)}})()'.replace('True','true').replace('False','false').replace('None','null'))
    pg.wait_for_selector('.pnow-cover img'); pg.wait_for_timeout(800)
    pg.click('#p-queue'); pg.wait_for_selector('.queue-list'); pg.click('[data-nptab="playing"]'); pg.wait_for_selector('.np-cover img'); pg.wait_for_timeout(600)
    pg.evaluate('window.__bar=document.querySelector(".pnow-cover img"); window.__np=document.querySelector(".np-cover img"); window.__nq=document.querySelector(".np-body .trow-cover img, #np-body .trow-cover img")')
    ck('before: player picture and side-panel picture are loaded and visible', pg.evaluate('(()=>{const f=(e)=>e&&e.complete&&e.naturalWidth>0&&getComputedStyle(e).opacity==="1";return f(__bar)&&f(__np)})()'))
    nreq=[]; pg.on('request',lambda r: nreq.append(r.url) if r.resource_type=='image' else None)
    flips=[]
    for i in range(3):                               # pause/play: the player fires `change` each time and re-renders the bar and the panel
        pg.click('#p-toggle'); pg.wait_for_timeout(250)
        flips.append(pg.evaluate('(()=>({bar:document.querySelector(".pnow-cover img")===__bar, np:document.querySelector(".np-cover img")===__np}))()'))
    ck('pause/play x3: the player-bar picture is the SAME element (not re-created)', all(f['bar'] for f in flips), flips)
    ck('pause/play x3: the right-panel picture is the SAME element (not re-created)', all(f['np'] for f in flips), flips)
    pg.click('#bar-like'); pg.wait_for_timeout(500)
    ck('liking the song does not re-create either picture', pg.evaluate('document.querySelector(".pnow-cover img")===__bar && document.querySelector(".np-cover img")===__np'))
    pg.evaluate(f'(async()=>{{const pl=await {PL}; pl.setRate&&0; pl.rate=1.5}})()'); pg.wait_for_timeout(300)
    ck('and both are still fully visible (not blanked)', pg.evaluate('(()=>{const f=(e)=>getComputedStyle(e).opacity==="1"&&e.complete;return f(__bar)&&f(__np)})()'))
    ck('no image was requested during all of that', len(nreq)==0, nreq)
    # a different song DOES swap the picture (only that part changes)
    pg.evaluate(f'(async()=>{{const pl=await {PL}; pl.next()}})()'); pg.wait_for_timeout(900)
    ck('next song: the picture changes to the new song', pg.evaluate('document.querySelector(".pnow-cover img")!==__bar') or tracks[0]['cover']==tracks[1]['cover'])

    # ---------------- 3. shown only when completely loaded ----------------
    from PIL import Image as I
    os.makedirs(os.path.join(DATA,'uploads','img'),exist_ok=True)
    open(os.path.join(DATA,'uploads','img','slowpic.jpg'),'wb').write(noise_jpeg(3000,3000,95))
    sz=os.path.getsize(os.path.join(DATA,'uploads','img','slowpic.jpg'))
    cdp=ctx.new_cdp_session(pg); cdp.send('Network.enable'); cdp.send('Network.setCacheDisabled',{'cacheDisabled':True})
    cdp.send('Network.emulateNetworkConditions',{'offline':False,'latency':50,'downloadThroughput':500*1024,'uploadThroughput':500*1024})
    pg.goto(BASE+'/#/search'); pg.wait_for_timeout(500)
    pg.evaluate('''(()=>{const d=document.createElement("div");d.className="trow-cover";d.id="slowbox";d.style.cssText="position:fixed;left:20px;top:20px;width:200px;height:200px;z-index:99999";
      const i=document.createElement("img");i.src="/media/img/slowpic.jpg?x="+Date.now();d.appendChild(i);document.body.appendChild(d)})()''')
    samples=[]
    for _ in range(40):
        s=pg.evaluate('(()=>{const i=document.querySelector("#slowbox img");return {done:i.complete&&i.naturalWidth>0,op:getComputedStyle(i).opacity,ld:i.classList.contains("ld")}})()'); samples.append(s)
        if s['done'] and s['ld']: break
        pg.wait_for_timeout(250)
    part=[s for s in samples if not s['done']]
    ck(f'slow picture ({sz//1024} KB at 500 KB/s) was observed mid-download (>=3 samples)', len(part)>=3, len(samples))
    ck('while it was still downloading it was invisible (opacity 0) — no half-painted picture', all(float(s['op'])==0 for s in part), part[:3])
    pg.wait_for_timeout(500)
    fin=pg.evaluate('(()=>{const i=document.querySelector("#slowbox img");return {ld:i.classList.contains("ld"),op:getComputedStyle(i).opacity,ok:i.complete&&i.naturalWidth>0}})()')
    ck('once it finished it faded in fully (class ld, opacity 1)', fin['ld'] and fin['ok'] and float(fin['op'])==1, fin)
    cdp.send('Network.emulateNetworkConditions',{'offline':False,'latency':0,'downloadThroughput':-1,'uploadThroughput':-1}); cdp.send('Network.setCacheDisabled',{'cacheDisabled':False})
    # cached picture: appears at once
    pg.evaluate('''(()=>{const d=document.getElementById("slowbox");d.innerHTML="";const i=document.createElement("img");i.src=window.__u;d.appendChild(i)})()'''.replace('window.__u','document.querySelector("#slowbox img")?.src||""'))
    # a missing picture: shows the generated art (and is visible), not a blank
    pg.evaluate('''(()=>{const d=document.getElementById("slowbox");d.innerHTML="";const i=document.createElement("img");i.id="miss";i.src="/media/img/does-not-exist.jpg#art="+encodeURIComponent("/art/track/1.svg?s=x");d.appendChild(i)})()''')
    pg.wait_for_timeout(1500)
    m=pg.evaluate('(()=>{const i=document.getElementById("miss");return {src:i.getAttribute("src"),fb:i.dataset.fb,ld:i.classList.contains("ld"),op:getComputedStyle(i).opacity,ok:i.complete&&i.naturalWidth>0}})()')
    ck('a picture that fails falls back to the generated art and is visible', m['fb']=='1' and '/art/track/1.svg' in m['src'] and m['ld'] and float(m['op'])==1 and m['ok'], m)
    # ---------------- 4. phone: the full player (big cover + blurred backdrop) does not blink either ----------------
    pctx=b.new_context(viewport={'width':390,'height':780}, service_workers='block'); pctx.request.post(API+'/auth/login',data={'login':'admin@aurelune.local','password':'aurelune-admin'})
    q=pctx.new_page(); q.goto(BASE+'/'); q.wait_for_selector('#player-bar',state='attached'); q.wait_for_timeout(800)
    q.evaluate(f'(async()=>{{const pl=await {PL}; await pl.playQueue({tracks[:3]!r},0)}})()'.replace('True','true').replace('False','false').replace('None','null'))
    q.wait_for_selector('.pnow-cover img'); q.wait_for_timeout(600); q.click('.pnow .title-link, .pnow-cover'); q.wait_for_selector('.fp-art img'); q.wait_for_timeout(900)
    q.evaluate('window.__a=document.querySelector(".fp-art img"); window.__g=document.querySelector(".fp-bg")')
    for _ in range(3): q.click('#fp-toggle'); q.wait_for_timeout(250)
    same=q.evaluate('document.querySelector(".fp-art img")===__a && document.querySelector(".fp-bg")===__g')
    ck('phone full player: big cover and backdrop are the same elements after pause/play x3', same)
    ck('phone full player: both visible (cover opacity 1, backdrop at its resting 0.34)', q.evaluate('(()=>{const a=getComputedStyle(__a).opacity,g=getComputedStyle(__g).opacity;return a==="1"&&Math.abs(parseFloat(g)-0.34)<0.01})()'), q.evaluate('[getComputedStyle(__a).opacity,getComputedStyle(__g).opacity]'))
    ck('no page errors', not errs, errs)
    b.close()
print(f'\n{ok} passed, {bad} failed'); raise SystemExit(1 if bad else 0)
