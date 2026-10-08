"""Dragging a file onto the upload areas: the drop area highlights, the file is taken (audio/images only), it works anywhere on the
upload dialog and on the studio's Tracks tab, a drop elsewhere never makes the browser leave the app, and the upload completes.
   bash test/integration/runpf.sh test/integration/dragdrop.py"""
import math, struct, base64, random, json
from playwright.sync_api import sync_playwright
BASE='http://127.0.0.1:3000'; API=BASE+'/api/v1'
ok=bad=0
def ck(n,c,x=''):
    global ok,bad
    ok+=bool(c); bad+=not c; print(('PASS ' if c else 'FAIL ')+n+('' if c else ' '+str(x)))
def wav(sec, rate=22050):
    n=int(sec*rate); data=b''.join(struct.pack('<h',int(3000*math.sin(i/9))) for i in range(n))
    return b'RIFF'+struct.pack('<I',36+len(data))+b'WAVEfmt '+struct.pack('<IHHIIHH',16,1,1,rate,rate*2,2,16)+b'data'+struct.pack('<I',len(data))+data
W=base64.b64encode(wav(4)).decode()
# drops a file on a selector, the way a browser does; returns [defaultPrevented, dragover prevented]
DROP='''([sel,name,type,b64,kind])=>{const el=document.querySelector(sel); if(!el) return 'no element '+sel;
  const bin=atob(b64), u=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++) u[i]=bin.charCodeAt(i);
  const dt=new DataTransfer(); dt.items.add(new File([u],name,{type}));
  const mk=(t)=>new DragEvent(t,{bubbles:true,cancelable:true,dataTransfer:dt});
  const e1=mk('dragenter'); el.dispatchEvent(e1); const e2=mk('dragover'); el.dispatchEvent(e2);
  const over=(document.querySelector('.file-drop')||{classList:{contains:()=>false}}).classList.contains('over');
  if(kind==='over') return {over,p:e2.defaultPrevented};
  const e3=mk('drop'); el.dispatchEvent(e3); return {over,p:e3.defaultPrevented,dragoverPrevented:e2.defaultPrevented}}'''
