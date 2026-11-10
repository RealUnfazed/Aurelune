"""Search loading: the shimmer is visible on cards, the placeholder is shaped like the results, results are not wiped on each keystroke.
   bash test/integration/runpf.sh test/integration/search_shimmer.py   (or any server on :3000 with the demo seed)"""
import io, time
from PIL import Image
from playwright.sync_api import sync_playwright
BASE='http://127.0.0.1:3000'; API=BASE+'/api/v1'
ok=bad=0
def ck(n,c,x=''):
    global ok,bad
    ok+=bool(c); bad+=not c; print(('PASS ' if c else 'FAIL ')+n+('' if c else ' '+str(x)))
def lum(px): return (px[0]*299+px[1]*587+px[2]*114)/1000

with sync_playwright() as p:
    b=p.chromium.launch(); ctx=b.new_context(viewport={'width':1280,'height':800}, service_workers='block')
    ctx.request.post(API+'/auth/login',data={'login':'admin@aurelune.local','password':'aurelune-admin'})
    pg=ctx.new_page(); errs=[]; pg.on('pageerror',lambda e:errs.append(str(e)))
    # delay / fail /search INSIDE the page (a blocking route handler would freeze the test's own event loop)
    pg.add_init_script("""(()=>{const f=window.fetch.bind(window); window.__d=2500; window.__slowQ=null; window.__fail=false;
      window.fetch=async (u,o)=>{const url=String(u?.url||u); if(url.includes('/api/v1/search')){ const slow=window.__slowQ&&url.includes(window.__slowQ);
        await new Promise(r=>setTimeout(r, slow?2000:window.__d)); if(window.__fail) throw new TypeError('Failed to fetch'); } return f(u,o)}})()""")
    class D:
        def __setitem__(self,k,v): pg.evaluate(f'window.__d={v}')
    delay=D()
    pg.goto(BASE+'/#/search'); pg.wait_for_selector('#search-input'); pg.wait_for_timeout(500)

    # ---- 1. first search: placeholder shaped like the results ----
    pg.fill('#search-input','night'); pg.wait_for_timeout(900)
    n_rows=pg.evaluate('document.querySelectorAll("#search-results .sk-trow").length'); n_cards=pg.evaluate('document.querySelectorAll("#search-results .card .skeleton.art-wrap").length')
    heads=pg.evaluate('document.querySelectorAll("#search-results .section-head .skeleton").length')
    ck('placeholder has a Songs heading, 5 track rows and a shelf of cards', heads>=1 and n_rows==5 and n_cards>=4, (heads,n_rows,n_cards))
    # ---- 2. the shimmer is actually visible on a card (base tone differs from the card) ----
    frozen=pg.add_style_tag(content='.skeleton{animation:none!important;background-position:0 0!important}')   # freeze at the left, outside the bright band
    pg.wait_for_timeout(200)
    box=pg.evaluate('''(()=>{const c=document.querySelector("#search-results .card"),l=c.querySelectorAll(".skeleton")[1].getBoundingClientRect(),cr=c.getBoundingClientRect(),a=c.querySelector(".art-wrap").getBoundingClientRect();
      return {line:[l.left+3,l.top+l.height/2],card:[cr.left+4,cr.top+cr.height-4],art:[a.left+10,a.top+10]}})()''')
    im=Image.open(io.BytesIO(pg.screenshot())).convert('RGB')
    line=im.getpixel(tuple(int(v) for v in box['line'])); card=im.getpixel(tuple(int(v) for v in box['card'])); art=im.getpixel(tuple(int(v) for v in box['art']))
    ck(f'text bars on a card are clearly lighter than the card itself ({lum(line):.0f} vs {lum(card):.0f})', lum(line)-lum(card)>=12, (line,card))
    ck(f'the cover tile is shimmer-coloured, not a flat grey ({art})', art!=(40,40,40) and lum(art)-lum(card)>=12, art)
    # the bright band moves: sample the tile at two moments with animation on
    frozen.evaluate('e=>e.remove()')   # animation back on
    pg.wait_for_timeout(100)
    def tile_px():
        r=pg.evaluate('(()=>{const a=document.querySelector("#search-results .card .art-wrap").getBoundingClientRect();return [a.left+a.width/2,a.top+a.height/2]})()')
        return Image.open(io.BytesIO(pg.screenshot())).convert('RGB').getpixel((int(r[0]),int(r[1])))
    seen={tile_px() for _ in range(6) if not pg.wait_for_timeout(180)}
    ck('the shimmer band really sweeps (tile colour changes over time)', len(seen)>=3, seen)
    pg.wait_for_timeout(3500)
    ck('results arrive and replace the placeholder', pg.query_selector('#search-results .skeleton') is None and pg.query_selector('#search-results .trow') is not None)
    ck('...and the results are not dimmed any more', 'busy' not in (pg.get_attribute('#search-results','class') or ''))

    # ---- 3. typing again keeps the old results (dimmed), no shimmer wipe ----
    delay['ms']=1800
    pg.fill('#search-input','nightb'); pg.wait_for_timeout(900)
    st=pg.evaluate('({rows:document.querySelectorAll("#search-results .trow").length, sk:document.querySelectorAll("#search-results .skeleton").length, busy:document.getElementById("search-results").classList.contains("busy"), op:getComputedStyle(document.getElementById("search-results")).opacity})')
    ck('while the next results load, the old ones stay on screen (no placeholder)', st['rows']>0 and st['sk']==0, st)
    ck('...dimmed, so it is clear they are updating', st['busy'] and float(st['op'])<0.8, st)
    pg.wait_for_timeout(2500)
    ck('new results replace them and the dimming is gone', pg.evaluate('!document.getElementById("search-results").classList.contains("busy")') and pg.query_selector('#search-results .skeleton') is None)

    # ---- 4. a fast answer never flashes a placeholder ----
    delay['ms']=20
    pg.evaluate('window.__sk=0; new MutationObserver(m=>{for(const x of m)for(const n of x.addedNodes)if(n.nodeType===1&&(n.matches?.(".skeleton")||n.querySelector?.(".skeleton")))window.__sk++}).observe(document.getElementById("search-results"),{childList:true,subtree:true})')
    pg.fill('#search-input',''); pg.wait_for_timeout(700)
    pg.fill('#search-input','sea'); pg.wait_for_timeout(1200)
    ck('fast answer: no placeholder flashed', pg.evaluate('window.__sk')==0, pg.evaluate('window.__sk'))
    ck('fast answer: results shown', pg.query_selector('#search-results .trow, #search-results .card') is not None)

    # ---- 5. stale answers never overwrite newer ones ----
    pg.evaluate('window.__d=20; window.__slowQ="q=zzz"')
    pg.fill('#search-input','zzz'); pg.wait_for_timeout(500)       # slow, no such thing
    pg.fill('#search-input','night'); pg.wait_for_timeout(3200)    # fast, real results
    ck('a slow older search does not overwrite the newer one', pg.query_selector('#search-results .trow') is not None and 'No results' not in pg.inner_text('#search-results'), pg.inner_text('#search-results')[:60])

    # ---- 6. failure: a clear message, never an endless shimmer ----
    pg.evaluate('window.__slowQ=null; window.__fail=true')
    pg.fill('#search-input','failing'); pg.wait_for_timeout(1500)
    ck('failed search: message shown, no shimmer left, not dimmed', "didn't load" in pg.inner_text('#search-results') and pg.query_selector('#search-results .skeleton') is None and 'busy' not in (pg.get_attribute('#search-results','class') or ''), pg.inner_text('#search-results')[:80])
    ck('no page errors', not errs, errs)
    b.close()
print(f'\n{ok} passed, {bad} failed'); raise SystemExit(1 if bad else 0)
