"""Interface scale (Settings -> Appearance): the app fills the window, nothing overflows, the layout switches like browser zoom,
   menus / seek tip / sidebar drag land under the pointer, and the choice is remembered. Also checks the larger icon sizes.
   bash test/integration/runpf.sh test/integration/scale.py"""
from playwright.sync_api import sync_playwright
BASE='http://127.0.0.1:3000'; API=BASE+'/api/v1'
ok=bad=0
def ck(n,c,x=''):
    global ok,bad
    ok+=bool(c); bad+=not c; print(('PASS ' if c else 'FAIL ')+n+('' if c else ' '+str(x)))
with sync_playwright() as p:
    b=p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
    ctx=b.new_context(viewport={'width':1280,'height':800}); ctx.request.post(API+'/auth/login',data={'login':'admin@aurelune.local','password':'aurelune-admin'})
    tr=ctx.request.get(API+'/home').json()['trending'][:3]
    pg=ctx.new_page(); errs=[]; pg.on('pageerror',lambda e:errs.append(str(e)))
    pg.goto(BASE+'/#/album/'+tr[0]['album']['id']); pg.wait_for_selector('.trow'); pg.wait_for_timeout(500)
    pg.evaluate('(l)=>import("/js/player.js").then(m=>m.player.playQueue(l,0))',tr); pg.wait_for_selector('#player-bar #bar-like'); pg.wait_for_timeout(500)
    ck('default: no zoom applied at all', pg.evaluate("document.documentElement.style.zoom===''") and not pg.evaluate("document.documentElement.classList.contains('scaled')"))
    def measure():
        return pg.evaluate('''()=>{const r=s=>{const e=document.querySelector(s);if(!e)return null;const b=e.getBoundingClientRect();return {l:b.left,r:b.right,t:b.top,b:b.bottom,w:b.width,h:b.height,vis:getComputedStyle(e).display!=='none'}};
          const de=document.documentElement;return {iw:innerWidth,ih:innerHeight,sw:de.scrollWidth,sh:de.scrollHeight,app:r('#app'),bar:r('#player-bar'),nav:r('.nav'),tab:r('#mobile-tabbar'),like:r('#bar-like'),icon:r('#bar-like svg'),
                  content:r('.content'),scale:getComputedStyle(de).getPropertyValue('--ui-scale')}}''')
    for vw,vh in ((1280,800),(900,700)):
        pg.set_viewport_size({'width':vw,'height':vh}); pg.wait_for_timeout(300)
        for sc in (75,100,125,150,200):
            pg.evaluate(f'import("/js/store.js").then(m=>m.applyScale({sc}))'); pg.wait_for_timeout(500)
            m=measure(); z=sc/100; tag=f'{vw}px @{sc}%'
            ck(f'{tag}: nothing overflows the window', m['sw']<=m['iw']+1 and m['sh']<=m['ih']+1, (m['sw'],m['iw'],m['sh'],m['ih']))
            ck(f'{tag}: the app fills the window exactly', abs(m['app']['w']-m['iw'])<=1.5 and abs(m['app']['h']-m['ih'])<=1.5, m['app'])
            phone=vw/z<=720
            if phone: ck(f'{tag}: tab bar sits at the bottom edge, player bar right above it', m['tab'] and m['ih']-m['tab']['b']<=2 and m['bar']['b']<=m['tab']['t']+1, (m['tab'],m['bar'],m['ih']))
            else: ck(f'{tag}: player bar sits at the bottom edge', m['bar'] and m['ih']-m['bar']['b']<=10*z+2 and m['bar']['b']<=m['ih']+1, (m['bar'],m['ih']))
            ck(f'{tag}: layout is {"phone" if phone else "desktop/tablet"} (effective width {vw/z:.0f}px)', (m['tab'] and m['tab']['vis'])==phone and (not m['nav'] or m['nav']['vis'])!=phone, (m['tab'],m['nav']))
            ck(f'{tag}: icons scale with it', abs(m['icon']['w']-20*z)<=1.5, m['icon'])
            if sc in (75,150,200):
                pg.screenshot(path=f'/tmp/pw/scale_{vw}_{sc}.png')
    pg.set_viewport_size({'width':1280,'height':1100}); pg.evaluate('import("/js/store.js").then(m=>m.applyScale(150))'); pg.wait_for_timeout(500)
    # menus, tooltips and the sidebar handle must land under the pointer, not off by the scale factor
    row=pg.locator('.trow').nth(1).bounding_box(); x,y=row['x']+300,row['y']+20
    pg.mouse.click(x,y,button='right'); pg.wait_for_selector('.ctx-menu'); cm=pg.evaluate("(()=>{const r=document.querySelector('.ctx-menu').getBoundingClientRect();return [r.left,r.top,r.right,r.bottom,innerWidth,innerHeight]})()")
    ck('@150%%: right-click menu opens at the pointer (%.0f,%.0f vs %d,%d)'%(cm[0],cm[1],x,y), abs(cm[0]-x)<=3 and (abs(cm[1]-y)<=3 or cm[1]<=y<=cm[3]) and cm[2]<=cm[4] and cm[3]<=cm[5] and cm[1]>=0, cm)
    pg.keyboard.press('Escape')
    bar=pg.locator('#p-bar').bounding_box(); pg.mouse.move(bar['x']+bar['width']*0.5,bar['y']+bar['height']/2); pg.wait_for_timeout(300)
    tip=pg.evaluate("(()=>{const e=document.querySelector('.seek-tip.show');if(!e)return null;const r=e.getBoundingClientRect();return {cx:(r.left+r.right)/2,b:r.bottom}})()")
    ck('@150%: seek-time tip is centred on the pointer', tip and abs(tip['cx']-(bar['x']+bar['width']*0.5))<=4 and tip['b']<=bar['y']+2, (tip,bar))
    pg.evaluate('import("/js/store.js").then(m=>m.applyScale(125))'); pg.wait_for_timeout(500)  # 1280/1.25 = 1024: the sidebar is full width here (at 150% it collapses to icons)
    nav0=pg.evaluate("(()=>{const n=document.querySelector('.nav').getBoundingClientRect();return n.width})()"); h=pg.locator('#nav-resize').bounding_box()
    pg.mouse.move(h['x']+2,h['y']+200); pg.mouse.down(); pg.mouse.move(h['x']+2+60,h['y']+200,steps=5); pg.mouse.up(); pg.wait_for_timeout(200)
    nav1=pg.evaluate("document.querySelector('.nav').getBoundingClientRect().width"); navL=pg.evaluate("document.querySelector('.nav').getBoundingClientRect().left")
    ck('@125%%: dragging the sidebar edge: its edge ends under the pointer (%.0f vs %.0f)'%(navL+nav1,h['x']+62), abs((navL+nav1)-(h['x']+62))<=3 and nav1>nav0+40, (nav0,nav1,h))
    # the setting: chips, persistence, reset
    pg.evaluate('import("/js/store.js").then(m=>m.applyScale(100))'); pg.goto(BASE+'/#/settings/appearance'); pg.wait_for_selector('#s-scale'); pg.wait_for_timeout(400)
    ck('settings: 9 scale choices, 100% selected', pg.locator('.scale-chip').count()==9 and pg.locator('.scale-chip.on').inner_text()=='100%')
    pg.click('.scale-chip[data-scale="125"]'); pg.wait_for_timeout(500)
    ck('choosing 125%: applied at once, remembered, chip selected', pg.evaluate("document.documentElement.style.zoom")=='1.25' and pg.evaluate("localStorage.getItem('aur_scale')")=='125' and pg.locator('.scale-chip.on').inner_text()=='125%')
    ck('the chips themselves stay inside the window', pg.evaluate("(()=>{const r=document.querySelector('#s-scale').getBoundingClientRect();return r.right<=innerWidth})()"))
    pg.reload(); pg.wait_for_selector('.nav'); ck('after a reload it is still 125%', pg.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--ui-scale').trim()")=='1.25' and pg.evaluate("document.documentElement.style.zoom")=='1.25')
    pg.goto(BASE+'/#/settings/appearance'); pg.wait_for_selector('#s-scale-reset'); pg.click('#s-scale-reset'); pg.wait_for_timeout(400)
    ck('reset: zoom removed and nothing stored', pg.evaluate("document.documentElement.style.zoom")=='' and pg.evaluate("localStorage.getItem('aur_scale')") is None)
    # phone-sized window at 100%: the compact layout still works and the larger icons fit
    pg.set_viewport_size({'width':390,'height':780}); pg.goto(BASE+'/'); pg.wait_for_selector('.mobile-tabbar'); pg.wait_for_timeout(600)
    m=measure(); ck('phone 390px: tab bar visible, no overflow', m['tab'] and m['tab']['vis'] and m['sw']<=m['iw']+1, (m['tab'],m['sw']))
    pg.screenshot(path='/tmp/pw/scale_phone.png')
    ck('no uncaught page errors', not errs, errs[:3])
    b.close()
print(f'\n{ok} passed, {bad} failed'); raise SystemExit(1 if bad else 0)
