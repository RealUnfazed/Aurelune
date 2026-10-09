"""Offline downloads: encrypted at rest, Aurelune-only playback, 30-day licence, creator switch, sign-out wipes, offline app start.
   bash test/integration/runpf.sh test/integration/downloads.py   (FerretDB/MongoDB + the fake PostFile; see runpf.sh)"""
import json, math, random, struct, time
from playwright.sync_api import sync_playwright
BASE='http://127.0.0.1:3000'; API=BASE+'/api/v1'; FAKE='http://127.0.0.1:4010'
ok=bad=0
def ck(n,c,x=''):
    global ok,bad
    ok+=bool(c); bad+=not c; print(('PASS ' if c else 'FAIL ')+n+('' if c else ' '+str(x)))
def wav(seconds, rate=8000):
    n=int(seconds*rate); body=bytes(int(128+100*math.sin(2*math.pi*(220+(i//rate)*40)*i/rate)) for i in range(n))
    return b'RIFF'+struct.pack('<I',36+n)+b'WAVEfmt '+struct.pack('<IHHIIHH',16,1,1,rate,rate,1,8)+b'data'+struct.pack('<I',n)+body
PL='import("/js/player.js").then(m=>m.player)'
DB='''(async()=>{const d=await new Promise((res,rej)=>{const r=indexedDB.open('aurelune-downloads');r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)});
  const all=(s)=>new Promise((res)=>{const q=d.transaction(s).objectStore(s).getAll();q.onsuccess=()=>res(q.result)});
  const keys=(s)=>new Promise((res)=>{const q=d.transaction(s).objectStore(s).getAllKeys();q.onsuccess=()=>res(q.result)});
  const one=(s,k)=>new Promise((res)=>{const q=d.transaction(s).objectStore(s).get(k);q.onsuccess=()=>res(q.result)});
  return {items:await all('items'),chunkKeys:await keys('chunks'),license:await one('meta','license'),
          firstChunk:(await (async()=>{const k=(await keys('chunks'))[0];if(!k)return null;const v=await one('chunks',k);return Array.from(new Uint8Array(v).slice(0,64))})())}})()'''

with sync_playwright() as p:
    rid=str(int(time.time()))[-6:]
    anon=p.request.new_context()
    r=anon.post(API+'/downloads/license',data={'device':'d'*20}); ck('licence needs a sign-in (401)', r.status==401, r.status)
    admin=p.request.new_context(); admin.post(API+'/auth/login',data={'login':'admin@aurelune.local','password':'aurelune-admin'})
    def mkuser(u):
        c=p.request.new_context(); r=c.post(API+'/auth/signup',data={'username':u,'email':u+'@t.test','password':'password123'}); assert r.status==201, r.text(); return c
    owner=mkuser('dlown'+rid); lis=mkuser('dllis'+rid)
    cr=owner.post(API+'/studio/request',data={'name':'Dlband'+rid,'focus':'both'}).json()['creator']; admin.post(API+f'/admin/creators/{cr["id"]}/approve',data={})
    def up(title,b,extra=None):
        mp={'audio':{'name':'a.wav','mimeType':'audio/wav','buffer':b},'title':title,'storage':'postfile'}; mp.update(extra or {})
        r=owner.post(API+'/studio/tracks',multipart=mp); assert r.status==201, r.text(); return r.json()['track']
    t_ok=up('Dl Song '+rid, wav(24))
    t_off=up('Dl NoDownload '+rid, wav(10), {'downloads_allowed':'0'})
    ck('DTO: downloadable true by default / false when the creator turned it off', t_ok['downloadable'] is True and t_off['downloadable'] is False, (t_ok.get('downloadable'), t_off.get('downloadable')))
    sh=owner.post(API+'/studio/shows',multipart={'title':'Dlcast'+rid,'category':'x'}).json()['show']
    ep_bytes=wav(16*60+10)  # > 15 minutes: normally streamed, never kept in memory
    er=owner.post(API+f'/studio/shows/{sh["id"]}/episodes',multipart={'audio':{'name':'e.wav','mimeType':'audio/wav','buffer':ep_bytes},'title':'Dl Ep '+rid,'storage':'postfile'}); ck('episode uploaded', er.status==201, er.text()[:200])
    ep=er.json()['episode']
    # server-side switch: ?dl=1 is refused for a track with downloads off, streaming still works
    r=lis.get(API+t_off['stream_url'].replace('/api/v1','')+'?dl=1',max_redirects=0); ck('?dl=1 on a no-download track -> 403 downloads_disabled', r.status==403 and 'downloads_disabled' in r.text(), (r.status,r.text()[:100]))
    r=lis.get(API+t_off['stream_url'].replace('/api/v1',''),max_redirects=0); ck('the same track still streams normally', r.status in (200,206,302), r.status)
    r=lis.get(API+t_ok['stream_url'].replace('/api/v1','')+'?dl=1&proxy=1'); ck('?dl=1 on a normal track serves the whole file', r.status==200 and len(r.body())>100000, (r.status,len(r.body())))
    lic=lis.post(API+'/downloads/license',data={'device':'abcdefabcdefabcdefabcd'}).json()
    ck('licence: key + 30-day expiry', len(lic['key'])>=40 and 29.9<(time.mktime(time.strptime(lic['expires_at'][:19],'%Y-%m-%dT%H:%M:%S'))-time.time()-time.timezone)/86400<30.1 and lic['days']==30, lic)
    lic2=lis.post(API+'/downloads/license',data={'device':'abcdefabcdefabcdefabcd'}).json(); ck('licence: same device -> same key (renewing never breaks stored copies)', lic['key']==lic2['key'])
    lic3=lis.post(API+'/downloads/license',data={'device':'zzzzzzzzzzzzzzzzzzzzzz'}).json(); ck('licence: another device -> another key', lic['key']!=lic3['key'])
    lic4=owner.post(API+'/downloads/license',data={'device':'abcdefabcdefabcdefabcd'}).json(); ck('licence: another account -> another key', lic['key']!=lic4['key'])
    ck('licence: bad device id -> 400', lis.post(API+'/downloads/license',data={'device':'x'}).status==400)

    b=p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
    ctx=b.new_context(viewport={'width':1366,'height':800})
    ctx.request.post(API+'/auth/login',data={'login':'dllis'+rid+'@t.test','password':'password123'})
    pg=ctx.new_page(); errs=[]; pg.on('pageerror',lambda e:errs.append(str(e)))
    pg.goto(BASE+'/'); pg.wait_for_selector('.nav'); pg.evaluate('navigator.serviceWorker.ready.then(()=>true)'); pg.reload(); pg.wait_for_selector('.nav'); pg.wait_for_timeout(800)
    ck('service worker controls the page (app can open offline)', pg.evaluate('!!navigator.serviceWorker.controller'))
    pg.goto(BASE+f'/#/artist/{cr["slug"]}'); pg.wait_for_selector('.trow'); pg.wait_for_timeout(500)
    row=pg.locator(f'.trow[data-id="{t_ok["id"]}"]'); ck('row has a download button', row.locator('[data-dl]').count()==1)
    ck('a track with downloads off has no download button', pg.locator(f'.trow[data-id="{t_off["id"]}"] [data-dl]').count()==0)
    # play it so the bar shows, then download from the BAR button next to the heart
    pg.evaluate('(t)=>import("/js/player.js").then(m=>m.player.playQueue([t],0))',t_ok); pg.wait_for_selector('#player-bar [data-dl]'); pg.wait_for_timeout(600)
    pos=pg.evaluate('''()=>{const l=document.querySelector('#bar-like').getBoundingClientRect(),d=document.querySelector('#player-bar [data-dl]').getBoundingClientRect();return {ll:l.left,dl:d.left,same:Math.abs(l.top-d.top)<6}}''')
    ck('bar: the download button sits right next to the like button', pos['same'] and 0<pos['dl']-pos['ll']<60, pos)
    pg.click('#player-bar [data-dl]'); pg.wait_for_selector('#player-bar [data-dl].dl-done',timeout=15000)
    ck('bar button turns to "downloaded"', True); ck('the row button follows (same item)', pg.locator(f'.trow[data-id="{t_ok["id"]}"] [data-dl].dl-done').count()==1)
    d=pg.evaluate(DB)
    ck('IndexedDB: one finished item, several 1 MB pieces', len(d['items'])==1 and d['items'][0]['chunks']>=1 and len(d['chunkKeys'])==d['items'][0]['chunks'], (len(d['items']), len(d['chunkKeys'])))
    plain=pg.evaluate('(u)=>fetch(u+"?dl=1&proxy=1").then(r=>r.arrayBuffer()).then(b=>Array.from(new Uint8Array(b).slice(0,48)))',t_ok['stream_url'])
    fc=d['firstChunk'][12:60] if d['firstChunk'] else []
    ck('what is stored is NOT the audio (no RIFF/WAVE header in the stored bytes)', plain[:4]==[82,73,70,70] and bytes(d['firstChunk'] or []).find(b'RIFF')<0 and fc!=plain[:len(fc)], (plain[:6], d['firstChunk'][:20] if d['firstChunk'] else None))
    ck('stored size is the plain size + 28 bytes per piece (iv + tag)', d['items'][0]['stored']==d['items'][0]['size']+28*d['items'][0]['chunks'], d['items'][0])
    ck('licence is stored as a non-extractable CryptoKey', pg.evaluate('''(async()=>{const d=await new Promise(r=>{const q=indexedDB.open('aurelune-downloads');q.onsuccess=()=>r(q.result)});const l=await new Promise(r=>{const q=d.transaction('meta').objectStore('meta').get('license');q.onsuccess=()=>r(q.result)});return !!l&&l.key instanceof CryptoKey&&l.key.extractable===false})()'''))

    # ---- offline playback from the encrypted copy (nothing else can serve it) ----
    pg.evaluate('(l)=>import("/js/player.js").then(m=>{m.player.playQueue(l,0)})',[t_off if False else ep]); pg.wait_for_timeout(500)
    pg.evaluate(PL+'.then(p=>p.clearCache())')
    ctx.set_offline(True)
    pg.evaluate('(t)=>import("/js/player.js").then(m=>m.player.playQueue([t],0))',t_ok); pg.wait_for_timeout(1800)
    st=pg.evaluate(PL+'.then(p=>({src:p.audio.src.slice(0,5),t:p.audio.currentTime,paused:p.audio.paused,loading:p.loading,dur:p.durationSec}))')
    ck('OFFLINE: plays from a decrypted blob and the time advances', st['src']=='blob:' and st['t']>0.5 and not st['paused'] and not st['loading'], st)
    pg.evaluate(PL+'.then(p=>p.seekTo(p.durationSec*0.6))'); pg.wait_for_timeout(900)
    t=pg.evaluate(PL+'.then(p=>[p.position,p.durationSec])'); ck('OFFLINE: seeking lands where asked (%.1f of %.1f)'%tuple(t), abs(t[0]-t[1]*0.6)<2.0, t)
    pg.reload(); pg.wait_for_selector('.nav',timeout=15000); pg.wait_for_timeout(1200)
    ck('OFFLINE app start: opens, shows the Offline marker', pg.locator('.offline-pill').count()==1)
    ck('OFFLINE app start: lands on Downloads and lists the song', 'downloads' in pg.url and pg.locator(f'.trow[data-id="{t_ok["id"]}"]').count()==1, pg.url)
    pg.goto(BASE+'/#/search'); pg.wait_for_timeout(600); ck('OFFLINE: pages that need the server send you back to Downloads', 'downloads' in pg.url, pg.url)
    pg.click(f'.trow[data-id="{t_ok["id"]}"] .trow-text'); pg.wait_for_timeout(1500)
    st=pg.evaluate(PL+'.then(p=>({src:p.audio.src.slice(0,5),t:p.audio.currentTime,id:p.current&&p.current.id}))')
    ck('OFFLINE: clicking the row in Downloads plays it', st['src']=='blob:' and st['t']>0.3 and st['id']==t_ok['id'], st)

    # ---- licence runs out (30 days without a check-in) ----
    pg.evaluate('''(async()=>{const d=await new Promise(r=>{const q=indexedDB.open('aurelune-downloads');q.onsuccess=()=>r(q.result)});
      const l=await new Promise(r=>{const q=d.transaction('meta').objectStore('meta').get('license');q.onsuccess=()=>r(q.result)});
      l.expiresAt=new Date(Date.now()-1000).toISOString(); l.issuedAt=new Date(Date.now()-31*864e5).toISOString();
      await new Promise(r=>{const t=d.transaction('meta','readwrite');t.objectStore('meta').put(l,'license');t.oncomplete=r})})()''')
    pg.reload(); pg.wait_for_selector('.nav',timeout=15000); pg.wait_for_timeout(1200)
    ck('EXPIRED + offline: the song shows as locked', pg.locator(f'.trow[data-id="{t_ok["id"]}"] [data-dl].dl-locked').count()==1)
    dd=pg.evaluate(DB); ck('EXPIRED: the key was deleted from the device (pieces stay, unreadable)', dd['license'] and dd['license'].get('key') is None and len(dd['items'])==1, dd['license'])
    pg.evaluate(PL+'.then(p=>p.clearCache())')
    pg.evaluate('(t)=>import("/js/player.js").then(m=>m.player.playQueue([t],0))',t_ok); pg.wait_for_timeout(1500)
    st=pg.evaluate(PL+'.then(p=>({src:p.audio.getAttribute("src"),playing:p.isPlaying}))')
    ck('EXPIRED + offline: it does NOT play, and says why', not st['src'] and not st['playing'] and pg.locator('.toast, #toasts *',has_text='check-in').count()>=1, st)
    ctx.set_offline(False)
    pg.wait_for_timeout(3500); pg.wait_for_selector('.nav',timeout=15000)  # an app that was opened offline reloads itself when the connection returns
    ck('back ONLINE: the app reloads itself out of offline mode', pg.locator('.offline-pill').count()==0)
    pg.goto(BASE+f'/#/artist/{cr["slug"]}'); pg.wait_for_selector('.trow'); pg.wait_for_timeout(500)
    ck('back ONLINE: the app checks in by itself and the song is playable again', pg.locator(f'.trow[data-id="{t_ok["id"]}"] [data-dl].dl-done').count()==1)
    dd=pg.evaluate(DB); ck('back ONLINE: the licence is renewed for ~30 days', dd['license']['key'] is not None and (time.mktime(time.strptime(dd['license']['expiresAt'][:19],'%Y-%m-%dT%H:%M:%S'))-time.time()-time.timezone)/86400>29, dd['license'] and dd['license'].get('expiresAt'))

    # ---- podcast episode over 15 minutes: stored, then played from memory offline ----
    pg.goto(BASE+f'/#/show/{sh["id"]}'); pg.wait_for_selector('.erow'); pg.wait_for_timeout(400)
    pg.click(f'.erow[data-id="{ep["id"]}"] [data-dl]'); pg.wait_for_selector(f'.erow[data-id="{ep["id"]}"] [data-dl].dl-done',timeout=30000)
    d=pg.evaluate(DB); rec=[i for i in d['items'] if i['type']=='episode']
    ck('episode: stored encrypted (%d pieces, %.1f MB)'%(rec[0]['chunks'],rec[0]['size']/1048576), rec and rec[0]['size']==len(ep_bytes) and rec[0]['chunks']>=7, rec and rec[0]['size'])
    ctx.set_offline(True)
    pg.evaluate('(e)=>import("/js/player.js").then(m=>m.player.playQueue([e],0))',ep); pg.wait_for_timeout(2500)
    st=pg.evaluate(PL+'.then(p=>({src:p.audio.src.slice(0,5),t:p.audio.currentTime,dur:p.durationSec}))')
    ck('OFFLINE episode plays from the decrypted copy (long episodes normally stream)', st['src']=='blob:' and st['t']>0.5 and st['dur']>900, st)
    pg.evaluate(PL+'.then(p=>p.seekTo(500))'); pg.wait_for_timeout(900); t=pg.evaluate(PL+'.then(p=>p.position)'); ck('OFFLINE episode: seek to 500 s lands at %.1f'%t, abs(t-500)<2.5, t)
    ctx.set_offline(False)

    # ---- remove, cancel, sign-out wipe ----
    pg.goto(BASE+f'/#/show/{sh["id"]}'); pg.wait_for_selector('.erow'); pg.wait_for_timeout(400)
    pg.click(f'.erow[data-id="{ep["id"]}"] [data-dl]'); pg.wait_for_timeout(500)
    d=pg.evaluate(DB); ck('tap the downloaded button again: the episode and its pieces are removed', not [i for i in d['items'] if i['type']=='episode'] and not [k for k in d['chunkKeys'] if str(k).startswith('episode:')], (len(d['items']), len(d['chunkKeys'])))
    # cancel mid-download (slow CDN)
    p_=p.request.new_context(); p_.post(FAKE+'/_ctl',data={'slowKBps':40,'cors':True})
    t_slow=up('Dl Slow '+rid, wav(40))
    pg.goto(BASE+f'/#/artist/{cr["slug"]}'); pg.wait_for_selector('.trow'); pg.wait_for_timeout(500)
    pg.click(f'.trow[data-id="{t_slow["id"]}"] [data-dl]'); pg.wait_for_selector(f'.trow[data-id="{t_slow["id"]}"] [data-dl].dl-downloading',timeout=6000); pg.wait_for_timeout(600)
    ck('while downloading the button shows a progress ring', pg.locator(f'.trow[data-id="{t_slow["id"]}"] .dl-ring').count()==1)
    pg.click(f'.trow[data-id="{t_slow["id"]}"] [data-dl]'); pg.wait_for_timeout(900)
    d=pg.evaluate(DB); ck('cancelling leaves nothing behind (no item, no stray pieces)', not [i for i in d['items'] if i['id']==t_slow['id']] and not [k for k in d['chunkKeys'] if str(k).startswith('track:'+t_slow['id'])], d['chunkKeys'][:3])
    p_.post(FAKE+'/_ctl',data={'slowKBps':0})
    # CDN answers without Content-Length (like the real one): still downloads, size verified by what arrived
    p_.post(FAKE+'/_ctl',data={'noLength':True})
    pg.click(f'.trow[data-id="{t_slow["id"]}"] [data-dl]'); pg.wait_for_selector(f'.trow[data-id="{t_slow["id"]}"] [data-dl].dl-done',timeout=20000)
    d=pg.evaluate(DB); it=[i for i in d['items'] if i['id']==t_slow['id']]; ck('no Content-Length from the host: still stored in full', it and it[0]['size']>=len(wav(40))-100, it and it[0]['size'])
    p_.post(FAKE+'/_ctl',data={'noLength':False,'cors':False})
    # password change on the account rotates the key: the next check-in removes copies that can no longer open
    pg.evaluate('''(async()=>{const m=await import("/js/downloads.js");await m.downloads.checkIn({force:true})})()'''); pg.wait_for_timeout(300)
    d0=pg.evaluate(DB); ck('before the password change: 2 downloads', len(d0['items'])==2, len(d0['items']))
    r=ctx.request.put(API+'/me/password',data={'current':'password123','next':'password456'}); ck('password changed', r.status==200, r.status)
    pg.evaluate('''(async()=>{const m=await import("/js/downloads.js");await m.downloads.checkIn({force:true})})()'''); pg.wait_for_timeout(600)
    d1=pg.evaluate(DB); ck('after it: copies made under the old key are removed at the next check-in', len(d1['items'])==0 and len(d1['chunkKeys'])==0, (len(d1['items']), len(d1['chunkKeys'])))
    # sign out wipes everything
    pg.goto(BASE+f'/#/artist/{cr["slug"]}'); pg.wait_for_selector('.trow'); pg.wait_for_timeout(400)
    pg.click(f'.trow[data-id="{t_ok["id"]}"] [data-dl]'); pg.wait_for_selector(f'.trow[data-id="{t_ok["id"]}"] [data-dl].dl-done',timeout=15000)
    pg.click('#avatar-btn'); pg.click('#menu-logout'); pg.wait_for_selector('.auth-screen',timeout=10000); pg.wait_for_timeout(500)
    d=pg.evaluate(DB); ck('SIGN OUT: every download and the key are gone from the device', len(d['items'])==0 and len(d['chunkKeys'])==0 and d['license'] is None, (len(d['items']), d['license']))
    ck('no uncaught page errors', not errs, errs[:3])
    b.close()
print(f'\n{ok} passed, {bad} failed'); raise SystemExit(1 if bad else 0)