rid=str(random.randint(10000,99999))
with sync_playwright() as p:
    b=p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
    adm=b.new_context(); adm.request.post(API+'/auth/login',data={'login':'admin@aurelune.local','password':'aurelune-admin'})
    own=b.new_context(viewport={'width':1366,'height':800})
    assert own.request.post(API+'/auth/signup',data={'username':'dd'+rid,'email':f'dd{rid}@t.test','password':'password123'}).status==201
    cr=own.request.post(API+'/studio/request',data={'name':'Dropband'+rid,'focus':'both'}).json()['creator']['id']
    adm.request.post(API+f'/admin/creators/{cr}/approve',data={})
    pg=own.new_page(); errs=[]; pg.on('pageerror',lambda e: errs.append(str(e)))
    pg.goto(BASE+'/#/studio'); pg.wait_for_selector('[data-tab="tracks"]',timeout=20000); pg.click('[data-tab="tracks"]'); pg.wait_for_selector('#upload-track')
    # a file dropped on the page (not on the studio tab) must not navigate away
    r=pg.evaluate(DROP,['.topbar','song.wav','audio/wav',W,'drop'])
    ck('a file dropped on an unrelated part of the app is cancelled (browser will not open it)', r['p'] is True, r)
    # ---- drop on the Tracks tab -> upload dialog opens with the file chosen
    r=pg.evaluate(DROP,['#tab-body','dropped-on-tab.wav','audio/wav',W,'drop'])
    pg.wait_for_selector('#tf-audio',state='attached',timeout=4000)
    ck('dropping on the Tracks tab opens the upload dialog', pg.locator('#tf-audio').count()==1)
    ck('...with the dropped file already chosen', pg.inner_text('#tf-audio-name')=='dropped-on-tab.wav', pg.inner_text('#tf-audio-name'))
    ck('...in the input itself (the form will upload it)', pg.evaluate('document.getElementById("tf-audio").files[0]?.name')=='dropped-on-tab.wav')
    pg.click('.modal [data-close]'); pg.wait_for_timeout(300)
    # ---- the dialog's drop area
    pg.click('#upload-track'); pg.wait_for_selector('#tf-audio',state='attached')
    r=pg.evaluate(DROP,['#tf-audio-drop','x.wav','audio/wav',W,'over'])
    ck('dragging over the drop area highlights it and allows the drop', r['over'] is True and r['p'] is True, r)
    r=pg.evaluate(DROP,['#tf-audio-drop','first.wav','audio/wav',W,'drop'])
    ck('dropping an audio file on the drop area chooses it', pg.inner_text('#tf-audio-name')=='first.wav' and pg.evaluate('document.getElementById("tf-audio").files.length')==1, pg.inner_text('#tf-audio-name'))
    ck('...and the highlight goes away', pg.evaluate('!document.querySelector(".file-drop").classList.contains("over")'))
    pg.evaluate(DROP,['#tf-audio-drop','notes.txt','text/plain',base64.b64encode(b'hello').decode(),'drop']); pg.wait_for_timeout(300)
    ck('a text file is refused with a message and does not replace the chosen file', pg.inner_text('#tf-audio-name')=='first.wav' and 'audio' in pg.inner_text('.toast-stack').lower(), (pg.inner_text('#tf-audio-name'),pg.inner_text('.toast-stack')))
    pg.evaluate(DROP,['#tf-title','second.wav','audio/wav',W,'drop'])
    ck('dropping anywhere on the dialog (e.g. over the Title box) works too', pg.inner_text('#tf-audio-name')=='second.wav', pg.inner_text('#tf-audio-name'))
    pg.evaluate(DROP,['#tf-audio-drop','track.flac','',W,'drop'])
    ck('a file with no MIME type but an audio extension (.flac) is accepted', pg.inner_text('#tf-audio-name')=='track.flac', pg.inner_text('#tf-audio-name'))
    # ---- finish the upload
    pg.evaluate(DROP,['#tf-audio-drop','Dropped Song.wav','audio/wav',W,'drop'])
    pg.fill('#tf-title','Dropped Song '+rid); pg.click('#tf-save')
    pg.wait_for_function('()=>!document.querySelector("#tf-save")',timeout=40000)
    pg.wait_for_selector('text=Dropped Song '+rid,timeout=15000)
    ck('the dropped file uploaded and the track is in the list', True)
    tracks=own.request.get(API+'/studio').json()['tracks']
    ck('the server has it, with the right length (~4 s)', any(t['title']=='Dropped Song '+rid and abs(t['duration_ms']-4000)<600 for t in tracks), [(t['title'],t['duration_ms']) for t in tracks])
    # ---- cover art areas take images
    pg.click('[data-tab="albums"]'); pg.wait_for_selector('#new-album',timeout=5000)
    btn=pg.locator('#new-album, #add-album, #create-album').first
    if btn.count(): 
        btn.click(); pg.wait_for_selector('#af-cover',state='attached',timeout=4000)
        PNG='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
        pg.evaluate(DROP,['#af-cover-drop','art.png','image/png',PNG,'drop'])
        ck('a picture dropped on the cover-art area is chosen', pg.inner_text('#af-cover-name')=='art.png', pg.inner_text('#af-cover-name'))
        pg.evaluate(DROP,['#af-cover-drop','song.wav','audio/wav',W,'drop']); pg.wait_for_timeout(200)
        ck('an audio file dropped there is refused', pg.inner_text('#af-cover-name')=='art.png')
    ck('no script errors', not errs, errs)
    b.close()
print(f'\n{ok} passed, {bad} failed'); raise SystemExit(1 if bad else 0)
